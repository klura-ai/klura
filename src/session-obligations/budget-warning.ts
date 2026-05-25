// Long-lived session budget warning. When a session has been driven for
// longer than `SESSION_SOFT_BUDGET_MS`, tools that frequently appear in
// drive loops (perform_action, save_strategy) decorate their responses
// with a one-sentence `_budget_warning` so the agent sees the budget
// before it gets SIGKILLed by an orchestrator wall-clock cap mid-thrash.
//
// The runtime can't see the orchestrator's wall-clock cap (that lives
// in the host process), so the budget here is a structural soft limit.

import type { Session } from '../drivers/types/session';

/** Soft session-age budget. Past this point, the budget warning starts
 *  decorating tool responses. Picked to sit comfortably inside the
 *  loop's 15-minute orchestrator cap with ~3 minutes of headroom. */
const SESSION_SOFT_BUDGET_MS = 12 * 60 * 1000;

/**
 * Compose the budget-warning string for a session, or null when the
 * session hasn't crossed the soft cap yet (or hasn't been stamped with
 * startedAt — defensive). The warning names the elapsed time so the
 * agent can calibrate, and points at the canonical wrap-up surfaces
 * (end_drive for the happy path, abort_session for blockers).
 */
export function composeBudgetWarning(session: Session): string | null {
  const startedAt = session.startedAt;
  if (typeof startedAt !== 'number') return null;
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < SESSION_SOFT_BUDGET_MS) return null;
  const elapsedMin = Math.round(elapsedMs / 60000);
  return (
    `Session has been driving for ~${elapsedMin} minutes — finalize within ` +
    `~3 minutes or risk an orchestrator wall-clock kill that drops your ` +
    `captures + retrospective. Wrap-up surfaces: \`end_drive\` (happy ` +
    `path, runs auto-synth + LIFT handoff) or \`abort_session({kind, reason})\` ` +
    `(when a blocker means there's nothing salvageable to save). Do NOT ` +
    `keep retrying \`save_strategy\` on the same rejection if you've already ` +
    `hit it 3+ times — the strategy has a structural issue; persist what ` +
    `you have to the discovery_artifact and let the next session pick up.`
  );
}
