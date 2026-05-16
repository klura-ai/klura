// End-drive audit — second `Audit` instance, mirrors the save-strategy
// audit but operates at the session-tear-down decision point. Absorbs:
//
//   - capability_declaration_required (Detector, ackReason: 'none') — refuses
//     end_drive on attempts 1 and 2 when the session typed/submitted content but
//     never declared a capability. Agent fixes by calling declare_capability;
//     attempt 3 force-tears-down regardless (the orchestrator skips the audit
//     on attempt 3 to provide an escape hatch).
//
//   - save_attempted_none_landed (Detector, ackReason: 'none') — refuses
//     end_drive when at least one save_strategy attempt was made and zero
//     succeeded. Stops the legacy-form-post failure mode where the agent
//     gives up mid-recoverable-loop and end_drive papers over the silent
//     failure with whatever stale strategy was on disk.
//
//   - re_persistence (Detector, ackReason: 'none') — refuses end_drive when the
//     session did heavy reverse-engineering work (set_breakpoint / get_js_source /
//     search_js_source / read_js_function / evaluate_on_frame / full-body
//     get_network_log) with zero persistence calls AND that work isn't reflected
//     on disk (some declared capability is still unresolved, or none was declared).
//     `js_eval` alone never trips this — it's the everyday DOM-read / response-parse
//     tool, not an RE signal in isolation (it folds into the rejection message when
//     heavy RE is also present, but is not the trigger). Agent either persists
//     progress (retry clears the gate naturally — persistCallCount > 0) OR uses
//     `abort_session(reason)` as the honest exit when the work was misguided in the
//     first place. There is NO agent-authored ack escape: klura is
//     always-save-by-default and "I judged this as nothing worth persisting" isn't
//     the agent's verdict to make.
//
//   - triage_acknowledgment (Classifier, token-gated) — fires when end_drive
//     would otherwise skip triage entirely (every declared capability already
//     has a non-stale saved strategy, OR no triage handoff would fire). Triage
//     is mandatory — agent doesn't get to decide "this was a one-off task,
//     teardown without triage." Agent must either submit a triage_plan, or
//     echo {triage_acknowledgment: {acknowledged: true, reason: "<own words
//     explaining why no triage round was warranted, e.g. 'all capabilities
//     have a fetch-tier saved strategy and no graduation candidates surfaced'>"}}.
//     Token binds to {sessionId, declaredCapabilityCount, saveSuccessCount,
//     endDriveAttempts}.
//
// Same machinery as save-strategy-audit, different lifecycle. New
// end-drive concerns become one Detector or Classifier entry on this
// instance — runtime threads the token, formats the rejection, persists
// nothing (end-drive has no on-disk artifact equivalent to a strategy).

import { Audit, type Classifier, type Detector } from '../index';
import { graphFor } from '../../graphs';

export const RE_CALL_THRESHOLD = 2;
export const ACTION_CALL_THRESHOLD = 5;

/** Actions that mutate page state. Navigation, clicks on unknown elements,
 *  scrolls, screenshots don't count — a user might just be browsing. Exported
 *  for the auto-synth literal-resolver in
 *  runtime/src/strategies/synthesize-on-close/literals.ts. */
export const WRITE_SHAPED_ACTIONS = new Set(['type', 'fill_editor', 'fill', 'submit']);

export interface EndDrivePayload {
  sessionId: string;
  platform: string;
  endDriveAttempts: number;
  declaredCapabilityCount: number;
  writeActions: ReadonlyArray<{ action: string; value_preview?: string }>;
  /** Heavy reverse-engineering tool calls (set_breakpoint, get_js_source,
   *  search_js_source, read_js_function, evaluate_on_frame, full-body
   *  get_network_log). The re_persistence Detector's trigger count. */
  heavyReCallCount: number;
  /** js_eval calls. Reported alongside heavyReCallCount in the re_persistence
   *  rejection for context, but never the trigger on its own — js_eval is the
   *  everyday DOM-read / response-parse tool, not an RE signal in isolation. */
  jsEvalCallCount: number;
  persistCallCount: number;
  actionCallCount: number;
  /** Total save_strategy calls (success + thrown). Compared against
   *  savedCapabilityCount to detect "agent tried, never landed." */
  saveAttemptCount: number;
  /** Successful save_strategy persistences (entries on
   *  session.savedCapabilities). */
  saveSuccessCount: number;
  /** From the active graph's GraphConfig. When true, the
   *  capability_declaration_required detector short-circuits — surface-mapping
   *  graphs are allowed to land without declaring a capability. */
  skipDeclarationGuard: boolean;
  /** From the active graph's GraphConfig. The re_persistence Detector fires
   *  when `persistCallCount === 0`, not every declared capability has resolved
   *  (`declaredCapabilityCount === 0 || triageWouldFire`), AND EITHER
   *  `heavyReCallCount >= reCalls` (positive `reCalls`) OR
   *  `actionCallCount >= actions` (positive `actions` — the map-graph
   *  "mapped without persisting" trigger). Always set after
   *  buildEndDrivePayload (it supplies a fallback); the `undefined` branch in
   *  shouldRunRePersistence is defensive. */
  rePersistenceThreshold: { reCalls: number; actions: number } | undefined;
  /** Caller-computed: would the post-audit reverse-engineer handoff produce
   *  a non-null triage handoff? When false AND declaredCapabilityCount > 0,
   *  the triage_acknowledgment classifier fires — the runtime forces the
   *  agent to acknowledge that triage was considered even though the
   *  runtime would have skipped it. */
  triageWouldFire: boolean;
}

/** Empty by design — every payload field the audit needs is captured at
 *  payload-build time. The ctx slot exists for symmetry with
 *  save-strategy-audit (which uses it for live-session probes). */
export type EndDriveCtx = Record<string, never>;

// ---------- Detector: capability_declaration_required ----------

const declarationRequiredDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'capability_declaration_required',
  ackReason: 'none',
  detect: (p) => {
    // endDriveAttempts is read PRE-bump (orchestrator bumps on audit success,
    // not before). Pre-bump 0 = first call, 1 = second call, 2 = third
    // call (the force-tear-down attempt — guard releases). Same threshold
    // as the legacy `attempts > 2` post-bump check.
    if (p.endDriveAttempts >= 2) return [];
    if (p.declaredCapabilityCount > 0) return [];
    if (p.skipDeclarationGuard) return [];
    // Fire whenever the agent meaningfully drove the page (any
    // perform_action call) without declaring a capability. Read
    // capabilities deserve a save opportunity too: a fetch strategy for
    // the search XHR is the whole point of klura.
    if (p.actionCallCount === 0) return [];
    // Exploration-session exemption: the session has no declared
    // capability, no save attempt, and no write-shaped actions. The agent
    // navigated to look around and is closing — there is no RE artifact
    // to demand. Forcing a fake capability declaration here produces the
    // surface_triage_missing → unobserved_url deadlock with no path out.
    // Auto-synth still runs at the orchestrator layer and persists
    // anything it can derive; the audit just stops refusing close.
    // Mirrors the parallel exemption in computeSessionObligation
    // (session-obligations.ts).
    if (p.saveAttemptCount === 0 && p.writeActions.length === 0) return [];

    const writeActionsObserved = p.writeActions.length > 0;
    const previews = p.writeActions
      .slice(0, 5)
      .map((a) => (a.value_preview ? `${a.action}(${a.value_preview})` : a.action))
      .join(', ');
    const overflow = p.writeActions.length > 5 ? `, …+${p.writeActions.length - 5} more` : '';

    const observedClause = writeActionsObserved
      ? `Observed write actions (preview): ${previews}${overflow}.`
      : `Observed ${p.actionCallCount} \`perform_action\` call(s) (read-only navigation / clicks). ` +
        `Read capabilities deserve a save too — the captured XHRs the page made while you drove ` +
        `are the substrate for a fetch strategy that next callers warm-execute.`;

    return [
      {
        kind: 'capability_declaration_required',
        message:
          `CANNOT CLOSE: this session drove the UI but no capability was declared. ` +
          `Auto-save needs a capability slug to key under; without one, the session degrades to a ` +
          `keyless recorded-path that nobody can look up at warm execute. ${observedClause}`,
        hint:
          `Call declare_capability({session_id: "${p.sessionId}", capability: "<slug>", ` +
          `args: {...}}) before closing. Pick a slug matching the user's verb phrase ` +
          `(send_message, create_post, submit_form, search_<thing>, list_<thing>), and pass the ` +
          `user's arg values verbatim so auto-save can template them. A third close attempt will ` +
          `force-tear-down and drop the captured work.`,
        context: {
          session_id: p.sessionId,
          platform: p.platform,
          captured_write_actions: p.writeActions,
          action_call_count: p.actionCallCount,
          end_drive_attempts: p.endDriveAttempts,
        },
      },
    ];
  },
};

// ---------- Detector: save_attempted_none_landed ----------
//
// Refuses close when the agent called `save_strategy` at least once during
// the session AND no save succeeded. This is the legacy-form-post failure
// mode: the agent hits a recoverable audit rejection, can't break out of
// the loop, gives up, and `end_drive` would let the session close cleanly
// — but the strategy on disk is whatever was there before the run started
// (often a buggy strategy from a prior session). Future warm-execute
// reuses that stale strategy without ever flagging the silent failure.
//
// Same shape as `capability_declaration_required`: ackReason `'none'`
// (no acceptable ack — agent must save successfully or hit the third
// close attempt to force-tear-down). Releases at endDriveAttempts >= 2 to
// preserve the existing third-attempt escape hatch.

const saveAttemptedNoneLandedDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'save_attempted_none_landed',
  ackReason: 'none',
  detect: (p) => {
    if (p.endDriveAttempts >= 2) return [];
    if (p.saveAttemptCount === 0) return [];
    if (p.saveSuccessCount > 0) return [];
    return [
      {
        kind: 'save_attempted_none_landed',
        message:
          `CANNOT CLOSE: ${p.saveAttemptCount} save_strategy attempt(s) on this session, ` +
          `zero successful saves. Closing now would leave whatever strategy was on disk ` +
          `before this session in place — including buggy strategies from earlier runs that ` +
          `the agent's failed attempts here were trying to overwrite. Future warm execute ` +
          `would silently use the stale strategy.`,
        hint:
          `Read the most recent save_strategy rejection's error message and fix the strategy ` +
          `body / audit_answers before retrying. If the audit keeps rejecting on the same ` +
          `field after 2-3 attempts, the strategy itself has a structural issue: either ` +
          `re-shape it (different tier, different param classification) or persist what ` +
          `you have to the discovery_artifact (save_verified_expression / add_discovery_note ` +
          `/ add_resume_pointer) and let the next session pick up. A third close attempt ` +
          `will force-tear-down and the session's captures will be lost.`,
        context: {
          session_id: p.sessionId,
          platform: p.platform,
          save_attempt_count: p.saveAttemptCount,
          save_success_count: p.saveSuccessCount,
          end_drive_attempts: p.endDriveAttempts,
        },
      },
    ];
  },
};

// ---------- Detector: re_persistence ----------
//
// Refuses close when N RE tool calls have been made with zero persistence
// calls. ackReason: 'none' — there is NO agent-authored escape. Two valid
// next moves:
//   1. Persist progress via save_verified_expression / add_discovery_note /
//      add_resume_pointer; the gate clears naturally on retry
//      (persistCallCount > 0 → detector returns no issues).
//   2. Call `abort_session(session_id, reason)` — bypasses end_drive entirely.
//      The legitimate use case for "no save" is "this session shouldn't have
//      been driving in the first place"; abort_session is the honest exit.
//      "I judged this as nothing worth persisting" is NOT a legitimate
//      LLM-authored verdict — klura is always-save-by-default.

const rePersistenceDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 're_persistence',
  ackReason: 'none',
  detect: (p) => {
    if (!shouldRunRePersistence(p)) return [];
    const t = p.rePersistenceThreshold;
    const firedOnActions = !!t && t.actions > 0 && p.actionCallCount >= t.actions;
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
    const segments: string[] = [];
    if (firedOnActions) segments.push(plural(p.actionCallCount, 'perform_action call'));
    if (p.heavyReCallCount > 0) {
      const heavy = plural(p.heavyReCallCount, 'code-inspection / breakpoint call');
      segments.push(
        p.jsEvalCallCount > 0
          ? `${heavy} (plus ${plural(p.jsEvalCallCount, 'js_eval call')})`
          : heavy,
      );
    } else if (p.jsEvalCallCount > 0) {
      // Reached only via the actions branch — js_eval is context, not the trigger.
      segments.push(plural(p.jsEvalCallCount, 'js_eval call'));
    }
    const what = segments.join(' and ');
    return [
      {
        kind: 're_persistence',
        message:
          `CANNOT CLOSE: ${what} on session ${p.sessionId}, but zero persistence calls. ` +
          `Work that isn't persisted is invisible to the next session.`,
        hint:
          `Two valid next moves: ` +
          `(1) PERSIST: call save_verified_expression({expression, returns, ...}) for confirmed encoder ` +
          `expressions, add_discovery_note({body, kind?}) for prose breadcrumbs, or ` +
          `add_resume_pointer({kind, ref, ...}) for typed pointers (file:line, frame_index, ws_hash). ` +
          `Then retry end_drive — the gate clears naturally once persistCallCount > 0. ` +
          `(2) ABORT: if this session shouldn't have been driving in the first place ` +
          `(existing capability covers the task, user said abort, site dead), call ` +
          `abort_session(session_id, "<reason ≥20 chars>") for the honest exit. ` +
          `NOT legitimate: "I judged this as nothing worth saving" — klura is always-save-by-default ` +
          `and that judgment isn't yours to make.`,
        context: {
          session_id: p.sessionId,
          heavy_re_call_count: p.heavyReCallCount,
          js_eval_call_count: p.jsEvalCallCount,
          re_call_count: p.heavyReCallCount + p.jsEvalCallCount,
          persist_call_count: p.persistCallCount,
          action_call_count: p.actionCallCount,
        },
      },
    ];
  },
};

/**
 * The re_persistence Detector fires when this session did reverse-engineering
 * work that isn't reflected on disk and isn't being persisted on close.
 *
 * "Reflected on disk" = a saved strategy. When every declared capability
 * resolved to a non-stale saved strategy the runtime would skip the triage
 * handoff (`triageWouldFire === false`), so the session's RE work is baked
 * into those strategies — nothing is orphaned. (Same predicate the
 * triage_acknowledgment classifier reads for the "all saved" case. Known,
 * accepted gap: speculative graduation RE done in a session that *also*
 * landed a recorded-path slips through — that work should be persisted
 * voluntarily via add_discovery_note / save_verified_expression, and the
 * triage round is the place for it.) A session with NO declared capability
 * (pure exploration / lookup) is NOT exempted: poking the bundle and bailing
 * still owes a breadcrumb.
 *
 * The trigger count is `heavyReCallCount` — code-inspection / breakpoint /
 * frame-eval / full-network-read calls. `js_eval` alone never trips this:
 * it's the everyday DOM-read / response-parse tool, and any RE flow worth
 * persisting first has to *find* the code (a heavy tool). The map graph's
 * `actions` threshold is independent — a mapping session that touched N pages
 * without persisting fires regardless of RE calls.
 */
function shouldRunRePersistence(p: EndDrivePayload): boolean {
  if (p.persistCallCount > 0) return false;
  // A landed saved strategy is itself a persistence artifact — the most
  // concrete one. In map-graph sessions that lift one capability and leave
  // others observed-but-unlifted, the triage handoff would still fire on
  // the unlifted slugs, so the older `!triageWouldFire` check below alone
  // wouldn't clear this gate. But the agent shipped real work; demanding
  // breadcrumbs on top is friction.
  if (p.saveSuccessCount > 0) return false;
  const t = p.rePersistenceThreshold;
  if (!t) return false;
  if (p.declaredCapabilityCount > 0 && !p.triageWouldFire) return false;
  if (t.reCalls > 0 && p.heavyReCallCount >= t.reCalls) return true;
  if (t.actions > 0 && p.actionCallCount >= t.actions) return true;
  return false;
}

// ---------- Classifier: triage_acknowledgment ----------

const TRIAGE_ACK_MIN_REASON_LENGTH = 20;

const triageAcknowledgmentClassifier: Classifier<EndDrivePayload, EndDriveCtx, unknown> = {
  kind: 'triage_acknowledgment',
  expectedAnswerShape:
    'triage_acknowledgment: {acknowledged: true, reason: "<your own words explaining why this session does not warrant a triage round, e.g. \'all declared capabilities have a fetch-tier saved strategy and the captures showed no graduation candidates\'>"}',
  buildItems: (p) => {
    if (!shouldRunTriageAcknowledgment(p)) return null;
    return {
      session_id: p.sessionId,
      declared_capability_count: p.declaredCapabilityCount,
      saved_capability_count: p.saveSuccessCount,
      prompt:
        `end_drive ALWAYS goes through triage. Every declared capability on this session is ` +
        `already saved (no unresolved work, no stale strategies), so the runtime would skip the ` +
        `triage handoff — but triage is the runtime-mandated review point. The agent does not ` +
        `get to decide "this was a one-off task, no triage needed." Echo the audit_token + ` +
        `acknowledge with a non-trivial reason explaining why no further triage is warranted ` +
        `(e.g. "all declared caps are saved at fetch tier, no graduation candidate observed in ` +
        `captures"). NOTE: submit_triage_plan is admissible from drive only when work is still ` +
        `unresolved — when it would route to lift after end_drive. In this all-saved case the ` +
        `audit's only forward path is the ack; observed_capabilities and defense-surface metadata ` +
        `from any triage_plans you submitted earlier this session are auto-recorded by the ` +
        `runtime when end_drive commits.`,
      acknowledge_shape:
        '{triage_acknowledgment: {acknowledged: true, reason: "<your reason, ≥20 chars>"}}',
    };
  },
  validate: (_p, _ctx, answer) => {
    if (typeof answer !== 'object' || answer === null) {
      return [
        `triage_acknowledgment answer must be an object — got ${typeof answer}. ` +
          `Echo {acknowledged: true, reason: "<own words>"} after considering whether triage was warranted.`,
      ];
    }
    const a = answer as { acknowledged?: unknown; reason?: unknown };
    if (a.acknowledged !== true) {
      return [
        `triage_acknowledgment.acknowledged must be \`true\` — explicit assent that you considered ` +
          `triage and chose to skip. Anything else means you have not made the choice consciously.`,
      ];
    }
    if (typeof a.reason !== 'string' || a.reason.trim().length < TRIAGE_ACK_MIN_REASON_LENGTH) {
      return [
        `triage_acknowledgment.reason must be a non-trivial string (≥${TRIAGE_ACK_MIN_REASON_LENGTH} chars) ` +
          `explaining in your own words why this session does not warrant a triage round. ` +
          `Canned answers ("ok", "done", "no triage") do not satisfy.`,
      ];
    }
    return [];
  },
  hashFields: (p) => ({
    sessionId: p.sessionId,
    declaredCapabilityCount: p.declaredCapabilityCount,
    saveSuccessCount: p.saveSuccessCount,
    endDriveAttempts: p.endDriveAttempts,
  }),
  remedy: () => ({
    kind: 'classification_options',
    options: [
      {
        choice: '{triage_acknowledgment: {acknowledged: true, reason: "<own words>"}}',
        rationale:
          'explicit no-triage acknowledgment with a reason a future reader can audit (e.g. "all caps fetch-tier, no graduation candidate observed in captures"). This is the ONLY achievable forward path from this audit moment: submit_triage_plan is admissibility-blocked from drive phase, and after the ack lands the session closes (when triageWouldFire is false there is no LIFT phase to enter). Triage metadata you want to persist for future sessions should have been submitted via submit_triage_plan BEFORE end_drive — the runtime auto-records observed_capabilities and defense-surface notes from those plans when this audit commits.',
      },
    ],
  }),
};

function shouldRunTriageAcknowledgment(p: EndDrivePayload): boolean {
  // Third-attempt force-tear-down releases every gate, mirroring
  // declaration_required / save_attempted_none_landed.
  if (p.endDriveAttempts >= 2) return false;
  // No declared capability → triage has nothing to review structurally.
  if (p.declaredCapabilityCount === 0) return false;
  // Triage handoff will fire — that path already routes the agent into triage,
  // no need for an additional gate.
  if (p.triageWouldFire) return false;
  return true;
}

// ---------- The audit instance ----------

export const endDriveAudit = new Audit<EndDrivePayload, EndDriveCtx>({
  kind: 'end_drive',
  detectors: [declarationRequiredDetector, saveAttemptedNoneLandedDetector, rePersistenceDetector],
  classifiers: [triageAcknowledgmentClassifier],
});

// ---------- Helpers for orchestrator-side payload assembly ----------

interface SessionLike {
  id: string;
  platform?: string;
  graph?: import('../../phases/types').GraphName;
  endDriveAttempts?: number;
  declaredCapabilities?: ReadonlyArray<unknown>;
  performActionHistory?: ReadonlyArray<{ action?: string; value?: unknown }>;
  saveAttemptCount?: number;
  savedCapabilities?: ReadonlyArray<unknown>;
}

/**
 * Walk session.performActionHistory and pluck the write-shaped actions the
 * declaration-required detector consumes. Pure projection — no driver, no
 * pool. Mirrors the legacy collectWriteShapedActions helper.
 */
export function collectWriteActions(
  session: SessionLike,
): Array<{ action: string; value_preview?: string }> {
  const out: Array<{ action: string; value_preview?: string }> = [];
  const history = session.performActionHistory ?? [];
  for (const record of history) {
    const action = record.action;
    if (typeof action !== 'string' || !WRITE_SHAPED_ACTIONS.has(action)) continue;
    const rawValue = record.value;
    let value_preview: string | undefined;
    if (typeof rawValue === 'string' && rawValue.length > 0) {
      value_preview = rawValue.length > 60 ? `${rawValue.slice(0, 60)}…` : rawValue;
    }
    out.push(value_preview ? { action, value_preview } : { action });
  }
  return out;
}

/**
 * Build the end-drive audit payload from a Session + caller-supplied
 * counts (heavyReCallCount, jsEvalCallCount, persistCallCount,
 * actionCallCount). Pure, testable; no side effects.
 *
 * `triageWouldFire` is computed by the orchestrator just before this call
 * (see `wouldReverseEngineerHandoffFire` in end-drive/re-handoff.ts) — the
 * triage_acknowledgment classifier reads it to decide whether to require an
 * explicit ack token from the agent, and the re_persistence detector reads it
 * to decide whether the session's RE work is already reflected in saved
 * strategies.
 */
export function buildEndDrivePayload(
  session: SessionLike,
  counts: {
    heavyReCallCount: number;
    jsEvalCallCount: number;
    persistCallCount: number;
    actionCallCount: number;
  },
  opts: { platform?: string; triageWouldFire: boolean },
): EndDrivePayload {
  // Resolve graph config locally so the payload stays self-contained — the
  // payload is the contract between the orchestrator and the audit detectors,
  // and detectors should never reach back into runtime state.
  const graph = graphFor(session.graph ?? 'discover');
  const cfg = graph.config;
  return {
    sessionId: session.id,
    platform: opts.platform ?? session.platform ?? '<platform>',
    endDriveAttempts: session.endDriveAttempts ?? 0,
    declaredCapabilityCount: (session.declaredCapabilities ?? []).length,
    writeActions: collectWriteActions(session),
    heavyReCallCount: counts.heavyReCallCount,
    jsEvalCallCount: counts.jsEvalCallCount,
    persistCallCount: counts.persistCallCount,
    actionCallCount: counts.actionCallCount,
    saveAttemptCount: session.saveAttemptCount ?? 0,
    saveSuccessCount: (session.savedCapabilities ?? []).length,
    skipDeclarationGuard: cfg.skipDeclarationGuard === true,
    // Fallback for graphs that don't set rePersistenceThreshold; both shipped
    // graphs (discover, map) override it. Assembled here so detectors see a
    // consistent payload shape regardless of graph.
    rePersistenceThreshold: cfg.rePersistenceThreshold ?? {
      reCalls: RE_CALL_THRESHOLD,
      actions: 0,
    },
    triageWouldFire: opts.triageWouldFire,
  };
}
