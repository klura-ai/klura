import fs from 'fs';
import path from 'path';
import { pool } from '../../runtime-state';
import * as skills from '../../strategies/skills';
import {
  synthesizeFallbacksOnClose,
  type AutoSynthResult as SynthLedgerEntry,
} from '../../strategies/synthesize-on-close';
import { ingestCaptureEvents } from '../../working-dir/writer';
import {
  clearObservedSessionTracking,
  readObservedCapabilities,
  recordObservedCapability,
} from '../../working-dir/logbook';
import { inferObservedCapabilitiesFromGraph } from '../../working-dir/url-graph';
import { loadLogbook } from '../../working-dir/logbook';
import type { ObservedCapabilityInput } from '../../working-dir/logbook';
import type {
  CaptureEvent,
  HttpRequestPayload,
  LiftAttemptPayload,
  PerformActionPayload,
  SessionMetaPayload,
  ToolCallPayload,
  WsFramePayload,
} from '../../working-dir/schema';
import { sha256 as sha256Bytes } from '../../working-dir/bundle-archive';
import { loadCapabilityPolicy as loadCapabilityPolicyFull } from '../../strategies/policy';
import { buildAndMergeArtifact, writeArtifact } from '../../strategies/discovery-artifact';
import { clearStartersForSession } from '../../response/starter-cache';
import { clearForSession as clearSessionObservations } from '../../response/session-observations';
import {
  computeReverseEngineerHandoff,
  wouldReverseEngineerHandoffFire,
} from './drive-to-triage-handoff';
import { endDriveAudit, buildEndDrivePayload } from '../../audit/drive/end-drive';
import { rejectionToErrorMessage } from '../../audit';
import { graphConfig, currentGraph } from '../registry';

function outcomeForTier(tier: string): SessionMetaPayload['outcome'] {
  if (tier === 'page-script') return 'page_script_saved';
  if (tier === 'fetch') return 'fetch_saved';
  if (tier === 'recorded-path') return 'recorded_path_saved';
  return 'no_save';
}

function serializePostData(postData: unknown): string | null {
  if (postData === null || postData === undefined) return null;
  if (typeof postData === 'string') return postData;
  try {
    return JSON.stringify(postData);
  } catch {
    return null;
  }
}

/**
 * Adapter between the live agent-driven session and the working-dir's
 * CaptureEvent stream. Runs at end_drive. Reads driver-held network log +
 * WS frames + session.performActionHistory + session.artifactAccumulator,
 * reshapes into CaptureEvent[], calls ingestCaptureEvents. This is the ONLY
 * place session/pool state touches runtime/src/working-dir/ — the working-dir
 * modules themselves accept the capture-event stream and know nothing about
 * live sessions.
 *
 * Best-effort: any error here is swallowed by the caller. A flush failure must
 * not turn a clean close into an error.
 */
async function flushSessionToWorkingDir(
  session: ReturnType<typeof pool.getSession>,
  platform: string,
  autoSynthesized: SynthLedgerEntry[],
): Promise<void> {
  const sessionId = session.id;
  const driver = pool.driverFor(sessionId);
  const [requests, wsFrames] = await Promise.all([
    driver.getInterceptedRequests(session).catch(() => []),
    driver.getInterceptedWebSocketFrames(session).catch(() => []),
  ]);

  const endedAt = Date.now();
  const startedAt = (session as unknown as { startedAt?: number }).startedAt ?? endedAt;
  const declared = session.declaredCapabilities ?? [];
  const primaryCapability = declared[0]?.capability;
  const primaryArgs = declared[0]?.args;

  // Determine session outcome from the mix of explicit saves + auto-synth.
  // Precedence: page-script > fetch > recorded-path > no_save. Takes the best
  // tier that landed, matching how execute() cascades.
  const savedTiers = new Set<string>();
  for (const s of session.savedCapabilities ?? []) savedTiers.add(s.tier);
  for (const a of autoSynthesized) savedTiers.add(a.tier);
  let outcome: SessionMetaPayload['outcome'] = 'no_save';
  if (savedTiers.has('page-script')) {
    outcome = 'page_script_saved';
  } else if (savedTiers.has('fetch')) {
    outcome = 'fetch_saved';
  } else if (savedTiers.has('recorded-path')) {
    outcome = 'recorded_path_saved';
  }

  const events: CaptureEvent[] = [];
  const baseTs = endedAt;
  const push = (
    at: number,
    kind: CaptureEvent['kind'],
    payload: unknown,
    capability?: string,
  ): void => {
    events.push({ at, session_id: sessionId, platform, capability, kind, payload });
  };

  push(baseTs, 'session_meta', {
    started_at: startedAt,
    ended_at: endedAt,
    capability: primaryCapability,
    args: primaryArgs,
    outcome,
  } satisfies SessionMetaPayload);

  for (const r of requests) {
    const postData = serializePostData(r.postData);
    const payload: HttpRequestPayload = {
      method: r.method,
      url: r.url,
      headers: r.headers,
      postData,
      status: r.status ?? undefined,
    };
    const ct = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    if (typeof ct === 'string') payload.contentType = ct.split(';')[0]?.trim();
    if (r.responseBody !== undefined && r.responseBody !== null) {
      payload.responseBody = r.responseBody;
      if (typeof r.responseBody === 'string') payload.responseSize = r.responseBody.length;
    }
    push(typeof r.timestamp === 'number' ? r.timestamp : baseTs, 'http_request', payload);
  }

  for (const f of wsFrames) {
    const payload: WsFramePayload = {
      direction: f.direction,
      url: f.url,
      payload: typeof f.payload === 'string' ? f.payload : '',
      encoding:
        typeof f.payload === 'string' && /^[A-Za-z0-9+/=]+$/.test(f.payload) ? 'binary' : 'text',
    };
    push(typeof f.timestamp === 'number' ? f.timestamp : baseTs, 'ws_frame', payload);
  }

  for (const nav of session.domNavigations ?? []) {
    push(nav.at, 'dom_navigation', {
      url: nav.url,
      ...(nav.title !== undefined ? { title: nav.title } : {}),
      ...(nav.via !== undefined ? { via: nav.via } : {}),
    });
  }

  for (const f of session.domFormsObserved ?? []) {
    push(f.at, 'dom_form_observed', {
      url: f.url,
      action: f.action,
      method: f.method,
      fields: f.fields,
    });
  }

  for (const a of session.performActionHistory ?? []) {
    const payload: PerformActionPayload = { action: a.action };
    if (a.selector !== undefined) payload.selector = a.selector;
    if (a.value !== undefined) payload.value = a.value;
    if ('key' in a && typeof (a as { key?: unknown }).key === 'string') {
      payload.key = (a as { key: string }).key;
    }
    if ('url' in a && typeof (a as { url?: unknown }).url === 'string') {
      payload.url = (a as { url: string }).url;
    }
    push(a.at, 'perform_action', payload);
  }

  const acc = session.artifactAccumulator;
  if (acc) {
    const emit = (
      list: Array<{ at: string }> | undefined,
      tool: string,
      detailFor?: (entry: { at: string }) => Record<string, unknown> | undefined,
    ): void => {
      if (!list) return;
      for (const e of list) {
        const ts = Date.parse(e.at);
        const payload: ToolCallPayload = {
          tool,
          args_digest: digestEntry(e),
          outcome: 'ok',
          detail: detailFor?.(e),
        };
        push(Number.isFinite(ts) ? ts : baseTs, 'tool_call', payload);
      }
    };
    emit(acc.inspectWsFrameCalls, 'inspect_ws_frame', (e) => {
      const x = e as { ws_i?: number; starter_present?: boolean };
      return { ws_i: x.ws_i, starter_present: x.starter_present };
    });
    emit(acc.tryGeneratorCalls, 'try_generator', (e) => {
      const x = e as { ok?: boolean };
      return { ok: x.ok };
    });
    emit(acc.getJsSourceCalls, 'get_js_source', (e) => {
      const x = e as { url?: string; line?: number };
      return { url: x.url, line: x.line };
    });
    emit(acc.findInPageCalls, 'find_in_page', (e) => {
      const x = e as { matches_count?: number };
      return { matches_count: x.matches_count };
    });
    emit(acc.jsEvalCalls, 'js_eval');
    emit(acc.searchJsSourceCalls, 'search_js_source', (e) => {
      const x = e as { url?: string };
      return { url: x.url };
    });
    emit(acc.readJsFunctionCalls, 'read_js_function', (e) => {
      const x = e as { url?: string; line?: number };
      return { url: x.url, line: x.line };
    });
    emit(acc.listLoadedScriptsCalls, 'list_loaded_scripts');
    emit(acc.setBreakpointCalls, 'set_breakpoint', (e) => {
      const x = e as { line?: number };
      return { line: x.line };
    });
    emit(acc.evaluateOnFrameCalls, 'evaluate_on_frame', (e) => {
      const x = e as { ok?: boolean };
      return { ok: x.ok };
    });
    emit(acc.getSendEncoderCalls, 'get_send_encoder');
    emit(acc.getAttributeCalls, 'get_attribute');
    emit(acc.getNetworkLogCalls, 'get_network_log');
  }

  // Lift-attempt events: one per tier that landed (either agent-saved or
  // auto-synth). Logbook appends one attempt per (capability, session).
  const attemptsByCapability = new Map<string, LiftAttemptPayload>();
  for (const a of autoSynthesized) {
    const key = a.capability;
    const tierOutcome: LiftAttemptPayload['outcome'] = outcomeForTier(a.tier);
    const prior = attemptsByCapability.get(key);
    // Keep the best (highest-tier) outcome per capability.
    if (!prior || tierRank(tierOutcome) > tierRank(prior.outcome)) {
      attemptsByCapability.set(key, {
        outcome: tierOutcome,
        rounds_spent: 0, // auto-synth doesn't consume LLM rounds
        notes: a.reason,
      });
    }
  }
  for (const s of session.savedCapabilities ?? []) {
    const tierOutcome: LiftAttemptPayload['outcome'] = outcomeForTier(s.tier);
    const prior = attemptsByCapability.get(s.capability);
    if (!prior || tierRank(tierOutcome) > tierRank(prior.outcome)) {
      attemptsByCapability.set(s.capability, {
        outcome: tierOutcome,
        rounds_spent: 0,
      });
    }
  }
  for (const [capability, payload] of attemptsByCapability) {
    push(endedAt, 'lift_attempt', payload, capability);
  }

  ingestCaptureEvents(platform, sessionId, events);
}

function tierRank(o: LiftAttemptPayload['outcome']): number {
  switch (o) {
    case 'fetch_saved':
      return 4;
    case 'page_script_saved':
      return 3;
    case 'recorded_path_saved':
      return 2;
    case 'user_deferred':
      return 1;
    case 'error':
    case 'no_save':
    default:
      return 0;
  }
}

function digestEntry(e: unknown): string {
  const x = e as { args_digest?: string };
  if (typeof x.args_digest === 'string') return x.args_digest;
  try {
    return sha256Bytes(JSON.stringify(e)).slice(0, 16);
  } catch {
    return '0000000000000000';
  }
}

// Diagnostic-only env-var hatch (intentional exception to the
// config-over-env-vars convention). External benchmark harnesses set
// KLURA_DUMP_LOGS_TO to write the full intercepted-request list + captured
// WebSocket frames to <dir>/<session_id>.json, for post-run inspection on sites
// whose real work happens over WS (chat apps, real-time dashboards,
// MQTT-over-WS channels). Not a user preference — not exposed in config.json —
// so per-run harnesses can opt in without mutating the shared config. Opt-in
// because captured bodies and frames may contain PII (message contents, user
// IDs, tokens); enabling callers are responsible for the destination path's
// privacy.
//
// Called on every end_drive entry — including LIFT handoffs, which do
// not tear down the browser but may be the last call before the session goes
// idle. Overwriting the per-session file is intentional: a later close sees
// more captures, and last-write-wins preserves the final state for inspectors.
async function maybeDumpCapturedLogs(
  sessionId: string,
  platform: string | undefined,
): Promise<void> {
  const dumpDir = process.env.KLURA_DUMP_LOGS_TO;
  if (!dumpDir) return;
  try {
    const session = pool.getSession(sessionId);
    const driver = pool.driverFor(sessionId);
    const requests = await driver.getInterceptedRequests(session);
    const wsFrames = await driver.getInterceptedWebSocketFrames(session);
    const dumpFile = path.join(dumpDir, `${sessionId}.json`);
    fs.mkdirSync(path.dirname(dumpFile), { recursive: true });
    fs.writeFileSync(
      dumpFile,
      JSON.stringify({ sessionId, platform, capturedAt: Date.now(), requests, wsFrames }, null, 2),
    );
  } catch {
    // Best-effort — a dump failure must not turn a clean close into an error.
  }
}

/** "Heavy" reverse-engineering tool calls — the trigger count for the
 *  end_drive re_persistence Detector (full rationale: shouldRunRePersistence
 *  in audit/drive/end-drive.ts). Code-inspection / breakpoint / frame-eval
 *  tools + full-body get_network_log (inline `<script>` source ≈ get_js_source);
 *  filter-only network reads don't count. `js_eval` is counted separately
 *  (countJsEvalCalls) — the everyday DOM-read tool, not an RE signal alone. */
function countHeavyReToolCalls(session: ReturnType<typeof pool.getSession>): number {
  const acc = session.artifactAccumulator;
  if (!acc) return 0;
  return (
    acc.setBreakpointCalls.length +
    acc.getJsSourceCalls.length +
    acc.searchJsSourceCalls.length +
    acc.readJsFunctionCalls.length +
    acc.evaluateOnFrameCalls.length +
    acc.getNetworkLogCalls.filter((c) => c.full).length
  );
}

/** js_eval calls this session — named alongside the heavy-RE count in the
 *  re_persistence rejection for context, but never the trigger on its own. */
function countJsEvalCalls(session: ReturnType<typeof pool.getSession>): number {
  return session.artifactAccumulator?.jsEvalCalls.length ?? 0;
}

/**
 * Count persistence-tool calls made this session: save_verified_expression
 * (writes `verifiedExpressions`), add_discovery_note (writes `notes`), and
 * add_resume_pointer (writes `agentResumePointers`). Summed across all
 * capabilities — a persist against any capability clears the gate.
 */
function countPersistCalls(session: ReturnType<typeof pool.getSession>): number {
  const acc = session.artifactAccumulator;
  if (!acc) return 0;
  const sumBuckets = (m: Record<string, readonly unknown[]> | undefined): number =>
    m ? Object.values(m).reduce((n, arr) => n + arr.length, 0) : 0;
  return (
    sumBuckets(acc.verifiedExpressions) +
    sumBuckets(acc.notes) +
    sumBuckets(acc.agentResumePointers)
  );
}

export type EndDriveAuditRejection = {
  ok: false;
  phase: 'end_drive_audit';
  session_id: string;
  message: string;
  /** Echoed for the orchestrator's caller — the runtime side has these as
   *  payload fields, but agents reading the rejection JSON (rather than the
   *  formatted message) want them visible. */
  re_call_count: number;
  persist_call_count: number;
  end_drive_attempts: number;
};

export async function endDrive(
  sessionId: string,
  opts: {
    platform?: string;
    auditToken?: string;
    auditAnswers?: Record<string, unknown>;
  } = {},
  ctx: { progress?: (params: { stage: string }) => void } = {},
): Promise<
  | { ok: true; auto_synthesized?: SynthLedgerEntry[] }
  | NonNullable<ReturnType<typeof computeReverseEngineerHandoff>>
  | EndDriveAuditRejection
> {
  const progress = ctx.progress ?? ((): void => {});
  const session = pool.getSession(sessionId);

  // Resolve platform once. Explicit opts.platform wins; otherwise fall back
  // to whatever the session was opened with so callers don't have to remember
  // to re-pass it on end_drive. Every platform-dependent decision below
  // (capability inference, triage handoff predicate, LIFT handoff branch,
  // storage-state save, auto-synth) reads from this single binding so an
  // omitted opts.platform can no longer silently reroute the flow into the
  // terminal-close path while a session-bound platform sits unused.
  const platform = opts.platform ?? session.platform;

  // Reject obviously-fabricated audit_token values up-front. The string
  // `"undefined"` / `"null"` shape comes from a JS-serialization
  // hallucination — the agent constructed the args object with a JS
  // `undefined` value that got coerced to the literal string. There is no
  // legitimate audit token equal to those literals, and accepting them lets
  // the audit machinery quietly evaluate to a non-rejection state because
  // the token never matches anything. Reject loudly so the agent sees what
  // happened.
  if (
    typeof opts.auditToken === 'string' &&
    (opts.auditToken === 'undefined' || opts.auditToken === 'null' || opts.auditToken === '')
  ) {
    throw new Error(
      `invalid_args: end_drive received audit_token: ${JSON.stringify(opts.auditToken)} — ` +
        `that is not a valid token. Audit tokens are minted ONLY by a prior end_drive audit ` +
        `rejection (the triage_acknowledgment Classifier). If no ` +
        `prior call returned a token, drop the audit_token field entirely. end_drive is gated ` +
        `on save_strategy success, not on audit answers — fabricating an audit token will not ` +
        `unblock the LIFT handoff.`,
    );
  }

  progress({ stage: 'inferring observed capabilities from triage' });
  // Triaged-but-not-lifted inference. Runs BEFORE the audit because it's
  // pure logbook->logbook derivation — translates triage plans the agent
  // already submitted into observed_capabilities entries when no saved
  // strategy covers the surface. Idempotent (record_observed_capability
  // dedups by name); safe to run on every close attempt regardless of
  // whether the audit subsequently blocks. Without running here, an
  // audit-blocked auto-close would prevent the inference from ever
  // landing in the logbook.
  if (platform) {
    try {
      const inferred = inferObservedCapabilitiesFromTriage(platform, sessionId);
      for (const entry of inferred) {
        try {
          recordObservedCapability(platform, entry);
        } catch {
          /* per-entry rejection shouldn't block the others */
        }
      }
    } catch {
      /* swallow */
    }
  }

  progress({ stage: 'running end-drive audit' });
  // Close-session audit runs BEFORE any state mutation (incl. the
  // endDriveAttempts bump). One Audit instance: three Detectors
  // (declaration-required, save-attempted-none-landed, re-persistence) + the
  // triage_acknowledgment Classifier. Any fires → unified rejection envelope.
  const heavyReCallCount = countHeavyReToolCalls(session);
  const jsEvalCallCount = countJsEvalCalls(session);
  const persistCallCount = countPersistCalls(session);
  const actionCallCount = (session.performActionHistory ?? []).length;
  // Pre-compute whether the post-audit triage handoff would fire. The
  // triage_acknowledgment classifier in the end-drive audit reads this to
  // decide whether to gate: when the runtime would otherwise skip triage
  // (everything resolved, no stale strategies), the agent must echo an ack
  // token instead of silently bypassing the triage step.
  const triageWouldFire = platform ? wouldReverseEngineerHandoffFire(session, platform) : false;
  const auditPayload = buildEndDrivePayload(
    session,
    { heavyReCallCount, jsEvalCallCount, persistCallCount, actionCallCount },
    { platform, triageWouldFire },
  );
  const auditResult = endDriveAudit.process(
    auditPayload,
    {},
    {
      token: opts.auditToken,
      answers: opts.auditAnswers,
    },
  );
  if (auditResult.status === 'rejected') {
    return {
      ok: false,
      phase: 'end_drive_audit',
      session_id: sessionId,
      message: rejectionToErrorMessage('end_drive', auditResult.rejection, {
        toolName: 'end_drive',
        referenceUrl: 'klura://reference#end-drive-audit',
      }),
      re_call_count: heavyReCallCount + jsEvalCallCount,
      persist_call_count: persistCallCount,
      end_drive_attempts: session.endDriveAttempts ?? 0,
    };
  }

  session.endDriveAttempts = (session.endDriveAttempts ?? 0) + 1;

  // Debugger cleanup runs FIRST, before any driver work that touches the page.
  // A session that left the debugger paused (breakpoint hit, pauseOnExceptions,
  // auto-pause-on-XHR) has every CDP operation on the main execution context
  // suspended — saveStorageState blocks forever because cookie queries need the
  // paused thread to service them. The cleanup is idempotent (no-op when the
  // Debugger domain was never enabled) and best-effort: a cleanup failure must
  // not block close.
  try {
    await pool.driverFor(sessionId).cleanupDebuggerState(session);
  } catch {
    /* non-fatal */
  }

  // Close-session handoff into LIFT (phase: "lift"): any declared capability
  // must either have a saved strategy OR an explicit policy decline before
  // close succeeds. The first end_drive call from drive (`session.lift` not
  // yet set) returns the LIFT handoff response — the agent becomes a reverse
  // engineer, works through candidate XHRs + RE signals, saves a strategy OR
  // declines with evidence.
  //
  // Subsequent end_drive calls FROM lift (`session.lift` already set, meaning
  // the prior handoff already fired) take the abandon path: skip the handoff,
  // fall through to auto-synth + close. This is the agent's escape hatch for
  // audit loops that fail to converge — the lift phase admits end_drive
  // exactly so the agent can bail without leaking the session. Auto-synth
  // still runs over the captured action history, so a salvageable
  // recorded-path can land from drive history even when the agent couldn't
  // compose a manual save.
  //
  // The rule for the first call is unchanged: if any declared capability is
  // unresolved, close requires a successful save_strategy (handoff returns
  // null when every capability has a save). The save itself is gated by the
  // user_confirmation classifier in the save-strategy audit, so the user has
  // the final say at save time on whether the proposed strategy lands.
  const isAbandonFromLift = session.lift !== undefined;
  // Only graphs that include a lift phase can run the LIFT handoff. Map's
  // topology is `drive → terminal{closed}` — writing session.lift bookkeeping
  // for a map session would leave session.phase undefined while session.lift
  // is populated, tripping the half-init invariant on the next currentPhase()
  // call. start_session already rejects `capability + map`, so this guard
  // is a defensive backstop — no in-process programmatic caller should reach
  // this branch on a graph without a lift phase.
  const graphHasLift = currentGraph(session).nodes.has('lift');
  if (platform && !isAbandonFromLift && graphHasLift) {
    progress({ stage: 'composing drive→triage handoff' });
    const handoff = computeReverseEngineerHandoff(session, platform);
    if (handoff) {
      try {
        const statePath = skills.storageStatePath(platform, session.identity);
        await pool.driverFor(sessionId).saveStorageState(session, statePath);
      } catch {
        /* non-fatal — handoff still returned */
      }
      // Dump captured requests/frames even on LIFT handoff. The session is
      // not torn down here, but the handoff may be the last end_drive call
      // (agent declines LIFT, field-report transcript cuts, benchmark
      // aborts). Without a dump on this path, post-hoc inspectors see an empty
      // network-logs dir despite the runtime having full captures in memory.
      await maybeDumpCapturedLogs(sessionId, platform);
      // Mark the session as having entered LIFT. The round counter starts
      // fresh each close-attempt that hits this branch.
      if (!session.lift) {
        session.lift = {
          handoffAt: Date.now(),
          roundsSinceHandoff: 0,
          budget: 0,
          softBlockEngaged: false,
        };
      }
      return handoff;
    }
  }

  // Persist storage state if the session is bound to a platform.
  if (platform) {
    // Identity travels on the session — set when start_session was called
    // with `identity`. Default-when-omitted writes the historical
    // <platform>.json path; named identities write <platform>--<identity>.json
    // so two accounts on the same platform don't overwrite each other.
    const statePath = skills.storageStatePath(platform, session.identity);
    await pool.driverFor(sessionId).saveStorageState(session, statePath);
  }

  progress({ stage: 'auto-synthesizing fallback strategies' });
  // Auto-synthesize fallback strategies from session history. Runs BEFORE the
  // session is torn down so the synthesizer can read `performActionHistory` +
  // `savedCapabilities` off the live session. Best-effort: a synthesis failure
  // must not prevent teardown.
  let autoSynthesized: SynthLedgerEntry[] = [];
  const synthDiag: Array<{
    pass: string;
    capability?: string;
    phase: string;
    outcome: string;
    detail?: Record<string, unknown>;
  }> = [];
  try {
    if (graphConfig(session).skipAutoSynth) {
      // Surface-mapping graphs are not goal-directed; auto-synth would write
      // strategy fallbacks the user never asked for. Logbook writes (further
      // down) still run so url_graph + forms_seen capture the mapping work.
      synthDiag.push({
        pass: 'synth_fetch',
        phase: 'skip',
        outcome: 'auto_synth_disabled',
        detail: {},
      });
      synthDiag.push({
        pass: 'synth_recorded',
        phase: 'skip',
        outcome: 'auto_synth_disabled',
        detail: {},
      });
    } else {
      let synthDriver: ReturnType<typeof pool.driverFor> | null = null;
      try {
        synthDriver = pool.driverFor(sessionId);
      } catch {
        // Session may have torn down its driver binding before close completes.
      }
      autoSynthesized = await synthesizeFallbacksOnClose(
        session,
        platform,
        synthDriver,
        synthDiag as never,
      );
    }
  } catch (err) {
    synthDiag.push({
      pass: 'synth_dispatch',
      phase: 'skip',
      outcome: 'threw',
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // No-silent-close guard. klura is always-save-by-default
  // (memory/feedback_klura_always_save_default.md). When a session declared a
  // capability, manually saved nothing, and auto-synth couldn't derive a
  // fallback either, the historical behaviour was to close cleanly with zero
  // strategies on disk — a silent failure where the agent satisfied the
  // declaration audit and then escaped without saving. Reject that path: the
  // agent must either save manually, retry to give auto-synth more captures, or
  // call `abort_session(reason)` for the honest exit. The third end_drive
  // attempt force-tears-down regardless (preserving the existing escape hatch
  // for genuinely stuck sessions).
  const skipAutoSynthForGuard = graphConfig(session).skipAutoSynth;
  const declaredCapabilityCount = (session.declaredCapabilities ?? []).length;
  const saveSuccessCount = (session.savedCapabilities ?? []).length;
  const endDriveAttemptsPreBump = session.endDriveAttempts ?? 1; // we bumped above
  if (
    !skipAutoSynthForGuard &&
    declaredCapabilityCount > 0 &&
    saveSuccessCount === 0 &&
    autoSynthesized.length === 0 &&
    endDriveAttemptsPreBump < 3
  ) {
    return {
      ok: false,
      phase: 'end_drive_audit',
      session_id: sessionId,
      message:
        `invalid_strategy: end_drive_rejected (silent_no_save)\n` +
        `  → CANNOT CLOSE: this session declared a capability but no strategy landed — neither a ` +
        `manual \`save_strategy\` nor an auto-synthesized fallback (auto-synth produced 0 entries; ` +
        `the captured traffic didn't carry the user's typed literals in a templatable shape, OR no ` +
        `mutating action correlated to a request body).\n` +
        `  → klura is always-save-by-default. Closing here would leave nothing on disk for the next ` +
        `run. Two valid next moves:\n` +
        `    1. SAVE manually: call \`save_strategy\` against the captured request you intended to ` +
        `       lift (use \`get_network_log\` to find it, then submit_triage_plan + save_strategy ` +
        `       in lift). The save-time audit will guide you through any rejections.\n` +
        `    2. ABORT: if this session shouldn't have been driving in the first place ` +
        `       (existing capability covers the task, user said abort, site dead), call ` +
        `       \`abort_session(session_id, "<reason ≥20 chars>")\` for the honest exit.\n` +
        `  → "I judged this as nothing worth saving" is NOT a legitimate verdict — that judgment ` +
        `isn't yours to make. See klura://reference#end-drive-audit.`,
      re_call_count: countHeavyReToolCalls(session) + countJsEvalCalls(session),
      persist_call_count: countPersistCalls(session),
      end_drive_attempts: endDriveAttemptsPreBump,
    };
  }

  progress({ stage: 'merging discovery artifacts' });
  // Discovery-artifact flush: for every capability saved in this session (or
  // auto-synthesized just now), merge the session accumulator with any prior
  // on-disk artifact and write the result. Protocol-neutral — the runtime just
  // persists WHICH tool calls happened and WHAT pointers the agent recorded; no
  // classification.
  const artifactWrites: Array<{
    capability: string;
    sessions_contributed: number;
  }> = [];
  if (platform && session.artifactAccumulator) {
    const acc = session.artifactAccumulator;
    const caps = new Set<string>();
    for (const rec of session.savedCapabilities ?? []) caps.add(rec.capability);
    for (const synth of autoSynthesized) caps.add(synth.capability);
    // Agent-supplied resume pointers also name their capability. Include them
    // so sessions where no save succeeded but the agent explicitly called
    // add_resume_pointer still produce a persisted handoff.
    for (const cap of Object.keys(acc.agentResumePointers)) caps.add(cap);
    // Declared-capability intents also produce artifacts, even when no save
    // succeeded and no explicit pointer was added. The declaration itself is a
    // next-run pickup point.
    for (const dc of session.declaredCapabilities ?? []) caps.add(dc.capability);
    for (const capability of caps) {
      try {
        const stats =
          typeof pool.getTryGeneratorStats === 'function'
            ? (pool.getTryGeneratorStats(sessionId) as {
                verify_iterations: number;
                verified_ok: number;
                with_verify_against: number;
                ok_true: number;
              } | null)
            : null;
        const normalizedStats = stats
          ? {
              verify_iterations: stats.verify_iterations,
              verified_ok: stats.verified_ok,
            }
          : null;
        const { artifact } = buildAndMergeArtifact(platform, capability, acc, normalizedStats, {
          now: new Date().toISOString(),
        });
        writeArtifact(platform, capability, artifact);
        artifactWrites.push({
          capability,
          sessions_contributed: artifact.sessions_contributed,
        });
      } catch {
        // swallow — best-effort, artifact write failure must not block teardown
      }
    }
  }

  await maybeDumpCapturedLogs(sessionId, platform);

  // Surface-mapping observed-capability inference. When the active graph
  // sets `inferObservedCapabilitiesAtClose`, derive observed_capabilities
  // from the runtime-collected navigations + forms WITHOUT requiring the
  // agent to call `record_observed_capability`. The runtime computes
  // server-side instead of asking the agent to maintain state (principles.md
  // "compute server-side"). Manual entries already in the logbook win — the
  // inference dedups against them by name. Best-effort: a failure here must
  // not block teardown.
  if (platform && graphConfig(session).inferObservedCapabilitiesAtClose) {
    try {
      const existing = readObservedCapabilities(platform);
      const inferred = inferObservedCapabilitiesFromGraph(
        session.domNavigations ?? [],
        session.domFormsObserved ?? [],
        existing,
      );
      for (const entry of inferred) {
        try {
          recordObservedCapability(platform, {
            name: entry.name,
            evidence: entry.evidence,
            why_not_lifted: entry.why_not_lifted,
            session_id: sessionId,
          });
        } catch {
          /* per-entry rejection (e.g. slug shape) shouldn't block the others */
        }
      }
    } catch {
      /* swallow */
    }
  }

  progress({ stage: 'flushing working dir + closing session' });
  // Platform working dir flush: translate the live session state into
  // CaptureEvent[] and hand to the working-dir writer. This builds the
  // per-platform logbook + session archive that cross-run analysis
  // (field-stability, bundle-drift, signer-history) reads from. Zero
  // runtime/driver dependency from the working-dir side — this adapter is the
  // only place the two layers touch. Best-effort: a flush failure must not turn
  // a clean close into an error.
  if (platform) {
    try {
      await flushSessionToWorkingDir(session, platform, autoSynthesized);
    } catch {
      /* swallow */
    }
  }

  await pool.endDrive(sessionId);
  clearStartersForSession(sessionId);
  clearSessionObservations(sessionId);
  clearObservedSessionTracking(sessionId);
  const result: {
    ok: true;
    auto_synthesized?: SynthLedgerEntry[];
    artifacts_updated?: typeof artifactWrites;
    prior_decline_applied?: Array<{
      capability: string;
      source: 'user_policy';
      reason?: string;
      retry_hint: string;
    }>;
    _diagnostics?: {
      synth: typeof synthDiag;
      declared_capabilities?: Array<{ capability: string; args: Record<string, string> }>;
    };
  } = { ok: true };
  if (autoSynthesized.length > 0) result.auto_synthesized = autoSynthesized;
  if (artifactWrites.length > 0) result.artifacts_updated = artifactWrites;

  // If end-drive skipped RE mode because user policy caps the tier, tell
  // the agent WHY close succeeded without a handoff.
  if (platform) {
    const platformForPolicy = platform;
    const applied = (session.declaredCapabilities ?? [])
      .map((d) => {
        const policy = loadCapabilityPolicyFull(platformForPolicy, d.capability);
        if (policy?.max_strategy_tier === 'recorded-path') {
          const reasonSuffix = policy.reason ? ` (reason: "${policy.reason}")` : '';
          return {
            capability: d.capability,
            source: 'user_policy' as const,
            ...(policy.reason ? { reason: policy.reason } : {}),
            retry_hint:
              `User policy caps ${platformForPolicy}/${d.capability} at recorded-path` +
              `${reasonSuffix}. Permanent — ` +
              `only the user/operator can clear via \`klura policy clear ${platformForPolicy} ${d.capability}\` ` +
              `or editing ~/.klura/skills/${platformForPolicy}/policy.json.`,
          };
        }
        return null;
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    if (applied.length > 0) result.prior_decline_applied = applied;
  }
  // Always surface diagnostics when synth ran — cheap, and critical for
  // debugging why auto-save produced nothing. Capped to 30 entries to stay
  // inside MCP budget on chatty sessions.
  if (synthDiag.length > 0) {
    result._diagnostics = {
      synth: synthDiag.slice(0, 30),
      declared_capabilities: (session.declaredCapabilities ?? []).map((d) => ({
        capability: d.capability,
        args: d.args,
      })),
    };
  }
  return result;
}

/** For each capability on the platform, find triaged surfaces whose
 *  URLs aren't covered by the saved strategy's endpoint or prereq URLs,
 *  and yield observed_capability inputs naming them. The triage plan is
 *  the agent's recognition that the surface exists; the absence of a
 *  matching saved strategy is the choice not to lift it. Together they
 *  fit `record_observed_capability`'s contract — agent saw it, agent
 *  didn't lift it.
 *
 *  Best-effort: any malformed plan or load failure yields zero entries
 *  for that capability rather than blocking close. */
function inferObservedCapabilitiesFromTriage(
  platform: string,
  sessionId: string,
): ObservedCapabilityInput[] {
  let logbook: ReturnType<typeof loadLogbook>;
  try {
    logbook = loadLogbook(platform);
  } catch {
    return [];
  }
  const out: ObservedCapabilityInput[] = [];
  const taken = new Set<string>();
  for (const cap of logbook.observed_capabilities) {
    if (typeof cap.name === 'string') taken.add(cap.name);
  }
  for (const [capabilityName, entry] of Object.entries(logbook.per_capability)) {
    const plansBySurface = entry.triage_plans_by_surface;
    if (!plansBySurface || typeof plansBySurface !== 'object') continue;
    let savedStrategyUrls: Set<string>;
    try {
      const strategies = skills.loadStrategies(platform, capabilityName);
      savedStrategyUrls = collectStrategyUrls(strategies);
    } catch {
      continue;
    }
    for (const [surfaceLabel, plan] of Object.entries(plansBySurface)) {
      if (typeof plan !== 'object') continue;
      const surfaceUrls: string[] = [];
      const obs = (plan as { observed_at_urls?: unknown }).observed_at_urls;
      if (Array.isArray(obs)) for (const u of obs) if (typeof u === 'string') surfaceUrls.push(u);
      const ds = (plan as { defense_surface?: unknown }).defense_surface;
      if (ds && typeof ds === 'object') {
        const reqs = (ds as { request_patterns?: unknown }).request_patterns;
        if (Array.isArray(reqs)) {
          for (const r of reqs) {
            if (typeof r !== 'string') continue;
            const tokens = r.trim().split(/\s+/);
            for (const t of tokens) {
              if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('/')) {
                surfaceUrls.push(t);
              }
            }
          }
        }
      }
      if (surfaceUrls.length === 0) continue;
      const covered = surfaceUrls.some((u) => urlMatchesAny(u, savedStrategyUrls));
      if (covered) continue;
      // Generate a slug from the surface_label. Surface labels like
      // `search`, `checkout` map to capability-shaped names.
      const name = surfaceLabel
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_');
      if (!name || taken.has(name)) continue;
      taken.add(name);
      out.push({
        name,
        evidence: {
          source: 'auto_inferred_triage_plan',
          capability: capabilityName,
          surface_label: surfaceLabel,
          urls: surfaceUrls.slice(0, 5),
        },
        why_not_lifted: 'triaged_not_lifted',
        session_id: sessionId,
      });
    }
  }
  return out;
}

/** Collect every URL the strategies for a capability touch — main
 *  endpoint plus any prereq URL. Used by triaged-not-lifted inference
 *  to decide whether a triaged surface is structurally part of an
 *  existing saved strategy or a sibling that wasn't lifted. */
function collectStrategyUrls(strategies: Array<Record<string, unknown>>): Set<string> {
  const urls = new Set<string>();
  for (const strat of strategies) {
    const baseUrl = strat.baseUrl;
    const endpoint = strat.endpoint;
    if (typeof baseUrl === 'string' && typeof endpoint === 'string') {
      try {
        urls.add(new URL(endpoint, baseUrl).toString());
      } catch {
        urls.add(`${baseUrl}${endpoint}`);
      }
    } else if (typeof endpoint === 'string') {
      urls.add(endpoint);
    }
    const prereqs = strat.prerequisites;
    if (Array.isArray(prereqs)) {
      for (const p of prereqs) {
        if (!p || typeof p !== 'object') continue;
        const u = (p as { url?: unknown }).url;
        if (typeof u === 'string') urls.add(u);
      }
    }
  }
  return urls;
}

/** Does `candidate` (URL or absolute path) hit any URL in `coveredUrls`?
 *  Compares origin+pathname; query strings and templates ignored.
 *  Tolerates relative candidates by checking pathname-only match. */
function urlMatchesAny(candidate: string, coveredUrls: Set<string>): boolean {
  const candidatePath = pathnameOf(candidate);
  if (!candidatePath) return false;
  for (const url of coveredUrls) {
    const coveredPath = pathnameOf(url);
    if (!coveredPath) continue;
    if (candidatePath === coveredPath) return true;
  }
  return false;
}

function pathnameOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    let p = u.pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  } catch {
    if (!rawUrl.startsWith('/')) return null;
    const q = rawUrl.indexOf('?');
    let p = q === -1 ? rawUrl : rawUrl.slice(0, q);
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }
}
