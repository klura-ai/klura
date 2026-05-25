// Visibility annotation for a11y snaps. Annotate-by-exception: only
// non-visible interactive nodes surface; visible nodes don't appear
// (implicit). Token-cheap on normal pages; informative only where it
// matters — cookie banners, modals, sticky-header overlap, below-fold
// elements.
//
// Why annotate-by-exception over inline-on-tree: the a11y tree is a
// flat YAML-like string (playwright's `ariaSnapshot`). Mapping each line
// back to its DOM element so we can append `_v: o` per line requires
// ariaref parsing or fragile (role, name) lookups. A sidecar list of
// anomalies sidesteps both — agents read the tree as-is plus the
// anomalies array, and cross-reference by `role + name`.
//
// Surfaces this powers:
//   - `start_session` always populates `visibility_anomalies` on the
//     response so cookie-banner + modal detection lands on the first
//     turn without an opt-in.
//   - `get_a11y_tree` adds the same field to its response.
//   - `perform_action` click-fail (Commit C) runs the same snap on the
//     failing selector and embeds concrete diagnosis in the rejection
//     envelope.
//
// Cost: ~10-30 ms per snap for ~200 interactive nodes. On start_session
// (2-5 s cold-start) that's 1 % overhead.

import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';

/** `'o'` = overlapped (covered by another element — clicks land on
 *  the cover); `'f'` = below-fold (off-screen vertically, needs
 *  scroll); `'s'` = off-screen (outside viewport otherwise — usually
 *  off-screen horizontally or hidden via transform). */
export type VisibilityCode = 'o' | 'f' | 's';

export interface VisibilityAnomaly {
  role: string;
  name: string;
  _v: VisibilityCode;
}

/** Call the driver's visibility snap if it exposes one. Returns an
 *  empty array when the driver doesn't implement the method (test
 *  stubs, future drivers in pre-rollout state) or when the snap throws
 *  — visibility is best-effort context, not a load-bearing failure
 *  axis. */
export async function snapVisibilityAnomalies(
  driver: BrowserDriver,
  session: Session,
): Promise<ReadonlyArray<VisibilityAnomaly>> {
  if (typeof driver.snapVisibilityForInteractiveNodes !== 'function') return [];
  try {
    return await driver.snapVisibilityForInteractiveNodes(session);
  } catch {
    return [];
  }
}
