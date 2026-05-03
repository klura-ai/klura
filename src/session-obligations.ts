// Session obligations — a sticky reminder surfaced on tool responses when a
// session has performed mutating actions but hasn't yet entered LIFT
// (saved a strategy or called end_drive).
//
// Why it exists: nothing in klura previously prevented an agent from calling
// `start_session` + `perform_action(click submit)` and then ending its turn
// with `stop=end_turn`. That bypassed every LIFT protection because
// `end_drive`'s LIFT handoff, capability_declaration_required
// guard, and re_persistence_gate all fire only IF end_drive is called.
// This module makes the obligation visible on every tool response between the
// first mutation and either end_drive(ok) or save_strategy success.
//
// The obligation is NOT a Level-3 token gate — it fires once per session, so
// muscle-memory acks aren't a risk. It's an advisory field appended to tool
// responses; resolution happens via the existing end_drive flow (LIFT
// handoff → user consult → save OR third-call force-tear-down + auto-synth).
// See runtime/docs/gates.md for the once-vs-many criterion that drives this
// being Level-2-style.

import type { Session } from './drivers/types/session';
import { graphConfig } from './session-phase/registry';

/**
 * Action kinds that count as mutating — the agent intentionally changed
 * something on the site. `navigate` and `wait` are excluded (read-only).
 * `click` is included even though it's ambiguous (a click can be a read-only
 * link follow); false positives surface a LIFT prompt the agent can
 * decline via the existing end_drive third-call path. False negatives
 * leak sessions, which is the bug we're fixing.
 */
const MUTATING_ACTIONS = new Set(['click', 'type', 'fill_editor', 'key_press', 'select']);

export interface SessionObligation {
  kind: 'lift_required';
  session_id: string;
  mutating_actions: number;
  message: string;
}

/**
 * Returns the obligation for a session, or `null` if none.
 *
 * Obligation fires when ALL of:
 *   - session.liftMode !== 'skip'
 *   - performActionHistory contains ≥1 mutating action
 *   - no saved strategy exists for any declared capability since the last
 *     mutation (i.e., the most recent mutation has not been "covered" by a
 *     save)
 *
 * The "covered by save" check compares the timestamp of the most recent
 * mutation against the most recent save: if the save came AFTER the
 * mutation, the obligation is cleared. If a fresh mutation happens after a
 * save, the obligation re-fires.
 */
export function computeSessionObligation(session: Session): SessionObligation | null {
  if (session.liftMode === 'skip') return null;

  const history = session.performActionHistory ?? [];
  const mutations = history.filter((rec) => MUTATING_ACTIONS.has(rec.action));
  if (mutations.length === 0) return null;

  const lastMutation = mutations[mutations.length - 1];
  const lastMutationAt = lastMutation ? lastMutation.at : 0;
  const saves = session.savedCapabilities ?? [];
  const lastSave = saves.length > 0 ? saves[saves.length - 1] : null;
  const mostRecentSaveAt = lastSave ? lastSave.at : 0;
  if (mostRecentSaveAt > lastMutationAt) return null;

  // Flush-reminder shaping: surface-mapping graphs don't lift, don't enter
  // RE mode, and don't expect a save. The agent SHOULD keep exploring;
  // end_drive is the natural end-of-session, not the next step after each
  // mutation. Wording reflects "eventually" rather than "MUST be next call"
  // so the obligation reads as a flush reminder, not a roadblock. Re-emits
  // each mutation are fine: the cost is one extra sentence per response,
  // not a forced ack/close.
  if (graphConfig(session).obligationStyle === 'flush_reminder') {
    return {
      kind: 'lift_required',
      session_id: session.id,
      mutating_actions: mutations.length,
      message:
        `Session ${session.id} has performed ${mutations.length} mutating action(s) so far. ` +
        `Keep exploring as long as there's surface left to map. When you're done, call end_drive — ` +
        `end_drive flushes the runtime-collected surface map (url_graph nodes + forms_seen + ` +
        `observed_capabilities) into the platform logbook so the next session sees what this one mapped. ` +
        `It does NOT enter LIFT and does NOT expect a saved strategy. ` +
        `Ending the turn without end_drive drops every form you traversed and every page you navigated — ` +
        `even calls to record_observed_capability never reach the logbook unless end_drive flushes them.`,
    };
  }

  // Phase-aware messaging: the obligation prose changes based on where the
  // session is in the phase machine. Telling an agent in triage/lift to
  // "call end_drive next" contradicts the audit guidance they just got
  // back from save_strategy and makes them give up after a single audit
  // rejection. Drive → "call end_drive". Triage/lift → "iterate
  // save_strategy with audit_token + audit_answers until ok:true".
  const phase = session.phase ?? 'drive';

  if (phase === 'triage') {
    return {
      kind: 'lift_required',
      session_id: session.id,
      mutating_actions: mutations.length,
      message:
        `Session ${session.id} is in TRIAGE with no strategy saved. ` +
        `**DO NOT tell the user the task is complete.** A user-visible action through the viewer (or your own clicks) ` +
        `is NOT klura-task-complete — klura has persisted nothing, the next run starts from zero. ` +
        `Your next tool call MUST be \`submit_triage_plan\` (this response's \`triage_authoring_contract\` field has the schema). ` +
        `Once approved you enter LIFT, where \`save_strategy\` unlocks. Calling \`save_strategy\` directly in TRIAGE is hard-blocked. ` +
        `See klura://reference#triage.`,
    };
  }

  if (phase === 'lift') {
    return {
      kind: 'lift_required',
      session_id: session.id,
      mutating_actions: mutations.length,
      message:
        `Session ${session.id} is in LIFT with no strategy saved. ` +
        `**DO NOT tell the user the task is complete.** klura has persisted nothing — the next run starts from zero. ` +
        `Your next tool call MUST be \`save_strategy\`. If it returns \`save_strategy_rejected\`, ` +
        `re-call save_strategy WITH the returned \`audit_token\` plus \`audit_answers\` for any open items ` +
        `(don't end your turn after a rejection — the rejection IS the iteration loop, not a stop signal). ` +
        `In unattended runs, retry with just \`audit_token\` and the embedder's decider auto-resolves user_confirmation. ` +
        `Expect 1-3 retries before the save lands — that's normal. ` +
        `See klura://reference#save-strategy-audit.`,
    };
  }

  return {
    kind: 'lift_required',
    session_id: session.id,
    mutating_actions: mutations.length,
    message:
      `Session ${session.id} performed ${mutations.length} mutating action(s) ` +
      `(click/type/fill_editor/key_press/select) but no strategy has been saved. ` +
      `Your next tool call MUST be end_drive — that opens LIFT, where you save a reusable strategy ` +
      `for the declared capability. end_drive will not terminate the session until save_strategy ` +
      `lands; repeat calls return the same handoff. ` +
      `Do not end your turn yet. Ending now leaks session ${session.id} and forfeits LIFT. ` +
      `See klura://reference#reverse-engineer-playbook.`,
  };
}
