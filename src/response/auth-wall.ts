// Login-wall URL detector — single source of truth.
//
// Crisp by construction: parses the URL, splits the pathname on `/`, and asks
// whether any path component (or sequential pair) is one of the canonical
// login-wall segments. No regex against the full URL string, no prose match.
// `/loginhelp` is rejected because `loginhelp` is not in the segment list;
// `/account/login` is matched because `login` is a discrete segment.

const LOGIN_SEGMENTS = new Set(['login', 'signin', 'sign-in', 'sign_in', 'auth']);

// Two-component login-wall paths (matched as a sequential pair anywhere in
// the path). Keeps `/sessions/new` from matching on the bare `sessions`
// segment alone.
const LOGIN_SEGMENT_PAIRS: Array<[string, string]> = [['sessions', 'new']];

/** True when `url` looks like a login wall (302-redirect destination, etc.). */
export function isLoginWallUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const segments = parsed.pathname
    .toLowerCase()
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.some((s) => LOGIN_SEGMENTS.has(s))) return true;
  for (let i = 0; i < segments.length - 1; i++) {
    for (const [a, b] of LOGIN_SEGMENT_PAIRS) {
      if (segments[i] === a && segments[i + 1] === b) return true;
    }
  }
  return false;
}

/**
 * Best-effort current-URL read for soft-warn callsites. Wraps the driver
 * `getUrl` call so callers can't be surprised by either (a) drivers that
 * legitimately don't implement getUrl (some test stubs) or (b) drivers that
 * throw mid-navigation. Returns '' on any failure — combined with
 * `isLoginWallUrl('')` returning false, the soft-warn path silently skips when
 * the URL can't be read, preserving the prior hard-reject behaviour for those
 * edge cases.
 */
export async function tryGetUrl<S>(
  driver: { getUrl?: (session: S) => Promise<string> },
  session: S,
): Promise<string> {
  if (typeof driver.getUrl !== 'function') return '';
  try {
    return await driver.getUrl(session);
  } catch {
    return '';
  }
}
