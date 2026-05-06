// Coverage for two save-time detector changes:
//   1. `auth_gated_without_auth_prereq` no longer bypasses on path-match —
//      shared-path gateways (GraphQL, JSON-RPC, generic /api/*) used to
//      silently suppress the warning when ANY captured cookie-setter
//      shared the strategy's endpoint pathname. Only `provides: ["auth"]`
//      is a valid opt-out now.
//   2. `unreferenced_prereq_binding` (new) catches js-eval prereqs whose
//      `binds` name is never referenced elsewhere on the strategy — the
//      "envelope-and-prereq-do-different-things" shape that silently
//      corrupts warm execute.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-save-warnings-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const saveWarnings = await import('../dist/gate/save-warnings.js');
const providers = await import('../dist/strategies/validate/providers.js');
const { detectAuthGatedWithoutAuthPrereq, detectUnreferencedPrereqBinding } = saveWarnings;
const { setCapturedRequestsProvider } = providers;

// ---------- auth_gated bypass fix ----------

test('auth_gated: fires when strategy endpoint shares path with a captured cookie-setter (GraphQL gateway shape)', () => {
  // The Facebook-shape: captured /api/graphql/ sets cookies via a login
  // response, agent's saved strategy ALSO targets /api/graphql/ but for
  // a read operation. Path-match used to silently suppress. Now the
  // warning fires unless the strategy declares provides: ["auth"].
  setCapturedRequestsProvider(() => [
    {
      url: 'https://www.example.com/api/graphql/',
      method: 'POST',
      setCookieNames: ['session', 'csrf'],
    },
  ]);
  try {
    const warnings = detectAuthGatedWithoutAuthPrereq(
      {
        strategy: 'page-script',
        baseUrl: 'https://www.example.com',
        endpoint: '/api/graphql/',
        method: 'POST',
        prerequisites: [
          { name: 'feed', kind: 'js-eval', binds: 'stories', expression: '...', url: 'https://www.example.com/' },
        ],
      },
      'sess_test',
    );
    assert.strictEqual(warnings.length, 1, 'warning should fire even when paths match');
    assert.strictEqual(warnings[0].kind, 'auth_gated_without_auth_prereq');
  } finally {
    setCapturedRequestsProvider(null);
  }
});

test('auth_gated: provides: ["auth"] still suppresses (typed-edge opt-out)', () => {
  setCapturedRequestsProvider(() => [
    {
      url: 'https://www.example.com/api/graphql/',
      method: 'POST',
      setCookieNames: ['session'],
    },
  ]);
  try {
    const warnings = detectAuthGatedWithoutAuthPrereq(
      {
        strategy: 'fetch',
        baseUrl: 'https://www.example.com',
        endpoint: '/api/graphql/',
        method: 'POST',
        provides: ['auth'],
      },
      'sess_test',
    );
    assert.deepStrictEqual(warnings, []);
  } finally {
    setCapturedRequestsProvider(null);
  }
});

test('auth_gated: existing {kind: "tag", tag: "auth"} prereq still suppresses', () => {
  setCapturedRequestsProvider(() => [
    {
      url: 'https://www.example.com/api/graphql/',
      method: 'POST',
      setCookieNames: ['session'],
    },
  ]);
  try {
    const warnings = detectAuthGatedWithoutAuthPrereq(
      {
        strategy: 'fetch',
        baseUrl: 'https://www.example.com',
        endpoint: '/api/graphql/',
        method: 'POST',
        prerequisites: [{ name: 'auth', kind: 'tag', tag: 'auth' }],
      },
      'sess_test',
    );
    assert.deepStrictEqual(warnings, []);
  } finally {
    setCapturedRequestsProvider(null);
  }
});

test('auth_gated: GET endpoint on cookie-bearing origin is exempt (false-positive scope cut)', () => {
  // bauhaus.se shape: homepage sets analytics/preferences cookies during
  // initial Document load; the agent's saved strategy is a public read
  // (storelocator GET, search suggest GET, inventory GET). The browser
  // auto-sends the jar's cookies on every same-origin fetch, so the prior
  // detector fired on every saved GET — pure noise. GETs are read-only and
  // truly auth-gated GETs surface as 401/403 at execute time, recovered by
  // the auth-wall handler.
  setCapturedRequestsProvider(() => [
    {
      url: 'https://www.bauhaus.se/',
      method: 'GET',
      setCookieNames: ['_dd_s', 'analytics_id'],
    },
  ]);
  try {
    const warnings = detectAuthGatedWithoutAuthPrereq(
      {
        strategy: 'fetch',
        baseUrl: 'https://www.bauhaus.se',
        endpoint: '/storelocator/api/stores',
        method: 'GET',
      },
      'sess_test',
    );
    assert.deepStrictEqual(warnings, []);
  } finally {
    setCapturedRequestsProvider(null);
  }
});

// ---------- unreferenced_prereq_binding ----------

test('unreferenced_prereq_binding: fires when js-eval binds name has no {{name}} reference anywhere', () => {
  // Facebook-shape replay: prereq does the real fetch+parse internally,
  // declared HTTP envelope is dead, binding `stories` is never read.
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'page-script',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/graphql/',
    method: 'POST',
    prerequisites: [
      {
        name: 'feed',
        kind: 'js-eval',
        url: 'https://www.example.com/',
        binds: 'stories',
        expression: 'doFetchAndParse()',
        return_shape: { kind: 'string' },
      },
    ],
  });
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].kind, 'unreferenced_prereq_binding');
  assert.match(warnings[0].message, /binds: "stories"/);
  assert.match(warnings[0].message, /\{\{stories\}\}/);
  assert.deepStrictEqual(warnings[0].context, { prereq_index: 0, binds_name: 'stories' });
});

test('unreferenced_prereq_binding: clean when {{name}} appears in body', () => {
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/graphql/',
    method: 'POST',
    body: { variables: '{{stories}}' },
    prerequisites: [
      {
        name: 'feed',
        kind: 'js-eval',
        url: 'https://www.example.com/',
        binds: 'stories',
        expression: 'doFetchAndParse()',
        return_shape: { kind: 'string' },
      },
    ],
  });
  assert.deepStrictEqual(warnings, []);
});

test('unreferenced_prereq_binding: clean when {{name}} appears in endpoint', () => {
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/u/{{user_id}}',
    method: 'GET',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'js-eval',
        url: 'https://www.example.com/',
        binds: 'user_id',
        expression: 'getUserId()',
        return_shape: { kind: 'string' },
      },
    ],
  });
  assert.deepStrictEqual(warnings, []);
});

test('unreferenced_prereq_binding: clean when {{name}} appears in a sibling prereq', () => {
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/x',
    method: 'GET',
    prerequisites: [
      {
        name: 'a',
        kind: 'js-eval',
        url: 'https://www.example.com/',
        binds: 'token',
        expression: 'getToken()',
        return_shape: { kind: 'string' },
      },
      {
        name: 'b',
        kind: 'fetch-extract',
        url: 'https://www.example.com/api/use?t={{token}}',
        vars: { x: 'data.x' },
      },
    ],
  });
  assert.deepStrictEqual(warnings, []);
});

test('unreferenced_prereq_binding: matches `{{ name }}` with whitespace', () => {
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/x',
    method: 'GET',
    headers: { 'X-Token': '{{   token   }}' },
    prerequisites: [
      {
        name: 'a',
        kind: 'js-eval',
        url: 'https://www.example.com/',
        binds: 'token',
        expression: 'getToken()',
        return_shape: { kind: 'string' },
      },
    ],
  });
  assert.deepStrictEqual(warnings, []);
});

test('unreferenced_prereq_binding: ignores non-js-eval prereqs (capability/tag use vars, not binds)', () => {
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/x',
    method: 'GET',
    prerequisites: [
      { name: 'auth', kind: 'tag', tag: 'auth' },
      { name: 'login', kind: 'capability', capability: 'login' },
    ],
  });
  assert.deepStrictEqual(warnings, []);
});

test('unreferenced_prereq_binding: per-prereq detection — fires only on the unreferenced one', () => {
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/{{used}}',
    method: 'GET',
    prerequisites: [
      {
        name: 'used',
        kind: 'js-eval',
        url: 'https://www.example.com/',
        binds: 'used',
        expression: 'getUsed()',
        return_shape: { kind: 'string' },
      },
      {
        name: 'unused',
        kind: 'js-eval',
        url: 'https://www.example.com/',
        binds: 'unused',
        expression: 'doSideEffect()',
        return_shape: { kind: 'string' },
      },
    ],
  });
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].context.binds_name, 'unused');
  assert.strictEqual(warnings[0].context.prereq_index, 1);
});

test('unreferenced_prereq_binding: skips when strategy has no prerequisites', () => {
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/x',
    method: 'GET',
  });
  assert.deepStrictEqual(warnings, []);
});

test('unreferenced_prereq_binding: skips recorded-path strategies', () => {
  const warnings = detectUnreferencedPrereqBinding({
    strategy: 'recorded-path',
    steps: [
      { id: 'click', action: 'click', locators: { a11y: { role: 'button', name: 'X' }, css: '#x' } },
    ],
    prerequisites: [
      {
        name: 'p',
        kind: 'js-eval',
        url: 'https://www.example.com/',
        binds: 'token',
        expression: '...',
        return_shape: { kind: 'string' },
      },
    ],
  });
  assert.deepStrictEqual(warnings, []);
});
