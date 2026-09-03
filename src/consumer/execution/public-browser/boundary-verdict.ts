import { PublicHttpExecutionError } from '../node-http';
import type { BrowserNetworkBoundaryV1 } from './executor';

/** A request the boundary refused reaches the page as a generic navigation
 *  or fetch error; the boundary's own verdict names the rule, phase, and
 *  origin, so it is the error worth reporting when one exists. */
export function boundaryVerdictOr(
  boundary: BrowserNetworkBoundaryV1 | null,
  error: unknown,
  targetRequests: number,
): unknown {
  if (boundary === null) return error;
  try {
    boundary.assertHealthy();
  } catch (refused) {
    if (refused instanceof PublicHttpExecutionError) {
      return new PublicHttpExecutionError(
        refused.code,
        refused.message,
        targetRequests,
        refused.interaction_failure,
        refused.diagnostic,
      );
    }
  }
  return error;
}
