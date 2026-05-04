// Cross-run discovery handoff — read/write/merge/validate a per-capability
// artifact that preserves what prior sessions learned so the next session can
// resume without re-discovering from zero.
//
// The artifact is protocol-neutral by construction. The runtime records WHICH
// tool calls the agent made (tool name, args hash, outcome flag) and WHICH
// pointers the agent identified (js_source url+line, request_index,
// frame_index, page_url). The runtime never classifies what the agent was
// looking at — that's the heuristic-free boundary.
//
// On-disk layout per capability:
//   <KLURA_HOME>/workdir/<platform>/artifacts/<capability>.json  — structured
//   <KLURA_HOME>/workdir/<platform>/artifacts/<capability>.bin   — optional bytes
//
// Lives under `workdir/` (separate from `skills/`) so discovery scratch — which
// can contain PII from captured traffic — never ships when a skill folder is
// copy-pasted or published to ClawHub.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ArtifactAccumulator, Session } from '../drivers/types/session';
import {
  asArray,
  asBoundedString,
  asEnum,
  asNonEmptyString,
  asObject,
  asPositiveInt,
  asIdentifierSlug,
  asUrl,
  ValidationError,
} from '../validators';
import { artifactsDir } from '../working-dir/layout';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const RESUME_POINTER_KINDS = [
  'js_source',
  'request_index',
  'frame_index',
  'page_url',
  'other',
] as const;
export type ResumePointerKind = (typeof RESUME_POINTER_KINDS)[number];

export const TOOL_CALL_TRACE_TOOLS = [
  'inspect_ws_frame',
  'try_generator',
  'get_js_source',
  'get_send_encoder',
  'find_in_page',
  'get_network_log',
  'get_attribute',
  'other',
] as const;
export type ToolCallTraceTool = (typeof TOOL_CALL_TRACE_TOOLS)[number];

export interface ResumePointer {
  kind: ResumePointerKind;
  ref: string;
  line?: number;
  note?: string;
  at: string;
}

export interface ToolCallTraceEntry {
  tool: ToolCallTraceTool;
  args_digest: string;
  outcome: 'ok' | 'failed' | 'partial';
  at: string;
}

export const DISCOVERY_NOTE_KINDS = [
  'function_hint',
  'module_path',
  'field_rotation',
  'byte_layout',
  'verified_expression',
  'open_question',
  'user_declined_send',
  'other',
] as const;
export type DiscoveryNoteKind = (typeof DISCOVERY_NOTE_KINDS)[number];

export interface DiscoveryNote {
  kind: DiscoveryNoteKind;
  body: string;
  at: string;
  verified?: boolean;
}

export const VERIFIED_EXPR_RETURNS = ['hex', 'base64', 'string', 'object'] as const;
export type VerifiedExprReturns = (typeof VERIFIED_EXPR_RETURNS)[number];

export interface VerifiedExpression {
  expression: string;
  binds_args: string[];
  returns: VerifiedExprReturns;
  sample_byte_length?: number;
  notes?: string;
  tested_at: string;
}

export interface DiscoveryArtifact {
  schema_version: 1;
  capability: string;
  created_at: string;
  updated_at: string;
  sessions_contributed: number;
  iteration_state?: {
    verify_iterations: number;
    verified_ok: number;
    last_convergence?: {
      shape?: string;
      length_match_pct?: number;
      diff_offset_pct?: number;
      progress?: string;
    };
  };
  resume_pointers: ResumePointer[];
  observations: string[];
  tool_call_trace: ToolCallTraceEntry[];
  recommended_next_steps?: string[];
  /** Typed freeform hints the agent drops for the next session's agent. The
   *  `kind` is descriptive, not prescriptive — agents categorize their own
   *  hints. Unlike `observations` (slug-shaped, count-only), notes carry prose
   *  up to 500 chars and capture reasoning, open questions, byte-layout,
   *  etc. */
  notes?: DiscoveryNote[];
  /** Expressions the agent verified work against the captured frame — the
   *  next session can try these first instead of re-deriving. Each entry was
   *  eval'd at save-time; entries that threw didn't land. */
  verified_expressions?: VerifiedExpression[];
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

const MAX_RESUME_POINTERS = 20;
const MAX_OBSERVATIONS = 40;
const MAX_TOOL_CALL_TRACE = 80;
const MAX_RECOMMENDED_NEXT_STEPS = 6;
export const MAX_NOTE_LEN = 600;
const MAX_NEXT_STEP_LEN = 200;
const MAX_OBSERVATION_LEN = 30;
export const MAX_REF_LEN = 1000;
export const MAX_DISCOVERY_NOTES = 20;
export const MAX_DISCOVERY_NOTE_BODY = 2000;
export const MAX_VERIFIED_EXPRESSIONS = 5;
export const MAX_VERIFIED_EXPR_LEN = 8192;
const MAX_VERIFIED_EXPR_NOTES = 200;

const OBSERVATION_SLUG_RE = /^[a-z_][a-z0-9_-]{2,29}$/i;
const ARGS_DIGEST_RE = /^[a-f0-9]{16}$/;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function artifactJsonPath(platform: string, capability: string): string {
  return path.join(artifactsDir(platform), `${capability}.json`);
}

function readJsonSafe(p: string): unknown {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeAtomic(p: string, contents: Buffer | string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateDiscoveryArtifactShape(
  value: unknown,
  field = 'discovery_artifact',
): DiscoveryArtifact {
  const obj = asObject(value, field);
  if (obj.schema_version !== 1) {
    throw new ValidationError(
      `${field}.schema_version`,
      `must be 1 (got ${JSON.stringify(obj.schema_version)})`,
    );
  }
  asIdentifierSlug(obj.capability, `${field}.capability`);
  asNonEmptyString(obj.created_at, `${field}.created_at`);
  asNonEmptyString(obj.updated_at, `${field}.updated_at`);
  if (typeof obj.sessions_contributed !== 'number' || obj.sessions_contributed < 0) {
    throw new ValidationError(`${field}.sessions_contributed`, 'must be a non-negative integer');
  }
  const pointers = asArray(obj.resume_pointers ?? [], `${field}.resume_pointers`);
  if (pointers.length > MAX_RESUME_POINTERS) {
    throw new ValidationError(
      `${field}.resume_pointers`,
      `max ${MAX_RESUME_POINTERS} entries (got ${pointers.length})`,
    );
  }
  pointers.forEach((entry, i) => {
    validateResumePointer(entry, `${field}.resume_pointers[${i}]`);
  });
  const obs = asArray(obj.observations ?? [], `${field}.observations`);
  if (obs.length > MAX_OBSERVATIONS) {
    throw new ValidationError(`${field}.observations`, `max ${MAX_OBSERVATIONS} entries`);
  }
  const seenObs = new Set<string>();
  obs.forEach((entry, i) => {
    const s = asNonEmptyString(entry, `${field}.observations[${i}]`);
    if (!OBSERVATION_SLUG_RE.test(s) || s.length > MAX_OBSERVATION_LEN) {
      throw new ValidationError(
        `${field}.observations[${i}]`,
        `must match ${OBSERVATION_SLUG_RE} and be ≤ ${MAX_OBSERVATION_LEN} chars`,
      );
    }
    if (seenObs.has(s)) {
      throw new ValidationError(`${field}.observations[${i}]`, `duplicate observation "${s}"`);
    }
    seenObs.add(s);
  });
  const trace = asArray(obj.tool_call_trace ?? [], `${field}.tool_call_trace`);
  if (trace.length > MAX_TOOL_CALL_TRACE) {
    throw new ValidationError(`${field}.tool_call_trace`, `max ${MAX_TOOL_CALL_TRACE} entries`);
  }
  trace.forEach((entry, i) => validateToolCallTraceEntry(entry, `${field}.tool_call_trace[${i}]`));
  if (obj.recommended_next_steps !== undefined) {
    const steps = asArray(obj.recommended_next_steps, `${field}.recommended_next_steps`);
    if (steps.length > MAX_RECOMMENDED_NEXT_STEPS) {
      throw new ValidationError(
        `${field}.recommended_next_steps`,
        `max ${MAX_RECOMMENDED_NEXT_STEPS} entries`,
      );
    }
    steps.forEach((entry, i) => {
      asBoundedString(entry, `${field}.recommended_next_steps[${i}]`, MAX_NEXT_STEP_LEN);
    });
  }
  if (obj.iteration_state !== undefined) {
    const itObj = asObject(obj.iteration_state, `${field}.iteration_state`);
    if (typeof itObj.verify_iterations !== 'number' || itObj.verify_iterations < 0) {
      throw new ValidationError(
        `${field}.iteration_state.verify_iterations`,
        'must be a non-negative integer',
      );
    }
    if (typeof itObj.verified_ok !== 'number' || itObj.verified_ok < 0) {
      throw new ValidationError(
        `${field}.iteration_state.verified_ok`,
        'must be a non-negative integer',
      );
    }
  }
  if (obj.notes !== undefined) {
    const notes = asArray(obj.notes, `${field}.notes`);
    if (notes.length > MAX_DISCOVERY_NOTES) {
      throw new ValidationError(`${field}.notes`, `max ${MAX_DISCOVERY_NOTES} entries`);
    }
    notes.forEach((n, i) => validateDiscoveryNote(n, `${field}.notes[${i}]`));
  }
  if (obj.verified_expressions !== undefined) {
    const xs = asArray(obj.verified_expressions, `${field}.verified_expressions`);
    if (xs.length > MAX_VERIFIED_EXPRESSIONS) {
      throw new ValidationError(
        `${field}.verified_expressions`,
        `max ${MAX_VERIFIED_EXPRESSIONS} entries`,
      );
    }
    xs.forEach((x, i) => validateVerifiedExpression(x, `${field}.verified_expressions[${i}]`));
  }
  return obj as unknown as DiscoveryArtifact;
}

function validateDiscoveryNote(value: unknown, field: string): DiscoveryNote {
  const obj = asObject(value, field);
  asEnum(obj.kind, `${field}.kind`, DISCOVERY_NOTE_KINDS);
  asBoundedString(obj.body, `${field}.body`, MAX_DISCOVERY_NOTE_BODY);
  asNonEmptyString(obj.at, `${field}.at`);
  if (obj.verified !== undefined && typeof obj.verified !== 'boolean') {
    throw new ValidationError(`${field}.verified`, 'must be boolean when present');
  }
  return obj as unknown as DiscoveryNote;
}

function validateVerifiedExpression(value: unknown, field: string): VerifiedExpression {
  const obj = asObject(value, field);
  asBoundedString(obj.expression, `${field}.expression`, MAX_VERIFIED_EXPR_LEN);
  const binds = asArray(obj.binds_args, `${field}.binds_args`);
  binds.forEach((b, i) => {
    asIdentifierSlug(b, `${field}.binds_args[${i}]`);
  });
  asEnum(obj.returns, `${field}.returns`, VERIFIED_EXPR_RETURNS);
  if (obj.sample_byte_length !== undefined) {
    if (typeof obj.sample_byte_length !== 'number' || obj.sample_byte_length < 0) {
      throw new ValidationError(`${field}.sample_byte_length`, 'must be a non-negative number');
    }
  }
  if (obj.notes !== undefined) {
    asBoundedString(obj.notes, `${field}.notes`, MAX_VERIFIED_EXPR_NOTES);
  }
  asNonEmptyString(obj.tested_at, `${field}.tested_at`);
  return obj as unknown as VerifiedExpression;
}

function validateResumePointer(value: unknown, field: string): ResumePointer {
  const obj = asObject(value, field);
  const kind = asEnum(obj.kind, `${field}.kind`, RESUME_POINTER_KINDS);
  const ref = asBoundedString(obj.ref, `${field}.ref`, MAX_REF_LEN);
  if (kind === 'js_source' || kind === 'page_url') {
    asUrl(ref, `${field}.ref`, { maxLength: MAX_REF_LEN });
  }
  if (obj.line !== undefined && obj.line !== null) {
    if (kind !== 'js_source') {
      throw new ValidationError(
        `${field}.line`,
        `only valid when kind === "js_source" (got kind "${kind}")`,
      );
    }
    asPositiveInt(obj.line, `${field}.line`);
  }
  if (obj.note !== undefined && obj.note !== null) {
    asBoundedString(obj.note, `${field}.note`, MAX_NOTE_LEN);
  }
  asNonEmptyString(obj.at, `${field}.at`);
  return obj as unknown as ResumePointer;
}

function validateToolCallTraceEntry(value: unknown, field: string): ToolCallTraceEntry {
  const obj = asObject(value, field);
  asEnum(obj.tool, `${field}.tool`, TOOL_CALL_TRACE_TOOLS);
  const digest = asNonEmptyString(obj.args_digest, `${field}.args_digest`);
  if (!ARGS_DIGEST_RE.test(digest)) {
    throw new ValidationError(`${field}.args_digest`, `must match ${ARGS_DIGEST_RE}`);
  }
  asEnum(obj.outcome, `${field}.outcome`, ['ok', 'failed', 'partial'] as const);
  asNonEmptyString(obj.at, `${field}.at`);
  return obj as unknown as ToolCallTraceEntry;
}

// ---------------------------------------------------------------------------
// Accumulator → artifact
// ---------------------------------------------------------------------------

export function ensureAccumulator(session: Session): ArtifactAccumulator {
  if (!session.artifactAccumulator) {
    session.artifactAccumulator = {
      inspectWsFrameCalls: [],
      tryGeneratorCalls: [],
      getJsSourceCalls: [],
      getSendEncoderCalls: [],
      findInPageCalls: [],
      getAttributeCalls: [],
      getNetworkLogCalls: [],
      jsEvalCalls: [],
      searchJsSourceCalls: [],
      readJsFunctionCalls: [],
      listLoadedScriptsCalls: [],
      setBreakpointCalls: [],
      evaluateOnFrameCalls: [],
      notes: {},
      verifiedExpressions: {},
      agentResumePointers: {},
      recommendedNextSteps: [],
    };
  }
  return session.artifactAccumulator;
}

const RING_CAP = 200;

export function ringPush<T>(arr: T[], entry: T): void {
  arr.push(entry);
  while (arr.length > RING_CAP) arr.shift();
}

export function digestArgs(args: unknown): string {
  const s = (() => {
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  })();
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function digestSelector(selector: string | undefined): string {
  return crypto
    .createHash('sha256')
    .update(selector ?? '')
    .digest('hex')
    .slice(0, 16);
}

// Dynamic-field name slugification: take the first 30 chars of a ref string,
// lowercase, replace non-slug chars with '-'. Used to derive observation slugs
// from `find_in_page` needles. The runtime never classifies what the needle
// MEANS; it only ensures the slug is shape-valid.
function toObservationSlug(s: string): string | null {
  const trimmed = s
    .trim()
    .slice(0, MAX_OBSERVATION_LEN)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  if (OBSERVATION_SLUG_RE.test(trimmed)) return trimmed;
  return null;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

interface MergeContext {
  now: string;
  capabilityCapturedBytes?: Buffer;
}

/**
 * Build a DiscoveryArtifact from the session accumulator, merge with any
 * existing artifact on disk for the same (platform, capability) pair, and
 * return the merged result along with any byte blob that should be written to
 * disk. The caller persists both.
 */
export function buildAndMergeArtifact(
  platform: string,
  capability: string,
  accumulator: ArtifactAccumulator,
  tryGeneratorStats: { verify_iterations: number; verified_ok: number } | null,
  ctx: MergeContext,
): { artifact: DiscoveryArtifact } {
  const existing = readArtifactFromDisk(platform, capability);
  const now = ctx.now;
  const created_at = existing?.created_at ?? now;

  const resumePointers: ResumePointer[] = [...(existing?.resume_pointers ?? [])];

  // Inspect WS frame calls → frame_index pointers
  for (const call of accumulator.inspectWsFrameCalls) {
    const ptr: ResumePointer = {
      kind: 'frame_index',
      ref: String(call.ws_i),
      note: call.starter_present ? 'starter available' : undefined,
      at: call.at,
    };
    pushDedupedPointer(resumePointers, ptr);
  }
  // JS source calls → js_source pointers
  for (const call of accumulator.getJsSourceCalls) {
    const ptr: ResumePointer = {
      kind: 'js_source',
      ref: call.url,
      line: call.line,
      at: call.at,
    };
    pushDedupedPointer(resumePointers, ptr);
  }
  // Agent explicit pointers (from add_resume_pointer tool), scoped to this
  // capability. Other capabilities' pointers don't belong here.
  for (const ptr of accumulator.agentResumePointers[capability] ?? []) {
    pushDedupedPointer(resumePointers, ptr);
  }
  // Keep N most recent by `at`
  resumePointers.sort((a, b) => a.at.localeCompare(b.at));
  const trimmedPointers = resumePointers.slice(-MAX_RESUME_POINTERS);

  // Observations: derive from find_in_page needles. Agent writes slugs
  // indirectly by what they searched for.
  const observations = new Set<string>(existing?.observations ?? []);
  for (const call of accumulator.findInPageCalls) {
    if (observations.size >= MAX_OBSERVATIONS) break;
    if (call.matches_count === 0) continue;
    const slug = toObservationSlug(call.needle_slug);
    if (slug) observations.add(slug);
  }

  // Tool call trace: merge + keep last 80
  const trace: ToolCallTraceEntry[] = [...(existing?.tool_call_trace ?? [])];
  addTraceEntries(trace, 'inspect_ws_frame', accumulator.inspectWsFrameCalls);
  addTraceEntries(trace, 'try_generator', accumulator.tryGeneratorCalls);
  addTraceEntries(trace, 'get_js_source', accumulator.getJsSourceCalls);
  addTraceEntries(trace, 'get_send_encoder', accumulator.getSendEncoderCalls);
  addTraceEntries(trace, 'find_in_page', accumulator.findInPageCalls);
  addTraceEntries(trace, 'get_network_log', accumulator.getNetworkLogCalls);
  addTraceEntries(trace, 'get_attribute', accumulator.getAttributeCalls);
  trace.sort((a, b) => a.at.localeCompare(b.at));
  const dedupedTrace = dedupeTrace(trace).slice(-MAX_TOOL_CALL_TRACE);

  // Iteration state: max of prior and current
  const prior = existing?.iteration_state;
  let iterationState = prior;
  if (tryGeneratorStats) {
    iterationState = {
      verify_iterations: Math.max(
        prior?.verify_iterations ?? 0,
        tryGeneratorStats.verify_iterations,
      ),
      verified_ok: Math.max(prior?.verified_ok ?? 0, tryGeneratorStats.verified_ok),
      last_convergence: prior?.last_convergence,
    };
  }

  // Recommended next steps: replace when the agent supplied new ones
  let nextSteps = existing?.recommended_next_steps;
  if (accumulator.recommendedNextSteps.length > 0) {
    nextSteps = accumulator.recommendedNextSteps.slice(0, MAX_RECOMMENDED_NEXT_STEPS);
  }

  // Notes: union with prior by (kind, body) hash. Most-recent-first.
  const mergedNotes: DiscoveryNote[] = [];
  const notesSeen = new Set<string>();
  // Callers (notably tests) may construct a partial accumulator without the
  // notes/verifiedExpressions maps, so guard the runtime shape even though the
  // public type says the fields are required.
  const notesByCapability = (accumulator as { notes?: ArtifactAccumulator['notes'] }).notes;
  const currentNotes = notesByCapability?.[capability] ?? [];
  const allNotes: DiscoveryNote[] = [
    ...currentNotes.map((n) => ({
      kind: n.kind as DiscoveryNoteKind,
      body: n.body,
      at: n.at,
      ...(n.verified !== undefined ? { verified: n.verified } : {}),
    })),
    ...(existing?.notes ?? []),
  ];
  // Stable dedup: first occurrence wins — current session's notes beat prior.
  for (const n of allNotes) {
    const key = `${n.kind}|${n.body}`;
    if (notesSeen.has(key)) continue;
    notesSeen.add(key);
    mergedNotes.push(n);
    if (mergedNotes.length >= MAX_DISCOVERY_NOTES) break;
  }

  // Verified expressions: union by expression hash. Keep the shortest working
  // version per hash (agents refine).
  const mergedVerifiedExprs: VerifiedExpression[] = [];
  const exprsSeen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const currentExprs = accumulator.verifiedExpressions?.[capability] ?? [];
  const allExprs: VerifiedExpression[] = [
    ...currentExprs.map((e) => ({
      expression: e.expression,
      binds_args: e.binds_args,
      returns: e.returns,
      ...(e.sample_byte_length !== undefined ? { sample_byte_length: e.sample_byte_length } : {}),
      ...(e.notes !== undefined ? { notes: e.notes } : {}),
      tested_at: e.tested_at,
    })),
    ...(existing?.verified_expressions ?? []),
  ];
  for (const e of allExprs) {
    const key = e.expression;
    if (exprsSeen.has(key)) continue;
    exprsSeen.add(key);
    mergedVerifiedExprs.push(e);
    if (mergedVerifiedExprs.length >= MAX_VERIFIED_EXPRESSIONS) break;
  }

  const changed =
    !existing ||
    existing.resume_pointers.length !== trimmedPointers.length ||
    existing.observations.length !== observations.size ||
    existing.tool_call_trace.length !== dedupedTrace.length ||
    (existing.notes?.length ?? 0) !== mergedNotes.length ||
    (existing.verified_expressions?.length ?? 0) !== mergedVerifiedExprs.length;

  const artifact: DiscoveryArtifact = {
    schema_version: 1,
    capability,
    created_at,
    updated_at: now,
    sessions_contributed: (existing?.sessions_contributed ?? 0) + (changed ? 1 : 0),
    iteration_state: iterationState,
    resume_pointers: trimmedPointers,
    observations: [...observations],
    tool_call_trace: dedupedTrace,
    recommended_next_steps: nextSteps,
    ...(mergedNotes.length > 0 ? { notes: mergedNotes } : {}),
    ...(mergedVerifiedExprs.length > 0 ? { verified_expressions: mergedVerifiedExprs } : {}),
  };

  return { artifact };
}

function pushDedupedPointer(arr: ResumePointer[], ptr: ResumePointer): void {
  const key = `${ptr.kind}|${ptr.ref}|${ptr.line ?? ''}`;
  for (const existing of arr) {
    const k = `${existing.kind}|${existing.ref}|${existing.line ?? ''}`;
    if (k === key) return; // already present; keep earlier entry
  }
  arr.push(ptr);
}

function addTraceEntries(
  trace: ToolCallTraceEntry[],
  tool: ToolCallTraceTool,
  calls: Array<{
    args_digest?: string;
    selector_digest?: string;
    filter_digest?: string;
    needle_slug?: string;
    ok?: boolean;
    at: string;
  }>,
): void {
  for (const c of calls) {
    const digest =
      c.args_digest ??
      c.selector_digest ??
      c.filter_digest ??
      (c.needle_slug ? digestArgs({ needle: c.needle_slug }) : null);
    if (!digest || !ARGS_DIGEST_RE.test(digest)) continue;
    const outcome: ToolCallTraceEntry['outcome'] = c.ok === false ? 'failed' : 'ok';
    trace.push({ tool, args_digest: digest, outcome, at: c.at });
  }
}

function dedupeTrace(arr: ToolCallTraceEntry[]): ToolCallTraceEntry[] {
  const seen = new Set<string>();
  const out: ToolCallTraceEntry[] = [];
  for (const entry of arr) {
    const key = `${entry.tool}|${entry.args_digest}|${entry.outcome}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export function readArtifactFromDisk(
  platform: string,
  capability: string,
): DiscoveryArtifact | null {
  return readJsonSafe(artifactJsonPath(platform, capability)) as DiscoveryArtifact | null;
}

export function writeArtifact(
  platform: string,
  capability: string,
  artifact: DiscoveryArtifact,
): void {
  validateDiscoveryArtifactShape(artifact);
  writeAtomic(artifactJsonPath(platform, capability), JSON.stringify(artifact, null, 2));
}

/**
 * List every (platform, capability) that has a discovery artifact on disk. Used
 * by list_platform_skills / start_session to inline artifacts.
 */
export function listArtifactsForPlatform(platform: string): string[] {
  const dir = artifactsDir(platform);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

/** Per-capability character budget for the inlined artifact on agent-facing
 * responses (list_platform_skills, start_session, execute, end_drive RE handoff's
 * triage block). Left of the MCP tool-output budget so the artifact can
 *  coexist with the rest of the response fields. */
export const LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET = 8_000;

/**
 * Derive the cross-session "resume RE?" surface. When the prior session left
 * partial progress (resume_pointers + verified_expressions/notes) AND no
 * higher-tier strategy was saved, start_session / list_platform_skills inlines a
 * `re_continuation_available: true` flag plus a summary and a one-sentence
 * prompt the agent relays to the user. Returns null when no partial-progress
 * pattern matches.
 */
function deriveReContinuation(
  platform: string,
  capability: string,
  artifact: DiscoveryArtifact,
  loadStrategies: (platform: string, capability: string) => Array<{ strategy: string }>,
): null | {
  re_continuation_available: true;
  re_progress_summary: string;
  suggested_user_prompt: string;
} {
  const saved = loadStrategies(platform, capability);
  const hasHigherTier = saved.some((s) => s.strategy === 'fetch' || s.strategy === 'page-script');
  if (hasHigherTier) return null;
  const verifiedCount = artifact.verified_expressions?.length ?? 0;
  const noteCount = artifact.notes?.length ?? 0;
  const pointerCount = artifact.resume_pointers.length;
  // Require at least one verified expression OR at least two notes + pointers —
  // the "real partial progress" bar. A bare recorded-path with no RE work
  // doesn't warrant the prompt.
  if (verifiedCount === 0 && !(noteCount >= 2 && pointerCount >= 1)) return null;
  const openQuestions = (artifact.notes ?? []).filter((n) => n.kind === 'open_question').length;
  const summaryParts: string[] = [];
  if (verifiedCount > 0) {
    summaryParts.push(`${verifiedCount} verified expression${verifiedCount === 1 ? '' : 's'}`);
  }
  if (noteCount > 0) {
    summaryParts.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`);
  }
  if (openQuestions > 0) {
    summaryParts.push(`${openQuestions} open question${openQuestions === 1 ? '' : 's'}`);
  }
  if (pointerCount > 0) {
    summaryParts.push(`${pointerCount} resume pointer${pointerCount === 1 ? '' : 's'}`);
  }
  const summary = `prior session left ${summaryParts.join(', ')}`;
  return {
    re_continuation_available: true,
    re_progress_summary: summary,
    // This is part of the bot's personality ;) — voice is "technical but new to
    // reverse engineering": concrete, curious, honest about what's known vs
    // unknown.
    suggested_user_prompt:
      'Klura made partial progress last time toward a faster way to do this — I kept notes on what I figured out. Want me to pick up where I left off (might take a while, but the faster strategy pays off every future run), or just use the UI-replay path for this call?',
  };
}

export type InlinedArtifact = DiscoveryArtifact & {
  _elided_fields?: string[];
  re_continuation_available?: true;
  re_progress_summary?: string;
  suggested_user_prompt?: string;
};

/**
 * Serialize a DiscoveryArtifact for inclusion in an agent-facing response, with
 * progressive elision when the result exceeds the per-capability budget. Order
 * of fields dropped: tool_call_trace (oldest entries first), then trailing
 * observations. The always-preserved core is iteration_state + resume_pointers
 * + recommended_next_steps. Takes `loadStrategies` as a parameter so this
 * module stays independent of `./skills` (which imports from here — avoid the
 * cycle).
 */
export function inlineArtifactForResponse(
  platform: string,
  capability: string,
  artifact: DiscoveryArtifact,
  budget: number,
  loadStrategies: (platform: string, capability: string) => Array<{ strategy: string }>,
): InlinedArtifact {
  const clone = JSON.parse(JSON.stringify(artifact)) as InlinedArtifact;
  const resume = deriveReContinuation(platform, capability, artifact, loadStrategies);
  if (resume) {
    clone.re_continuation_available = resume.re_continuation_available;
    clone.re_progress_summary = resume.re_progress_summary;
    clone.suggested_user_prompt = resume.suggested_user_prompt;
  }
  const sizeOf = (): number => JSON.stringify(clone).length;
  const elided: string[] = [];
  while (sizeOf() > budget && clone.tool_call_trace.length > 0) {
    clone.tool_call_trace.shift();
    if (!elided.includes('tool_call_trace')) elided.push('tool_call_trace');
  }
  while (sizeOf() > budget && clone.observations.length > 0) {
    clone.observations.pop();
    if (!elided.includes('observations')) elided.push('observations');
  }
  if (elided.length > 0) clone._elided_fields = elided;
  return clone;
}

/**
 * Write a byte-verified generator directly to the session's discovery artifact
 * accumulator. Called from `try_generator` / `try_generator_in_page` on every
 * ok:true — the runtime has ground truth that this code produced the captured
 * bytes, so the write is safe without a tool call. Keys to the session's first
 * declared capability; end_drive flushes the artifact to disk. Resets the
 * hardness-check counter the same way an explicit `save_verified_expression`
 * call would.
 *
 * Returns the entry summary for inclusion on the generator-tool response, or
 * null when persist is skipped (no declared capability, or code exceeds the
 * per-expression length cap).
 */
export function persistVerifiedExpressionFromGenerator(
  session: Session,
  code: string,
  args: Record<string, unknown>,
  returns: 'hex' | 'base64' | 'string' | 'object',
  sampleByteLength: number,
): {
  capability: string;
  binds_args: string[];
  returns: 'hex' | 'base64' | 'string' | 'object';
} | null {
  const declared = session.declaredCapabilities ?? [];
  const firstDeclared = declared[0];
  if (!firstDeclared) return null;
  const capability = firstDeclared.capability;
  if (code.length > MAX_VERIFIED_EXPR_LEN) return null;
  const binds_args = Object.keys(args);
  try {
    const acc = ensureAccumulator(session);
    const bucket = acc.verifiedExpressions[capability] ?? [];
    acc.verifiedExpressions[capability] = bucket;
    bucket.push({
      expression: code,
      binds_args,
      returns,
      sample_byte_length: sampleByteLength,
      tested_at: new Date().toISOString(),
      notes: 'auto-persisted on try_generator ok',
    });
    if (bucket.length > MAX_VERIFIED_EXPRESSIONS) {
      bucket.splice(0, bucket.length - MAX_VERIFIED_EXPRESSIONS);
    }
  } catch {
    return null;
  }
  return { capability, binds_args, returns };
}
