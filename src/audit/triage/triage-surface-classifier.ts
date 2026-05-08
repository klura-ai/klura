// Triage-time structural classifier — decides whether the captured
// network activity for a triage plan represents a "trivial" surface
// (open GET / JSON or text / no auth signals) where the user-relay
// `triage_plan` checkpoint adds friction without value.
//
// The classifier is read-only and additive. It does NOT reject the
// agent's plan and does NOT short-circuit any audit detector. The only
// thing it gates is the post-audit user-relay checkpoint: trivial
// surfaces transition straight to LIFT with an `_hint` line; non-trivial
// surfaces fire the checkpoint as before.
//
// All signals are structural — derived from captured request shape, not
// from prose / keyword matching. Any uncertainty falls through to "not
// trivial" so the checkpoint stays the safe default. False negatives
// (extra checkpoints) are acceptable; false positives (skipping a
// checkpoint that should have fired) are the failure mode to avoid.

import type { InterceptedRequest } from '../../drivers/types/network';
import type { DefenseSurface } from '../../working-dir/schema';

export interface TriageSurfaceSignals {
  /** At least one captured XHR/Fetch landed on an observed_origin. Without
   *  this we have no evidence to classify the surface as trivial. */
  has_observed_traffic: boolean;
  /** Every on-surface captured request used GET. Mutating methods
   *  (POST/PUT/DELETE/PATCH) imply state change → not trivial. */
  all_methods_idempotent: boolean;
  /** No on-surface response carried Set-Cookie. Cookie-setting on the
   *  data calls signals session-state mutation, not a public read. */
  no_set_cookie_on_data_calls: boolean;
  /** No on-surface request carried an auth-shaped request header
   *  (Authorization, X-CSRF-*, X-Signed-*, X-Hmac-*, X-API-Key,
   *  X-Auth-*). Presence of one of these means the surface is signed
   *  or token-gated. */
  no_auth_request_headers: boolean;
  /** No on-surface request carried a body. GET requests should already
   *  imply this; the explicit check guards against odd captures (POST-
   *  shaped GETs, GraphQL-over-GET with serialized body in a header). */
  no_request_bodies: boolean;
  /** Every on-surface response stored a parseable body (JSON object or
   *  text string) or was a body-fetch race. Binary responses, opaque
   *  responses, or other non-text shapes signal that the surface is
   *  outside the cleanly-handled cases. */
  all_responses_typed_json_or_text: boolean;
}

export interface TriageSurfaceVerdict {
  trivial: boolean;
  /** One-line summary suitable for inlining into the agent-facing
   *  `_hint` on the submit_triage_plan ok-response. */
  reason: string;
  /** Per-signal verdict report — useful for tests + diagnostic
   *  surfacing. */
  signals: TriageSurfaceSignals;
  /** Number of on-surface requests considered. */
  on_surface_count: number;
}

// Header names checked case-insensitively against captured request
// headers. Presence of any of these on an on-surface request disqualifies
// the surface from "trivial" — these are the structural carriers of
// signed / token-gated request shape.
const AUTH_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-csrf-token',
  'x-csrftoken',
  'x-xsrf-token',
  'x-csrf',
  'x-api-key',
  'x-auth-token',
  'x-signed-request',
  'x-signed-payload',
  'x-hmac-signature',
]);

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function isAuthHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (AUTH_REQUEST_HEADERS.has(lower)) return true;
  // X-Signed-* / X-Hmac-* / X-Auth-* prefix families. Belt-and-
  // suspenders for non-canonical signed-header names that follow the
  // family convention.
  if (lower.startsWith('x-signed-')) return true;
  if (lower.startsWith('x-hmac-')) return true;
  if (lower.startsWith('x-auth-')) return true;
  return false;
}

export function classifyTriageSurface(
  defenseSurface: Pick<DefenseSurface, 'observed_origins'>,
  intercepted: readonly InterceptedRequest[],
): TriageSurfaceVerdict {
  const observed = new Set<string>();
  for (const o of defenseSurface.observed_origins) {
    const norm = originOf(o);
    if (norm !== null) observed.add(norm);
  }

  // Filter to data-call traffic on the declared surface origins. Skip
  // page-document navigations (the homepage's analytics cookies are
  // unrelated to the agent's saved capability — those would
  // disqualify every public read on a site that sets any cookie at all).
  const onSurface = intercepted.filter((req) => {
    if (req.isNavigation) return false;
    const o = originOf(req.url);
    return o !== null && observed.has(o);
  });

  const has_observed_traffic = onSurface.length > 0;

  const all_methods_idempotent =
    has_observed_traffic && onSurface.every((r) => r.method.toUpperCase() === 'GET');

  const no_set_cookie_on_data_calls =
    has_observed_traffic &&
    onSurface.every((r) => !r.setCookieNames || r.setCookieNames.length === 0);

  const no_auth_request_headers =
    has_observed_traffic &&
    onSurface.every((r) => {
      for (const name of Object.keys(r.headers)) {
        if (isAuthHeaderName(name)) return false;
      }
      return true;
    });

  const no_request_bodies =
    has_observed_traffic &&
    onSurface.every((r) => {
      const body = r.postData;
      if (body === null || body === undefined) return true;
      if (typeof body === 'string' && body.length === 0) return true;
      return false;
    });

  const all_responses_typed_json_or_text =
    has_observed_traffic &&
    onSurface.every((r) => {
      // Body-fetch races (responseBody === null when the fetch raced
      // ahead of Network.getResponseBody) are not disqualifying — the
      // request itself was on a clean origin with no auth signals.
      if (r.responseBody === null || r.responseBody === undefined) return true;
      return typeof r.responseBody === 'object' || typeof r.responseBody === 'string';
    });

  const signals: TriageSurfaceSignals = {
    has_observed_traffic,
    all_methods_idempotent,
    no_set_cookie_on_data_calls,
    no_auth_request_headers,
    no_request_bodies,
    all_responses_typed_json_or_text,
  };

  const trivial =
    has_observed_traffic &&
    all_methods_idempotent &&
    no_set_cookie_on_data_calls &&
    no_auth_request_headers &&
    no_request_bodies &&
    all_responses_typed_json_or_text;

  const reason = trivial
    ? `${onSurface.length} captured XHR/Fetch on observed_origins; all GET, no Set-Cookie, no auth-shaped headers, no request bodies`
    : describeFailure(signals, onSurface);

  return { trivial, reason, signals, on_surface_count: onSurface.length };
}

function describeFailure(
  signals: TriageSurfaceSignals,
  onSurface: readonly InterceptedRequest[],
): string {
  if (!signals.has_observed_traffic) {
    return 'no captured XHR/Fetch on observed_origins (cannot classify trivially)';
  }
  const fails: string[] = [];
  if (!signals.all_methods_idempotent) {
    const nonGet = onSurface.find((r) => r.method.toUpperCase() !== 'GET');
    fails.push(`mutating method (${nonGet?.method ?? '?'} ${nonGet?.url ?? '?'})`);
  }
  if (!signals.no_set_cookie_on_data_calls) {
    const cookieReq = onSurface.find((r) => r.setCookieNames && r.setCookieNames.length > 0);
    fails.push(`Set-Cookie on ${cookieReq?.url ?? 'a data call'}`);
  }
  if (!signals.no_auth_request_headers) {
    fails.push(
      'auth-shaped request header (Authorization / X-CSRF / X-Signed / X-Hmac / X-API-Key / X-Auth)',
    );
  }
  if (!signals.no_request_bodies) {
    fails.push('request body present');
  }
  if (!signals.all_responses_typed_json_or_text) {
    fails.push('non-JSON / non-text response observed');
  }
  return fails.join('; ');
}
