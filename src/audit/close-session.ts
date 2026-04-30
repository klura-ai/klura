// Close-session audit — second `Audit` instance, mirrors the save-strategy
// audit but operates at the session-tear-down decision point. Absorbs:
//
//   - capability_declaration_required (Detector, ackReason: 'none') — refuses
//     close on attempts 1 and 2 when the session typed/submitted content but
//     never declared a capability. Agent fixes by calling declare_capability;
//     attempt 3 force-tears-down regardless (the orchestrator skips the audit
//     on attempt 3 to provide an escape hatch).
//
//   - re_persistence (Classifier, token-gated) — refuses close when N RE
//     tool calls have been made with zero persistence calls. Agent either
//     persists progress (retry naturally clears the gate) or echoes the
//     audit_token via answers.re_persistence: { acknowledge_no_progress: true }.
//     Token binds to {sessionId, reCallCount, persistCallCount, intent} so
//     the gate re-arms on subsequent close attempts after fresh RE work.
//
// Same machinery as save-strategy-audit, different lifecycle. New
// close-session concerns become one Detector or Classifier entry on this
// instance — runtime threads the token, formats the rejection, persists
// nothing (close-session has no on-disk artifact equivalent to a strategy).

import { Audit, type Classifier, type Detector } from './index';
import { graphFor } from '../session-phase/graphs';

export const RE_CALL_THRESHOLD = 2;
export const ACTION_CALL_THRESHOLD = 5;

/** Actions that mutate page state. Navigation, clicks on unknown elements,
 *  scrolls, screenshots don't count — a user might just be browsing. Exported
 *  for the auto-synth literal-resolver in
 *  runtime/src/strategies/synthesize-on-close/literals.ts. */
export const WRITE_SHAPED_ACTIONS = new Set(['type', 'fill_editor', 'fill', 'submit']);

export interface CloseSessionPayload {
  sessionId: string;
  platform: string;
  liftMode: 'skip' | 'explicit_learn' | undefined;
  closeAttempts: number;
  declaredCapabilityCount: number;
  writeActions: ReadonlyArray<{ action: string; value_preview?: string }>;
  reCallCount: number;
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
  /** From the active graph's GraphConfig. When set, the re_persistence
   *  classifier fires when EITHER `reCallCount >= reCalls` (positive) OR
   *  `actionCallCount >= actions` (positive) AND `persistCallCount === 0`.
   *  When undefined, the classifier never fires. */
  rePersistenceThreshold: { reCalls: number; actions: number } | undefined;
}

/** Empty by design — every payload field the audit needs is captured at
 *  payload-build time. The ctx slot exists for symmetry with
 *  save-strategy-audit (which uses it for live-session probes). */
export type CloseSessionCtx = Record<string, never>;

// ---------- Detector: capability_declaration_required ----------

const declarationRequiredDetector: Detector<CloseSessionPayload, CloseSessionCtx> = {
  kind: 'capability_declaration_required',
  ackReason: 'none',
  detect: (p) => {
    // closeAttempts is read PRE-bump (orchestrator bumps on audit success,
    // not before). Pre-bump 0 = first call, 1 = second call, 2 = third
    // call (the force-tear-down attempt — guard releases). Same threshold
    // as the legacy `attempts > 2` post-bump check.
    if (p.closeAttempts >= 2) return [];
    if (p.declaredCapabilityCount > 0) return [];
    if (p.liftMode === 'skip') return [];
    if (p.skipDeclarationGuard) return [];
    // Fire whenever the agent meaningfully drove the page (any
    // perform_action call) without declaring a capability. Previous
    // behavior gated on write-shaped actions (type / fill / submit) only —
    // that missed the read-only case where the agent typed nothing,
    // navigated to a query-bearing URL or clicked a result, and then
    // closed cleanly. The benchmark recorded "no save" for those reads
    // because end_drive resolved with no unresolved capabilities. Read
    // capabilities deserve a save opportunity too: a fetch strategy for
    // the search XHR is the whole point of klura.
    if (p.actionCallCount === 0) return [];

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
          close_attempts: p.closeAttempts,
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
// close attempt to force-tear-down). Releases at closeAttempts >= 2 to
// preserve the existing third-attempt escape hatch.

const saveAttemptedNoneLandedDetector: Detector<CloseSessionPayload, CloseSessionCtx> = {
  kind: 'save_attempted_none_landed',
  ackReason: 'none',
  detect: (p) => {
    if (p.closeAttempts >= 2) return [];
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
          close_attempts: p.closeAttempts,
        },
      },
    ];
  },
};

// ---------- Classifier: re_persistence ----------

const rePersistenceClassifier: Classifier<CloseSessionPayload, CloseSessionCtx, unknown> = {
  kind: 're_persistence',
  expectedAnswerShape:
    're_persistence: {acknowledge_no_progress: true} (only when there is genuinely nothing to persist; otherwise call save_verified_expression / add_discovery_note / add_resume_pointer first and the gate clears naturally without an answer)',
  buildItems: (p) => {
    if (!shouldRunRePersistence(p)) return null;
    const actionLine =
      p.rePersistenceThreshold && p.rePersistenceThreshold.actions > 0
        ? `${p.actionCallCount} perform_actions and `
        : '';
    return {
      session_id: p.sessionId,
      re_call_count: p.reCallCount,
      persist_call_count: p.persistCallCount,
      action_call_count: p.actionCallCount,
      prompt:
        `${actionLine}${p.reCallCount} RE tool calls made, but zero persistence calls. ` +
        `Work that isn't persisted is invisible to the next session.`,
      persist_via: [
        'save_verified_expression({expression, value_shape, value?, notes?})',
        'add_discovery_note({body, refs?})',
        'add_resume_pointer({ref, note?})',
      ],
      acknowledge_shape:
        '{re_persistence: {acknowledge_no_progress: true}} — only when there is genuinely nothing to persist',
    };
  },
  validate: (_p, _ctx, answer) => {
    if (typeof answer !== 'object' || answer === null) {
      return [
        `re_persistence answer must be an object — got ${typeof answer}. ` +
          `Either persist progress and retry (no answer needed; gate clears once persistCallCount > 0), ` +
          `or echo {acknowledge_no_progress: true} to ack no progress.`,
      ];
    }
    if ((answer as { acknowledge_no_progress?: unknown }).acknowledge_no_progress !== true) {
      return [
        `re_persistence.acknowledge_no_progress must be \`true\` — only when there is genuinely ` +
          `nothing to persist. Otherwise persist via save_verified_expression / add_discovery_note ` +
          `/ add_resume_pointer and retry close_session.`,
      ];
    }
    return [];
  },
  hashFields: (p) => ({
    sessionId: p.sessionId,
    reCallCount: p.reCallCount,
    persistCallCount: p.persistCallCount,
    actionCallCount: p.actionCallCount,
  }),
  remedy: () => ({
    kind: 'classification_options',
    options: [
      {
        choice: 'save_verified_expression({expression, value_shape, value?, notes?})',
        rationale:
          'an RE finding the next session can replay verbatim — the JS expression you confirmed produces the right value, with its observed shape',
      },
      {
        choice: 'add_discovery_note({body, refs?})',
        rationale:
          'free-form prose breadcrumbs (open questions, dead ends, leads worth chasing) the next session reads before driving',
      },
      {
        choice: 'add_resume_pointer({ref, note?})',
        rationale:
          'a typed pointer (file:line, frame index, ws_hash) the next session can jump straight to without re-locating',
      },
      {
        choice: '{re_persistence: {acknowledge_no_progress: true}}',
        rationale:
          'self-attest there is genuinely nothing to persist — only when the RE work yielded zero structural findings worth saving',
      },
    ],
  }),
};

function shouldRunRePersistence(p: CloseSessionPayload): boolean {
  if (p.persistCallCount > 0) return false;
  const t = p.rePersistenceThreshold;
  if (!t) return false;
  if (t.reCalls > 0 && p.reCallCount >= t.reCalls) return true;
  if (t.actions > 0 && p.actionCallCount >= t.actions) return true;
  return false;
}

// ---------- The audit instance ----------

export const closeSessionAudit = new Audit<CloseSessionPayload, CloseSessionCtx>({
  kind: 'close_session',
  detectors: [declarationRequiredDetector, saveAttemptedNoneLandedDetector],
  classifiers: [rePersistenceClassifier],
});

// ---------- Helpers for orchestrator-side payload assembly ----------

interface SessionLike {
  id: string;
  platform?: string;
  graph?: import('../session-phase/types').GraphName;
  liftMode?: 'skip' | 'explicit_learn';
  closeAttempts?: number;
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
 * Build the close-session audit payload from a Session + caller-supplied
 * counts (reCallCount, persistCallCount, actionCallCount). Pure, testable;
 * no side effects.
 */
export function buildCloseSessionPayload(
  session: SessionLike,
  counts: { reCallCount: number; persistCallCount: number; actionCallCount: number },
  opts: { platform?: string },
): CloseSessionPayload {
  // Resolve graph config locally so the payload stays self-contained — the
  // payload is the contract between the orchestrator and the audit detectors,
  // and detectors should never reach back into runtime state.
  const graph = graphFor(session.graph ?? 'discover');
  const cfg = graph.config;
  return {
    sessionId: session.id,
    platform: opts.platform ?? session.platform ?? '<platform>',
    liftMode: session.liftMode,
    closeAttempts: session.closeAttempts ?? 0,
    declaredCapabilityCount: (session.declaredCapabilities ?? []).length,
    writeActions: collectWriteActions(session),
    reCallCount: counts.reCallCount,
    persistCallCount: counts.persistCallCount,
    actionCallCount: counts.actionCallCount,
    saveAttemptCount: session.saveAttemptCount ?? 0,
    saveSuccessCount: (session.savedCapabilities ?? []).length,
    skipDeclarationGuard: cfg.skipDeclarationGuard === true,
    // Default discover graph keeps the legacy reCalls=3 threshold even though
    // the graph definition doesn't set it; assemble a default here so detectors
    // see a consistent payload shape regardless of graph.
    rePersistenceThreshold: cfg.rePersistenceThreshold ?? {
      reCalls: RE_CALL_THRESHOLD,
      actions: 0,
    },
  };
}
