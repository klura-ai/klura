// Interruption-side default handlers. Scope is agent-detected ambient
// page state — the agent sees a challenge in the a11y tree (captcha,
// 2FA, auth wall) and picks a resolver from the menu by reading
// descriptions. Runtime-emitted events with a known kind
// (recorded_step_failed, triage_plan, surface_changed, session_expired,
// post_save_validation_consent) route through `runtime/src/checkpoints/`
// instead — direct dispatch, no menu.
//
// Default handlers for agent-detected events are currently supplied by
// the `credential-autofill` plugin (for auth-wall / login-form cases)
// and whatever specialized plugins an enterprise deployment registers
// (captcha solver, 2FA relay, SSO bridge, etc.). No built-in defaults
// ship for agent-detected reasons — if no plugin claims the event, the
// menu is empty and the agent is expected to open the viewer via
// `start_remote_session` as the last-resort escape hatch.

import type { Session } from '../drivers/types/session';

// DI seam for the viewer opener. `runtime-state.ts` injects the real
// implementation (`startRemoteSession` via the pool's driver) after the
// pool is created. Retained for symmetry with
// `checkpoints/default-handlers.ts` and for enterprise / scenario
// plugins that want to share the injected opener rather than call
// `start_remote_session` directly.
export type ViewerOpener = (
  sessionId: string,
  session: Session,
  opts: { prompt?: string },
) => Promise<{ viewerUrl: string }>;
let viewerOpener: ViewerOpener | null = null;
export function setViewerOpener(fn: ViewerOpener): void {
  viewerOpener = fn;
}
export function getViewerOpener(): ViewerOpener | null {
  return viewerOpener;
}

/** Registers the interruption-side defaults. Currently a no-op — all
 *  built-in reasons moved to the checkpoint registry. Kept as a hook
 *  for future agent-detected defaults and so `runtime-state.ts` can
 *  call it unconditionally. */
export function registerDefaults(): void {
  // Intentionally empty. See module-level comment.
}
