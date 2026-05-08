// Unit tests for runtime/src/audit/triage-surface-classifier.ts.
//
// The classifier's purpose: tell submit_triage_plan whether to skip the
// `triage_plan` user-relay checkpoint. A trivial surface is open-GET,
// JSON/text, no Set-Cookie, no auth-shaped headers — the canonical
// public-read shape (storelocator, suggest, public catalog APIs). For
// those, the user-relay checkpoint is friction without value.
//
// Each test below pins one signal: removing the trivial-make condition
// from the captured fixture must flip the verdict to non-trivial.

import test from 'node:test';
import assert from 'node:assert';

const { classifyTriageSurface } = await import('../dist/audit/triage/triage-surface-classifier.js');

const ORIGIN = 'https://www.example.com';
const SURFACE = { observed_origins: [ORIGIN] };

function makeReq(overrides = {}) {
  return {
    method: 'GET',
    url: `${ORIGIN}/api/data`,
    headers: {},
    postData: null,
    status: 200,
    responseBody: { ok: true, items: [] },
    ...overrides,
  };
}

test('trivial: open GET, JSON response, no Set-Cookie, no auth headers → trivial', () => {
  const verdict = classifyTriageSurface(SURFACE, [makeReq()]);
  assert.strictEqual(verdict.trivial, true, verdict.reason);
  assert.strictEqual(verdict.signals.has_observed_traffic, true);
  assert.strictEqual(verdict.signals.all_methods_idempotent, true);
  assert.strictEqual(verdict.signals.no_set_cookie_on_data_calls, true);
  assert.strictEqual(verdict.signals.no_auth_request_headers, true);
  assert.strictEqual(verdict.on_surface_count, 1);
});

test('trivial: page-document navigation with Set-Cookie does NOT disqualify', () => {
  // Bauhaus-shape: the homepage Document load sets analytics cookies but
  // the agent's saved capability is a public XHR GET. Navigation
  // requests are filtered out before the per-request checks.
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ url: ORIGIN + '/', isNavigation: true, setCookieNames: ['_ga', '_dd_s'] }),
    makeReq({ url: ORIGIN + '/storelocator/api/stores' }),
  ]);
  assert.strictEqual(verdict.trivial, true, verdict.reason);
});

test('not trivial: empty captured traffic on surface (no evidence)', () => {
  const verdict = classifyTriageSurface(SURFACE, []);
  assert.strictEqual(verdict.trivial, false);
  assert.strictEqual(verdict.signals.has_observed_traffic, false);
  assert.match(verdict.reason, /no captured/);
});

test('not trivial: only off-origin captures (third-party API) — none on surface', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ url: 'https://analytics.example.net/event' }),
  ]);
  assert.strictEqual(verdict.trivial, false);
  assert.strictEqual(verdict.on_surface_count, 0);
});

test('not trivial: POST request on surface (mutation signal)', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq(),
    makeReq({ method: 'POST', url: ORIGIN + '/api/submit', postData: '{}' }),
  ]);
  assert.strictEqual(verdict.trivial, false);
  assert.strictEqual(verdict.signals.all_methods_idempotent, false);
  assert.match(verdict.reason, /mutating method/);
});

test('not trivial: Set-Cookie on a data call (session-state mutation)', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ setCookieNames: ['session_id'] }),
  ]);
  assert.strictEqual(verdict.trivial, false);
  assert.strictEqual(verdict.signals.no_set_cookie_on_data_calls, false);
  assert.match(verdict.reason, /Set-Cookie/);
});

test('not trivial: Authorization header on a data call', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ headers: { authorization: 'Bearer abc' } }),
  ]);
  assert.strictEqual(verdict.trivial, false);
  assert.strictEqual(verdict.signals.no_auth_request_headers, false);
  assert.match(verdict.reason, /auth-shaped/);
});

test('not trivial: X-CSRF-Token header on a data call', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ headers: { 'x-csrf-token': 'abc123' } }),
  ]);
  assert.strictEqual(verdict.trivial, false);
});

test('not trivial: X-Signed-Request header on a data call (signed-family prefix)', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ headers: { 'x-signed-request': 'sig' } }),
  ]);
  assert.strictEqual(verdict.trivial, false);
});

test('not trivial: X-Auth-Token header on a data call (auth-family prefix)', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ headers: { 'x-auth-token': 'tok' } }),
  ]);
  assert.strictEqual(verdict.trivial, false);
});

test('trivial: response body fetch race (responseBody null) does not disqualify', () => {
  // CDP's getResponseBody can fail with "No resource" when the body is
  // already gone. The request side was clean — that signal alone is
  // enough; absence of body is not disqualifying.
  const verdict = classifyTriageSurface(SURFACE, [makeReq({ responseBody: null })]);
  assert.strictEqual(verdict.trivial, true, verdict.reason);
});

test('trivial: HTML response body (string) is acceptable as text', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ responseBody: '<html><body>x</body></html>' }),
  ]);
  assert.strictEqual(verdict.trivial, true, verdict.reason);
});

test('not trivial: bare hostname in observed_origins is dropped (no scheme)', () => {
  // originOf returns null on unparseable URLs; the request that lands
  // on www.example.com would not be on any observed origin once the
  // bare hostname is dropped.
  const verdict = classifyTriageSurface({ observed_origins: ['example.com'] }, [makeReq()]);
  assert.strictEqual(verdict.trivial, false);
});

test('case-insensitive: AUTHORIZATION header is recognized', () => {
  const verdict = classifyTriageSurface(SURFACE, [
    makeReq({ headers: { AUTHORIZATION: 'Bearer x' } }),
  ]);
  assert.strictEqual(verdict.trivial, false);
});

test('multi-origin surface: all on-surface requests must be clean', () => {
  // observed_origins names two origins; the surface is trivial only if
  // captured traffic on both is clean.
  const surface = {
    observed_origins: ['https://www.example.com', 'https://api.example.com'],
  };
  const allClean = classifyTriageSurface(surface, [
    makeReq({ url: 'https://www.example.com/data' }),
    makeReq({ url: 'https://api.example.com/v1/items' }),
  ]);
  assert.strictEqual(allClean.trivial, true, allClean.reason);

  const oneDirty = classifyTriageSurface(surface, [
    makeReq({ url: 'https://www.example.com/data' }),
    makeReq({
      url: 'https://api.example.com/v1/submit',
      method: 'POST',
      postData: '{}',
    }),
  ]);
  assert.strictEqual(oneDirty.trivial, false);
});
