// Structural-dead-end hard bounce for the save_strategy audit loop.
//
// Bench loops surface agents iterating the SAME save_strategy rejection 5–12×
// with cosmetic edits — chasing a detector false-positive, a schema
// contradiction, or a genuinely unsupported shape — burning rounds that would
// otherwise cover simpler capabilities. The `_budget_warning` prose already
// asks the agent to stop after 3 same-rejection retries; this enforces it
// structurally. After the 3rd same-family rejection for one capability the
// runtime stops echoing the same audit prose and returns a `structural_dead_end`
// that forces one of: defer (add_discovery_note), switch tier, or abort.

import type { AuditRejection } from '../index';
import type { Session } from '../../drivers/types/session';

/** Same-family rejections allowed before the bounce. The 3rd is the bounce. */
export const DEAD_END_THRESHOLD = 3;

/**
 * A stable signature for "which rejection is this." Two retries belong to the
 * same family when the same audit `reason` + the same set of warning /
 * classifier kinds fired — cosmetic edits to unrelated fields don't change it,
 * but fixing one detector and hitting a different one does (a fresh family,
 * fresh budget). Switching tier changes which detectors fire, so it also yields
 * a fresh family.
 */
export function rejectionFamilyKey(rejection: AuditRejection): string {
  if (rejection.reason === 'invalid_shape') return 'invalid_shape';
  const kinds = new Set<string>();
  for (const w of rejection.warnings) kinds.add(w.kind);
  for (const k of Object.keys(rejection.items ?? {})) kinds.add(k);
  if (kinds.size === 0) return rejection.reason;
  return [...kinds].sort((a, b) => a.localeCompare(b)).join('+');
}

function composeDeadEnd(
  capability: string,
  family: string,
  count: number,
  normalMessage: string,
): string {
  return (
    `invalid_strategy: save_strategy_structural_dead_end: capability "${capability}" has now been ` +
    `rejected ${count}× with the same rejection family (${family}). This is a structural dead end, not ` +
    `an iteration step — cosmetic edits against the same rejection won't clear it (it's typically a ` +
    `detector false-positive, a schema contradiction, or a shape the runtime genuinely can't save). ` +
    `STOP retrying save_strategy with this shape. Pick one:\n` +
    `  (a) DEFER — call add_discovery_note(...) to persist what you learned (endpoint, the blocker, the ` +
    `shape you tried) so the next session resumes from here, then end_drive / move on to other capabilities.\n` +
    `  (b) DIFFERENT TIER — try the other mechanism (fetch ⇄ page-script, or recorded-path). A different ` +
    `tier fires different detectors and may avoid this rejection entirely.\n` +
    `  (c) ABANDON — if this capability genuinely can't be saved (site blocks it, no stable mechanism), ` +
    `call abort_session(session_id, reason) to exit honestly.\n\n` +
    `The rejection you keep hitting, for reference:\n${normalMessage}`
  );
}

/**
 * Track a save_strategy audit rejection on the session and decide whether to
 * hard-bounce. Increments the per-`(capability, family)` counter; returns the
 * `structural_dead_end` message on the 3rd+ same-family rejection, else `null`
 * (the caller throws the normal rejection message). No-op (returns null) for
 * programmatic saves with no session.
 */
export function trackRejectionAndMaybeBounce(
  session: Session | null,
  capability: string,
  rejection: AuditRejection,
  normalMessage: string,
): string | null {
  if (!session) return null;
  const family = rejectionFamilyKey(rejection);
  const key = `${capability}::${family}`;
  const counts = (session.saveRejectionFamilyCounts ??= {});
  const next = (counts[key] ?? 0) + 1;
  counts[key] = next;
  if (next < DEAD_END_THRESHOLD) return null;
  return composeDeadEnd(capability, family, next, normalMessage);
}
