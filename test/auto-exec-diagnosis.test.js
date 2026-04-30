// classifyAutoExecDiagnosis — typed shape for cascade failures, surfaced
// inline on start_session as `_auto_exec_diagnosis` so the agent reads
// the next investigative step at the decision point. See
// runtime/src/execution.ts for the classifier and
// runtime/docs/principles.md §"Inline the result in a response the
// runtime already emits."

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { classifyAutoExecDiagnosis } = await import('../dist/execution.js');

test('401 + auth-probe says logged_in → kind=stale_nonce', () => {
  // Crisp disambiguation via auth-probe (runtime/src/auth-probe.ts):
  // the failed request 401'd, but a follow-up GET against the saved
  // strategy's runtime_meta.discovered_from_url returned 200 with a final URL
  // outside known login-path segments — so the user IS still authenticated
  // to the site. Conclusion: a per-call token rotated, re-extract via
  // prereq.
  const lastFailedResult = {
    status: 401,
    body: 'whatever the server returned (any language)',
    finalUrl: 'http://x.test/api/send',
  };
  const lastFailedStrategy = {
    strategy: 'page-script',
    endpoint: '/api/send',
    headers: { 'x-nonce': '{{nonce}}' },
    prerequisites: [
      { name: 'get_nonce', kind: 'js-eval', url: 'http://x.test/', expression: 'x', binds: 'nonce', return_shape: { kind: 'string' } },
    ],
    runtime_meta: { discovered_from_url: 'http://x.test/t/abc' },
  };
  const probe = {
    url: 'http://x.test/t/abc',
    status: 200,
    final_url: 'http://x.test/t/abc',
    auth_state: 'logged_in',
    reason: '2xx response, final URL outside known login-path segments',
  };
  const d = classifyAutoExecDiagnosis(
    ['page-script: HTTP 401'],
    lastFailedResult,
    lastFailedStrategy,
    probe,
  );
  assert.equal(d.kind, 'stale_nonce');
  assert.equal(d.probe.auth_state, 'logged_in');
  assert.match(d.failure_signal, /auth-probe.*logged_in|logged_in/);
  assert.match(d.hint, /token-bearing|nonce/i);
});

test('401 + auth-probe says logged_out → kind=auth_failed', () => {
  // Same 401 as the previous test — but the auth-probe's final URL
  // landed on /login. Conclusion: session expired, escalate to user
  // re-auth via remote viewer.
  const lastFailedResult = {
    status: 401,
    body: 'irrelevant body',
    finalUrl: 'http://x.test/api/send',
  };
  const lastFailedStrategy = {
    strategy: 'page-script',
    endpoint: '/api/send',
    runtime_meta: { discovered_from_url: 'http://x.test/t/abc' },
  };
  const probe = {
    url: 'http://x.test/t/abc',
    status: 200,
    final_url: 'http://x.test/login?next=/t/abc',
    auth_state: 'logged_out',
    reason: 'final URL after follow-redirects contains a login path segment',
  };
  const d = classifyAutoExecDiagnosis(
    ['page-script: HTTP 401'],
    lastFailedResult,
    lastFailedStrategy,
    probe,
  );
  assert.equal(d.kind, 'auth_failed');
  assert.equal(d.probe.auth_state, 'logged_out');
  assert.match(d.hint, /no longer authenticated|user re-auth|remote viewer/i);
});

test('401 + auth-probe indeterminate → kind=auth_failed (conservative)', () => {
  const lastFailedResult = { status: 401, body: '', finalUrl: 'http://x.test/api/send' };
  const lastFailedStrategy = { strategy: 'fetch', endpoint: '/api/send' };
  const probe = {
    url: 'http://x.test/',
    status: null,
    final_url: null,
    auth_state: 'indeterminate',
    reason: 'probe fetch threw: TypeError',
  };
  const d = classifyAutoExecDiagnosis(['fetch: HTTP 401'], lastFailedResult, lastFailedStrategy, probe);
  assert.equal(d.kind, 'auth_failed');
});

test('classifies prereq js-eval undefined as kind=prereq_returned_undefined', () => {
  const errors = [
    'page-script: prerequisite "get_nonce" (js-eval): TypeError: Cannot read properties of undefined (reading "nonce")',
  ];
  const d = classifyAutoExecDiagnosis(errors, null, {
    strategy: 'page-script',
    endpoint: '/api/send',
  });
  assert.equal(d.kind, 'prereq_returned_undefined');
  assert.equal(d.prereq_failures.length, 1);
  assert.equal(d.prereq_failures[0].name, 'get_nonce');
  assert.match(d.hint, /get_nonce/);
  assert.match(d.hint, /Don't spin a new session/);
});

test('classifies HTTP 410 endpoint retired as kind=endpoint_stale', () => {
  const lastFailedResult = {
    status: 410,
    body: { error: 'gone' },
    finalUrl: 'http://x.test/api/v1/submit',
  };
  const d = classifyAutoExecDiagnosis(
    ['fetch: HTTP 410'],
    lastFailedResult,
    { strategy: 'fetch', endpoint: '/api/v1/submit' },
  );
  assert.equal(d.kind, 'endpoint_stale');
  assert.match(d.hint, /endpoint URL/);
  assert.match(d.hint, /retired/);
});

test('classifies auth-failure (login redirect) as kind=auth_failed', () => {
  const lastFailedResult = {
    status: 200,
    body: '<html>Sign in</html>',
    finalUrl: 'http://x.test/login?next=/api/send',
  };
  const d = classifyAutoExecDiagnosis(
    ['fetch: redirected to login'],
    lastFailedResult,
    { strategy: 'fetch', endpoint: '/api/send' },
  );
  assert.equal(d.kind, 'auth_failed');
  assert.match(d.hint, /no longer authenticated/);
});

test('falls through to kind=unknown when nothing matches', () => {
  const d = classifyAutoExecDiagnosis(
    ['some uncategorized error'],
    null,
    { strategy: 'page-script', endpoint: '/api/send' },
  );
  assert.equal(d.kind, 'unknown');
  assert.match(d.hint, /didn't match a known class/);
});

test('attempted_endpoint is populated from strategy when available', () => {
  const d = classifyAutoExecDiagnosis(
    ['page-script: HTTP 401'],
    { status: 401, body: { error: 'stale_nonce' }, finalUrl: '' },
    { strategy: 'page-script', endpoint: '/api/send' },
  );
  assert.equal(d.attempted_endpoint, '/api/send');
  assert.equal(d.attempted_tier, 'page-script');
});

test('multiple prereq failures all get extracted', () => {
  const errors = [
    'page-script: prerequisite "get_nonce" (js-eval): undefined',
    'page-script: prerequisite "get_csrf" (js-eval): TypeError thrown',
  ];
  const d = classifyAutoExecDiagnosis(errors, null, { strategy: 'page-script' });
  assert.equal(d.prereq_failures.length, 2);
  const names = d.prereq_failures.map((p) => p.name).sort();
  assert.deepEqual(names, ['get_csrf', 'get_nonce']);
});
