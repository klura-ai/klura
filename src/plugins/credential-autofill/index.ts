// Credential-autofill default plugin. Ships with klura but is
// architecturally a plugin — the runtime has no concept of "password".
// Stripping this file leaves a fully-functional runtime; every login
// falls through to `default-handover-viewer`.
//
// When the runtime emits an interruption whose context suggests an
// auth-wall / session-expired condition AND carries a `platform` slug
// for which the identity store has a password, this plugin returns the
// stored credentials as a `resolved` value. Without a platform / without
// stored creds, it returns a viewer handover — the runtime cannot
// silently proceed without either a human or a credential source.
//
// Credential source: `runtime/src/identity/identities.ts`. The canonical
// shape is `{username | email, password}` but arbitrary fields are
// surfaced verbatim so multi-factor flows (username + otp_seed + phone)
// can pick the subset they need.
//
// See runtime/docs/interruptions.md §Credential autofill for the
// architectural framing and runtime/docs/remote.md §Credential
// resolution for the reference-scheme conventions.

import { registerInterruptionHandler } from '../../interruptions';
import { getIdentity } from '../../identity/identities';
import type { InterruptionEvent } from '../../interruptions';

function readPlatformFromEvent(event: InterruptionEvent): string | null {
  const platform = event.context.platform;
  if (typeof platform !== 'string' || platform.length === 0) return null;
  return platform;
}

function hasPasswordCredential(platform: string, identityName?: string): boolean {
  try {
    const profile = getIdentity(platform, identityName);
    return typeof profile.password === 'string' && profile.password.length > 0;
  } catch {
    // getIdentity throws on invalid slug; treat as "no creds".
    return false;
  }
}

registerInterruptionHandler({
  name: 'credential-autofill',
  description:
    'Returns stored credentials (username + password + arbitrary identity fields) as a resolved value. Pick this when the agent saw an auth-wall on the page (login form visible in the a11y tree, e.g. `event.context.reason` of `"auth_wall_seen"` / `"login_form_visible"`) AND `event.context.platform` is a slug for which the identity store has a password configured. If the platform is missing or no stored password exists, this handler falls back to a viewer handover — so picking it when creds are absent is safe, it simply degrades to the interactive path. When the session was opened with a named identity (multi-account), credentials are looked up under the identity-scoped profile slot first; absent that, the platform-default profile is used as a fallback.',
  // eslint-disable-next-line @typescript-eslint/require-await
  async handle(event, session) {
    const platform = readPlatformFromEvent(event);
    // Identity is opt-in (multi-account). Read it from the session — the
    // start_session validator stamped it; default-when-omitted reads the
    // historical platform-only profile slot. See klura://reference#identities.
    const identityName = session.identity;
    if (!platform || !hasPasswordCredential(platform, identityName)) {
      return {
        status: 'handover',
        target: 'viewer',
        prompt: 'Stored credentials unavailable; log in manually.',
      };
    }
    const profile = getIdentity(platform, identityName);
    return {
      status: 'resolved',
      value: {
        platform,
        ...(identityName ? { identity: identityName } : {}),
        username: profile.username ?? profile.email ?? '',
        password: profile.password ?? '',
        // Surface every stored identity field verbatim so multi-factor
        // flows can pick the subset they need.
        identity_fields: profile,
      },
    };
  },
});
