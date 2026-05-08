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
//
// Honest framing: the prose names "before ending your turn" rather than
// "next tool call MUST be X" because perform_action and read tools are still
// admissible mid-drive — claiming the literal next call MUST be end_drive
// trains agents to read klura's MUST claims as advisory, devaluing the
// structurally-true MUSTs in checkpoint / interruption gates.

import type { Session } from './drivers/types/session';
import { graphConfig } from './phases/registry';

/**
 * Action kinds that count as mutating — the agent intentionally changed
 * something on the site. `navigate` and `wait` are excluded (read-only).
 * `click` is included even though it's ambiguous (a click can be a read-only
 * link follow); the nav-only-click filter below demotes clicks that landed
 * a real browser navigation into the navigation bucket.
 */
const MUTATING_ACTIONS = new Set(['click', 'type', 'fill_editor', 'key_press', 'select']);

/**
 * Write-shaped actions: typing text into a field is a strong commitment
 * signal even without a declared capability. Used to gate the exploration
 * exemption — clicks (including select / key_press, which are navigation-
 * shaped) allow the exemption; once the agent typed, they committed and the
 * runtime nudges to declare a capability.
 */
const WRITE_ACTIONS = new Set(['type', 'fill_editor']);

/**
 * Navigation channels that demote a preceding click from "mutation" to
 * "navigation". A click that lands a `submit`-shaped nav (form post →
 * redirect) IS a mutation regardless; a click that triggers a `pushState`
 * route change or a top-nav link follow is not.
 */
const NAV_ONLY_VIAS = new Set(['click', 'pushState', 'replaceState', 'popstate', 'hashchange']);

/** Window after a click within which a nav must land to count as caused by
 *  that click. Beyond this, the nav was caused by a later action. */
const NAV_FILTER_WINDOW_MS = 1500;

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
 *   - performActionHistory contains ≥1 mutating action (after demoting
 *     nav-only clicks via the dom-navigation correlation window)
 *   - The session shows commitment to RE: at least one of declaredCapabilities
 *     is non-empty, saveAttemptCount > 0, OR a write-shaped action occurred.
 *     Pure click-only exploration with no declared capability is research,
 *     not RE — the obligation is silent.
 *   - No saved strategy exists for any declared capability since the last
 *     mutation (i.e., the most recent mutation has not been "covered" by a
 *     save). If a fresh mutation happens after a save, the obligation
 *     re-fires.
 */
export function computeSessionObligation(session: Session): SessionObligation | null {
  const history = session.performActionHistory ?? [];
  const domNavs = session.domNavigations ?? [];

  // Nav-only click filter: a click followed within NAV_FILTER_WINDOW_MS by
  // a navigation event with a nav-only `via` (top-nav link, SPA route) is a
  // navigation, not a mutation. via:'submit' counts as mutation regardless
  // of any subsequent navigation.
  const isNavOnlyClick = (rec: { action: string; at: number }): boolean => {
    if (rec.action !== 'click') return false;
    return domNavs.some(
      (n) =>
        typeof n.at === 'number' &&
        n.at >= rec.at &&
        n.at <= rec.at + NAV_FILTER_WINDOW_MS &&
        n.via !== undefined &&
        NAV_ONLY_VIAS.has(n.via),
    );
  };

  const mutations = history.filter(
    (rec) => MUTATING_ACTIONS.has(rec.action) && !isNavOnlyClick(rec),
  );
  if (mutations.length === 0) return null;

  // Exploration exemption: a session with no declared capability, no save
  // attempts, and no write-shaped actions is research, not RE — the agent
  // is navigating to look around. Forcing a fake capability declaration
  // here produces the surface_triage_missing → unobserved_url deadlock with
  // no path out. Mirrors the parallel exemption in audit/drive/end-drive.ts.
  const declared = session.declaredCapabilities ?? [];
  const saveAttempts = session.saveAttemptCount ?? 0;
  const writeActionCount = mutations.filter((rec) => WRITE_ACTIONS.has(rec.action)).length;
  if (declared.length === 0 && saveAttempts === 0 && writeActionCount === 0) {
    return null;
  }

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
  // so the obligation reads as a flush reminder, not a roadblock.
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
  // rejection.
  const phase = session.phase ?? 'drive';

  if (phase === 'triage') {
    return {
      kind: 'lift_required',
      session_id: session.id,
      mutating_actions: mutations.length,
      message:
        `Session ${session.id} is in TRIAGE with no strategy saved. ` +
        `Do not tell the user the task is complete — klura has persisted nothing, the next run starts from zero. ` +
        `Before ending your turn, call \`submit_triage_plan\` ` +
        `(this response's \`triage_authoring_contract\` field has the schema). ` +
        `Once approved you enter LIFT, where \`save_strategy\` unlocks. ` +
        `Calling \`save_strategy\` directly in TRIAGE is hard-blocked. ` +
        `${ABORT_SESSION_HINT} ` +
        `Do not end your turn yet. ` +
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
        `Do not tell the user the task is complete — klura has persisted nothing, the next run starts from zero. ` +
        `Before ending your turn, call \`save_strategy\`. ` +
        `If it returns \`save_strategy_rejected\`, re-call save_strategy WITH the returned \`audit_token\` plus ` +
        `\`audit_answers\` for any open items — the rejection IS the iteration loop, not a stop signal. ` +
        `In unattended runs, retry with just \`audit_token\` and the embedder's decider auto-resolves user_confirmation. ` +
        `Expect 1-3 retries before the save lands — that's normal. ` +
        `${ABORT_SESSION_HINT} ` +
        `Do not end your turn yet. ` +
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
      `Do not tell the user the task is complete — klura has persisted nothing, the next run starts from zero. ` +
      `Keep driving via \`perform_action\` and reads as needed. ` +
      `Before ending your turn, call \`end_drive\` — ` +
      `that opens LIFT, where you save a reusable strategy for the declared capability. ` +
      `end_drive will not terminate the session until save_strategy lands; repeat calls return the same handoff. ` +
      `${ABORT_SESSION_HINT} ` +
      `Do not end your turn yet. Ending now leaks session ${session.id} and forfeits LIFT. ` +
      `See klura://reference#reverse-engineer-playbook.`,
  };
}

/** Honest-exit hint appended to every active obligation message. klura is
 *  always-save-by-default; the LLM does NOT get to unilaterally decide
 *  "this is one-off, no save needed" — that judgment isn't the agent's to
 *  make. The legitimate non-save exit is `abort_session` with one of the
 *  named reasons (existing capability covers this, user said stop, site
 *  dead). See memory/feedback_klura_always_save_default.md. */
const ABORT_SESSION_HINT =
  `If this session shouldn't have started (existing saved capability covers the task — use ` +
  `\`execute()\`; user explicitly said abort; site is blocked), call ` +
  `\`abort_session(session_id, reason)\` — that's the honest exit. NOT for "I judged this as a ` +
  `one-off" — klura is always for saving and that judgment isn't yours to make.`;
