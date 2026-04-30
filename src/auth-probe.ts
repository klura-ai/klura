// Auth-probe — fires a GET against the saved strategy's runtime_meta.discovered_from_url
// (or baseUrl fallback) using the agent's live browser session, then
// classifies whether the user is still authenticated to the site. Used by
// the auto-exec failure diagnosis to disambiguate "per-call token rotated
// server-side" (stale_nonce — re-extract via prereq) from "session expired"
// (auth_failed — escalate to user re-auth).
//
// Crisp by design (per runtime/docs/principles.md §"Crisp vs fuzzy"):
// inputs are HTTP status + final URL after redirects, both structural.
// Login-wall URL detection delegates to `isLoginWallUrl` in
// response/auth-wall.ts (single source of truth, segment-tokenized).
//
// The probe runs from inside the agent's browser session via
// `driver.evaluateExpression` so cookies + storage state are exactly
// what the failed request would have had — no Node-side cookie
// reconstruction.

import type { BrowserDriver } from './drivers/interface';
import type { Session } from './drivers/types/session';
import { isLoginWallUrl } from './response/auth-wall';

export type AuthState = 'logged_in' | 'logged_out' | 'indeterminate';

export interface AuthProbeResult {
  url: string;
  status: number | null;
  final_url: string | null;
  auth_state: AuthState;
  reason: string;
}

/**
 * Pick the URL to probe. Prefer runtime_meta.discovered_from_url (a real
 * auth-gated page the agent landed on during discovery); fall back to baseUrl.
 * Returns null when neither is available.
 */
export function pickProbeUrl(strategy: unknown): string | null {
  if (!strategy || typeof strategy !== 'object') return null;
  const obj = strategy as Record<string, unknown>;
  const meta = obj.runtime_meta;
  if (meta && typeof meta === 'object') {
    const dfu = (meta as Record<string, unknown>).discovered_from_url;
    if (typeof dfu === 'string' && dfu.length > 0) return dfu;
  }
  const baseUrl = obj.baseUrl;
  if (typeof baseUrl === 'string' && baseUrl.length > 0) return baseUrl;
  return null;
}

/**
 * Fire a single GET via the agent's session and read back status + final URL.
 * Times out at 5s — the failure path shouldn't add multi-second latency.
 */
export async function probeAuthState(
  driver: BrowserDriver,
  session: Session,
  url: string,
): Promise<AuthProbeResult> {
  const expression = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
      });
      return { ok: true, status: r.status, final_url: r.url };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  })()`;

  let raw: unknown;
  try {
    raw = await driver.evaluateExpression(session, expression, { timeoutMs: 5000 });
  } catch (err) {
    return {
      url,
      status: null,
      final_url: null,
      auth_state: 'indeterminate',
      reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!raw || typeof raw !== 'object') {
    return {
      url,
      status: null,
      final_url: null,
      auth_state: 'indeterminate',
      reason: 'probe returned non-object',
    };
  }
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) {
    return {
      url,
      status: null,
      final_url: null,
      auth_state: 'indeterminate',
      reason: typeof r.error === 'string' ? `probe fetch threw: ${r.error}` : 'probe fetch failed',
    };
  }

  const status = typeof r.status === 'number' ? r.status : null;
  const final_url = typeof r.final_url === 'string' ? r.final_url : null;

  if (isLoginWallUrl(final_url)) {
    return {
      url,
      status,
      final_url,
      auth_state: 'logged_out',
      reason: `final URL after follow-redirects contains a login path segment`,
    };
  }

  // Non-2xx with no login redirect — could be a server error, marketing 404,
  // or some auth gate that doesn't conform to the redirect-to-/login pattern.
  // Conservative: indeterminate.
  if (status === null || status < 200 || status >= 300) {
    return {
      url,
      status,
      final_url,
      auth_state: 'indeterminate',
      reason: `probe returned non-2xx status ${status} without a login-path final URL`,
    };
  }

  return {
    url,
    status,
    final_url,
    auth_state: 'logged_in',
    reason: '2xx response, final URL outside known login-path segments',
  };
}
