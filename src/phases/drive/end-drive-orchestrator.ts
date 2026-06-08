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
  appendAckedNoiseEndpoints,
} from '../../working-dir/logbook';
import { inferObservedCapabilitiesFromGraph } from '../../working-dir/url-graph';
import { deleteJournal } from '../../working-dir/capture-journal';
import { buildSessionSummary, countPerformActionCalls } from './session-summary';
import { inferObservedCapabilitiesFromTriage } from './triage-inference';
import { buildCaptureEvents } from './build-capture-events';
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

/**
 * Adapter between the live agent-driven session and the working-dir's
 * CaptureEvent stream. Runs at end_drive. Pulls the driver-held network log +
 * WS frames, hands them with the session to `buildCaptureEvents` (the single
 * reshape shared with the capture-journal checkpoint), and folds the result via
 * `ingestCaptureEvents`. This is the ONLY place session/pool state touches
 * runtime/src/working-dir/ at close — the working-dir modules accept the
 * capture-event stream and know nothing about live sessions.
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

  const events = buildCaptureEvents(session, requests, wsFrames, autoSynthesized);

  ingestCaptureEvents(platform, sessionId, events);
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
    /** Acks for Detector-emitted warnings (kind → reason). */
    acks?: Record<string, string>;
  } = {},
  ctx: { progress?: (params: { stage: string }) => void } = {},
): Promise<
  | { ok: true; auto_synthesized?: SynthLedgerEntry[]; already_closed?: boolean }
  | NonNullable<ReturnType<typeof computeReverseEngineerHandoff>>
  | EndDriveAuditRejection
> {
  const progress = ctx.progress ?? ((): void => {});
  const session = pool.getSession(sessionId);

  // Idempotent on an already-closed session: the warm fast-path auto-closes the
  // session, then the auto-execute success hint tells the agent to call
  // end_drive. The audit/synth already ran on the original close, so re-running
  // it would be wrong (and would expect a strategy that's already committed).
  // Return a clean no-op instead of rejecting a tool the runtime told the agent
  // to call. (registry.checkAdmissibility lets end_drive through when closed.)
  if (session.status === 'closed') {
    return { ok: true, already_closed: true };
  }

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
      const inferred = inferObservedCapabilitiesFromTriage(platform);
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
      acks: opts.acks,
    },
  );
  if (auditResult.status === 'rejected') {
    return {
      ok: false,
      phase: 'end_drive_audit',
      session_id: sessionId,
      message: rejectionToErrorMessage('end_drive', auditResult.rejection, {
        toolName: 'end_drive',
      }),
      re_call_count: heavyReCallCount + jsEvalCallCount,
      persist_call_count: persistCallCount,
      end_drive_attempts: session.endDriveAttempts ?? 0,
    };
  }

  session.endDriveAttempts = (session.endDriveAttempts ?? 0) + 1;

  // The unsaved_xhr_endpoints gate cleared — if the agent acked some paths as
  // noise, persist them per platform so future sessions don't re-prompt for the
  // same telemetry. Only paths the agent named verbatim in the ack reason are
  // suppressed (matches the detector's anti-canned naming requirement); unnamed
  // paths re-surface next session.
  if (platform) {
    const noiseAck = opts.acks?.unsaved_xhr_endpoints;
    if (typeof noiseAck === 'string' && noiseAck.length > 0) {
      const acked = (auditPayload.unsavedHotXhrEndpoints ?? [])
        .map((e) => e.urlPath)
        .filter((urlPath) => noiseAck.includes(urlPath));
      if (acked.length > 0) appendAckedNoiseEndpoints(platform, acked);
    }
  }

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

  // No-silent-close guard. klura is always-save-by-default: a session with a
  // genuinely unresolved declared capability must not close having persisted
  // nothing. The guard fires when `triageWouldFire` is true — some declared
  // capability has no non-stale saved strategy on disk and isn't user-capped —
  // AND the agent saved nothing manually AND auto-synth derived no fallback.
  // The agent must save manually, retry to give auto-synth more captures, or
  // call `abort_session(reason)` for the honest exit. When `triageWouldFire` is
  // false every declared capability is already resolved on disk, so closing
  // leaves a valid strategy behind — the guard stays silent and the session
  // closes (e.g. a warm session that re-drove a capability it already has). The
  // third end_drive attempt force-tears-down regardless, an escape hatch for
  // genuinely stuck sessions.
  const skipAutoSynthForGuard = graphConfig(session).skipAutoSynth;
  const saveSuccessCount = (session.savedCapabilities ?? []).length;
  const endDriveAttemptsPreBump = session.endDriveAttempts ?? 1; // we bumped above
  if (
    !skipAutoSynthForGuard &&
    triageWouldFire &&
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
        `isn't yours to make.`,
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
          // No session_id: these are runtime-derived nav/form breadcrumbs
          // (`view_*`, form_post), not agent-made observations. They persist
          // to the logbook for the next session's candidate list, but must not
          // bump the per-session observed map — otherwise nav-noise like
          // `view_index_js` / `view_sitemap_xml` floods
          // session_summary.observed_unlifted_this_session, diluting the
          // genuine under-saving signal (only agent `record_observed_capability`
          // calls belong there). Mirrors inferObservedCapabilitiesFromTriage.
          recordObservedCapability(platform, {
            name: entry.name,
            evidence: entry.evidence,
            why_not_lifted: entry.why_not_lifted,
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
    // The clean-close fold above is authoritative and complete, so the
    // durability journal is now redundant. Drop it so orphan-recovery on a
    // later start_session never re-folds a session that closed cleanly.
    deleteJournal(session.id);
  }

  // session_summary: verbatim ground truth for the agent's retrospective.
  // Without this the retro is reconstructed from list_platform_skills + the
  // logbook + recent_aborts — all of which mix prior-session state into
  // this-session prose. Agents quote `recent_aborts[*].reason` strings as
  // "tested this session", inflating the abort ledger with fabricated path
  // coverage that future sessions then paraphrase. Each field below is
  // observable from session state only. Built BEFORE the teardown clears
  // below: observed_unlifted_this_session reads the per-session observed-
  // names map that clearObservedSessionTracking wipes.
  const sessionSummary = buildSessionSummary(
    session,
    autoSynthesized,
    countPerformActionCalls(session),
  );

  await pool.endDrive(sessionId);
  clearStartersForSession(sessionId);
  clearSessionObservations(sessionId);
  clearObservedSessionTracking(sessionId);

  const result: {
    ok: true;
    session_summary: typeof sessionSummary;
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
  } = { ok: true, session_summary: sessionSummary };
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
