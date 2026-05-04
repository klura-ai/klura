import { pool } from '../runtime-state';
import { wrapAgentExpression } from '../response/js-eval-wrapper';
import { recordObservedCapability as recordObservedCapabilityLogbook } from '../working-dir/logbook';
import {
  ensureAccumulator,
  ringPush,
  readArtifactFromDisk,
  RESUME_POINTER_KINDS,
  DISCOVERY_NOTE_KINDS,
  VERIFIED_EXPR_RETURNS,
  MAX_NOTE_LEN,
  MAX_REF_LEN,
  MAX_DISCOVERY_NOTE_BODY,
  MAX_VERIFIED_EXPR_LEN,
  MAX_VERIFIED_EXPRESSIONS,
  type DiscoveryArtifact,
  type ResumePointerKind,
  type DiscoveryNoteKind,
} from '../strategies/discovery-artifact';
import { asEnum, ValidationError } from '../validators';

export interface AddResumePointerArgs {
  session_id: string;
  capability: string;
  kind: ResumePointerKind;
  ref: string;
  line?: number;
  note?: string;
}

/**
 * Agent-initiated forward-looking pointer. Appends a typed reference (js_source
 * URL+line, request_index, frame_index, page_url, other) to the session's
 * artifact accumulator, scoped to the named capability so end_drive knows
 * which artifact to persist it on even when no `save_strategy` succeeded during
 * this session.
 */
export function addResumePointer(args: AddResumePointerArgs): { ok: true } {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.capability !== 'string' || args.capability.length === 0) {
    throw new Error('capability is required (the capability slug this pointer applies to)');
  }
  if (!RESUME_POINTER_KINDS.includes(args.kind)) {
    try {
      asEnum(args.kind, 'kind', RESUME_POINTER_KINDS);
    } catch (e) {
      if (e instanceof ValidationError) {
        throw new Error(`invalid_resume_pointer: ${e.message}`, { cause: e });
      }
      throw e;
    }
  }
  const ref = typeof args.ref === 'string' ? args.ref : '';
  if (ref.length === 0 || ref.length > MAX_REF_LEN) {
    throw new Error(`ref must be a non-empty string ≤ ${MAX_REF_LEN} chars`);
  }
  if (args.line !== undefined) {
    if (args.kind !== 'js_source') {
      throw new Error(`line is only valid when kind === "js_source" (got ${args.kind})`);
    }
    if (!Number.isInteger(args.line) || args.line <= 0) {
      throw new Error('line must be a positive integer');
    }
  }
  if (args.note !== undefined && typeof args.note !== 'string') {
    throw new Error('note must be a string');
  }
  if (args.note !== undefined && args.note.length > MAX_NOTE_LEN) {
    throw new Error(`note must be ≤ ${MAX_NOTE_LEN} chars`);
  }
  const session = pool.getSession(args.session_id);
  const acc = ensureAccumulator(session);
  const bucket = acc.agentResumePointers[args.capability] ?? [];
  acc.agentResumePointers[args.capability] = bucket;
  ringPush(bucket, {
    kind: args.kind,
    ref,
    line: args.line,
    note: args.note,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

export interface AddDiscoveryNoteArgs {
  session_id: string;
  capability: string;
  kind: string;
  body: string;
  verified?: boolean;
}

/**
 * Drop a typed, prose-length hint for the next session's agent to read from the
 * discovery artifact. Unlike `add_resume_pointer` (pointers to bytes), notes
 * carry reasoning: function hints, module paths, field rotation rules,
 * byte-layout observations, verified-expression summaries, open questions. The
 * `kind` is descriptive, not prescriptive — agents categorize their own hints.
 */
export function addDiscoveryNote(args: AddDiscoveryNoteArgs): { ok: true } {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.capability !== 'string' || args.capability.length === 0) {
    throw new Error('capability is required');
  }
  if (
    typeof args.kind !== 'string' ||
    !DISCOVERY_NOTE_KINDS.includes(args.kind as DiscoveryNoteKind)
  ) {
    try {
      asEnum(args.kind, 'kind', DISCOVERY_NOTE_KINDS);
    } catch (e) {
      if (e instanceof ValidationError) {
        throw new Error(`invalid_discovery_note: ${e.message}`, { cause: e });
      }
      throw e;
    }
  }
  if (typeof args.body !== 'string' || args.body.length === 0) {
    throw new Error('body is required (non-empty string)');
  }
  if (args.body.length > MAX_DISCOVERY_NOTE_BODY) {
    throw new Error(`body must be ≤ ${MAX_DISCOVERY_NOTE_BODY} chars`);
  }
  const session = pool.getSession(args.session_id);
  const acc = ensureAccumulator(session);
  const bucket = acc.notes[args.capability] ?? [];
  acc.notes[args.capability] = bucket;
  ringPush(bucket, {
    kind: args.kind,
    body: args.body,
    at: new Date().toISOString(),
    ...(args.verified !== undefined ? { verified: args.verified } : {}),
  });
  return { ok: true };
}

export interface RecordObservedCapabilityArgs {
  platform: string;
  name: string;
  evidence: { source: string; [k: string]: unknown };
  why_not_lifted: string;
  hypothesis?: string;
  session_id?: string;
}

/**
 * Record a companion capability the agent observed during discovery but didn't
 * lift to its own saved strategy. The pointer persists on the platform logbook
 * (`observed_capabilities[]`) and is surfaced by `list_platform_skills` so the next
 * session sees the candidate. Dedup-by-name: re-observing the same capability
 * updates `last_observed_at` and bumps `observed_in_sessions` once per session.
 */
export function recordObservedCapability(args: RecordObservedCapabilityArgs): { ok: true } {
  const input: import('../working-dir/logbook').ObservedCapabilityInput = {
    name: args.name,
    evidence: args.evidence,
    why_not_lifted: args.why_not_lifted,
  };
  if (args.hypothesis !== undefined) input.hypothesis = args.hypothesis;
  if (args.session_id !== undefined) input.session_id = args.session_id;
  recordObservedCapabilityLogbook(args.platform, input);
  return { ok: true };
}

export interface SaveVerifiedExpressionArgs {
  session_id: string;
  capability: string;
  expression: string;
  binds_args: string[];
  returns: 'hex' | 'base64' | 'string' | 'object';
  sample_byte_length?: number;
  notes?: string;
}

/**
 * Persist an expression the agent has verified works this session. The runtime
 * evaluates the expression once via driver.evaluateExpression to confirm it
 * doesn't throw and its return type matches the declared `returns` shape; only
 * then is it persisted. Next session reads these from the discovery artifact
 * and can try them first before re-deriving.
 */
export async function saveVerifiedExpression(
  args: SaveVerifiedExpressionArgs,
): Promise<{ ok: true; tested_byte_length?: number }> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.capability !== 'string' || args.capability.length === 0) {
    throw new Error('capability is required');
  }
  if (typeof args.expression !== 'string' || args.expression.length === 0) {
    throw new Error('expression is required (non-empty string)');
  }
  if (args.expression.length > MAX_VERIFIED_EXPR_LEN) {
    throw new Error(`expression must be ≤ ${MAX_VERIFIED_EXPR_LEN} chars`);
  }
  if (!Array.isArray(args.binds_args)) {
    throw new Error('binds_args must be an array of declared-arg slug names');
  }
  if (!VERIFIED_EXPR_RETURNS.includes(args.returns)) {
    try {
      asEnum(args.returns, 'returns', VERIFIED_EXPR_RETURNS);
    } catch (e) {
      if (e instanceof ValidationError) {
        throw new Error(`invalid_verified_expression: ${e.message}`, { cause: e });
      }
      throw e;
    }
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  // Run the expression once to confirm it doesn't throw. We don't diff bytes
  // here (the agent has try_generator_in_page for that) — we just need "it's a
  // valid, non-throwing expression" before persisting.
  const wrapped = wrapAgentExpression(args.expression);
  let result: unknown;
  try {
    result = await driver.evaluateExpression(session, wrapped, { timeoutMs: 5000 });
  } catch (e) {
    // Verification failure here is a hard signal that the saved strategy (or
    // candidate expression) doesn't actually work. Observed failure mode: agent
    // saves a strategy that turns out to be broken, calls
    // save_verified_expression last as a formality, sees the verify throw, and
    // rationalizes (e.g. "page context changed"). The save on disk stays.
    // Surface the stakes so the agent doesn't walk away from a known-broken
    // save.
    throw new Error(
      `expression threw during save-time verification: ${e instanceof Error ? e.message : String(e)}. ` +
        `This means the expression does NOT work end-to-end. If you just saved a strategy whose execute path ` +
        `relies on this expression (js-eval prereq or the main endpoint), that saved strategy is broken — ` +
        `it will fail at warm execute. Either (a) re-open the session and fix the root cause (signed endpoint ` +
        `missing its signer, wrong response-body assumption, etc.) then re-save, OR (b) leave the save but add ` +
        `a discovery note via add_discovery_note({kind:"open_question", body:"<what failed>"}) so the next ` +
        `session knows to re-validate before trusting the strategy.`,
      { cause: e },
    );
  }
  let tested_byte_length: number | undefined;
  if (args.returns === 'hex' || args.returns === 'base64') {
    if (typeof result !== 'string') {
      throw new Error(
        `returns:"${args.returns}" expects a string, but expression returned ${typeof result}`,
      );
    }
    try {
      const bytes = Buffer.from(result, args.returns === 'base64' ? 'base64' : 'hex');
      tested_byte_length = bytes.length;
    } catch (e) {
      throw new Error(
        `returns:"${args.returns}" decode failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }
  const acc = ensureAccumulator(session);
  const bucket = acc.verifiedExpressions[args.capability] ?? [];
  acc.verifiedExpressions[args.capability] = bucket;
  const entry: {
    expression: string;
    binds_args: string[];
    returns: 'hex' | 'base64' | 'string' | 'object';
    sample_byte_length?: number;
    notes?: string;
    tested_at: string;
  } = {
    expression: args.expression,
    binds_args: args.binds_args,
    returns: args.returns,
    tested_at: new Date().toISOString(),
  };
  if (tested_byte_length !== undefined) {
    entry.sample_byte_length = tested_byte_length;
  } else if (args.sample_byte_length !== undefined) {
    entry.sample_byte_length = args.sample_byte_length;
  }
  if (args.notes !== undefined) entry.notes = args.notes;
  bucket.push(entry);
  // Trim to cap (most recent wins).
  if (bucket.length > MAX_VERIFIED_EXPRESSIONS) {
    bucket.splice(0, bucket.length - MAX_VERIFIED_EXPRESSIONS);
  }
  return tested_byte_length !== undefined ? { ok: true, tested_byte_length } : { ok: true };
}

export interface GetDiscoveryArtifactFieldArgs {
  platform: string;
  capability: string;
  field: 'tool_call_trace' | 'observations' | 'resume_pointers' | 'recommended_next_steps';
}

/**
 * Fetch one named field from the on-disk discovery artifact when `list_platform_skills`
 * / `start_session` / `execute` elided it with an `_elided_fields` marker.
 * Mirrors `get_network_log {full: true}`: default responses stay inside the MCP
 * budget, agent opts into detail on demand.
 */
export function getDiscoveryArtifactField(args: GetDiscoveryArtifactFieldArgs): {
  field: GetDiscoveryArtifactFieldArgs['field'];
  value: unknown;
} {
  if (!args.platform || !args.capability) {
    throw new Error('platform, capability, and field are required');
  }
  const artifact: DiscoveryArtifact | null = readArtifactFromDisk(args.platform, args.capability);
  if (!artifact) {
    throw new Error(`no discovery artifact on disk for ${args.platform}:${args.capability}`);
  }
  const value = (artifact as unknown as Record<string, unknown>)[args.field];
  return { field: args.field, value: value ?? null };
}
