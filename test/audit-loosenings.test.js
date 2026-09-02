// Audit-cluster loosenings that fix the recorded-path save loop:
//
//   B. literal_provenance does NOT scan recorded-path locator strings.
//   C. Click-observed-must-be-enum exempts full-URL navigate destinations.
//   D. firstObservableUrl resolves {{placeholder}} via notes.params.<x>.example.
//   E. opaque-internal-ID detector exempts kind: "url".
//   F. single_entity example match accepts substring (with a 3-char min).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { collectScannedFields } = await import('../dist/strategies/validate/helpers.js');
const { validateLiteralAnswer, validateLookupPrereqsAreCapabilities } = await import(
  '../dist/gate/save-audit.js'
);
const { firstObservableUrl } = await import('../dist/strategies/verify-observed.js');
const { validateNoOpaqueUserParams } = await import(
  '../dist/strategies/validate/opaque-params.js'
);

// ---------- B. locator strings excluded from literal_provenance ----------

test('B: collectScannedFields skips recorded-path locator strings', () => {
  const fields = collectScannedFields({
    strategy: 'recorded-path',
    steps: [
      {
        id: 'click_login',
        action: 'click',
        selector: 'button[data-id="legacy"]',
        locators: {
          a11y: { role: 'button', name: 'Log in' },
          css: 'button.login',
          alternatives: [
            { css: 'button.login-alt' },
            { a11y: { role: 'link', name: 'Log in' } },
          ],
        },
      },
    ],
  });
  for (const f of fields) {
    assert.notMatch(
      f.path,
      /\.locators\.css|\.locators\.alternatives|\.selector$/,
      `should not scan locator field ${f.path}`,
    );
  }
});

test('C: collectScannedFields scans prerequisites[*].args.* (credential blind spot)', () => {
  const fields = collectScannedFields({
    strategy: 'fetch',
    baseUrl: 'https://api.example.test',
    endpoint: '/items',
    prerequisites: [
      {
        name: 'auth',
        kind: 'capability',
        capability: 'login',
        args: { username: 'alice', password: 'wonderland' },
      },
    ],
  });
  const paths = fields.map((f) => f.path);
  assert.ok(paths.includes('prerequisites[0].args.username'), `scanned: ${paths.join(', ')}`);
  const pw = fields.find((f) => f.path === 'prerequisites[0].args.password');
  assert.equal(pw?.value, 'wonderland');
});

test('B: collectScannedFields keeps recorded-path step.url and step.value', () => {
  const fields = collectScannedFields({
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_search', action: 'navigate', url: 'https://example.com/search' },
      {
        id: 'type_query',
        action: 'type',
        value: 'pizza',
        locators: { a11y: { role: 'textbox', name: 'Search' } },
      },
    ],
  });
  const paths = fields.map((f) => f.path);
  assert.ok(paths.includes('steps[0].url'), 'step url stays scanned');
  assert.ok(paths.includes('steps[1].value'), 'step value stays scanned');
});

// ---------- C. Click-observed exemption for navigate destination URLs ----

test('C: navigate step url accepts static when click-observed value equals literal', () => {
  const data = {
    strategy: 'recorded-path',
    steps: [
      {
        id: 'navigate_minasidor',
        action: 'navigate',
        url: 'https://example.com/minasidor/',
      },
    ],
  };
  const observedParamValues = {
    next: [
      {
        value: 'https://example.com/minasidor/',
        source: { kind: 'ui_click', label: 'Log in to My Pages' },
      },
    ],
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'steps[0].url', value: 'https://example.com/minasidor/' },
    'static',
    observedParamValues,
  );
  assert.deepEqual(issues, [], 'navigate URL with full-equality click match accepts static');
});

test('C: non-navigate field still rejects static when value contains click-observed substring', () => {
  // Body field, not steps[N].url — the exemption must NOT apply.
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: '/api/send',
    body: { recipient_id: 'usr_abc123' },
  };
  const observedParamValues = {
    recipient: [
      { value: 'usr_abc123', source: { kind: 'ui_click', label: 'Bob' } },
    ],
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'body.recipient_id', value: 'usr_abc123' },
    'static',
    observedParamValues,
  );
  assert.notEqual(issues.length, 0, 'non-navigate static rejection still fires');
  assert.match(issues[0], /selectable enum option, NOT a static literal/);
});

test('C: navigate step still rejects static when click value is a substring (not equal)', () => {
  // The exemption requires full-value equality. A substring match means the
  // navigate URL contains an enum-y token — keep rejecting.
  const data = {
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_thread', action: 'navigate', url: 'https://example.com/threads/abc123' },
    ],
  };
  const observedParamValues = {
    thread_id: [
      { value: 'abc123', source: { kind: 'ui_click', label: 'Thread #1' } },
    ],
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'steps[0].url', value: 'https://example.com/threads/abc123' },
    'static',
    observedParamValues,
  );
  assert.notEqual(issues.length, 0, 'substring (not equal) match still rejects');
});

// ---------- C2. credential-secret literals can't be frozen ----------

test('C2: literal password in prereq args rejects static (must parameterize)', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: '/api/items',
    prerequisites: [
      { kind: 'tag', tag: 'auth', args: { username: 'alice', password: 'wonderland' } },
    ],
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'prerequisites[0].args.password', value: 'wonderland' },
    'static',
  );
  assert.notEqual(issues.length, 0, 'literal password classified static is rejected');
  assert.match(issues[0], /credential secret/);
});

test('C2: literal secret rejects single_entity too', () => {
  const data = { strategy: 'fetch', baseUrl: 'https://x.com', endpoint: '/a', body: { api_key: 'sk_live_abc' } };
  const issues = validateLiteralAnswer(
    data,
    { path: 'body.api_key', value: 'sk_live_abc' },
    'single_entity',
  );
  assert.notEqual(issues.length, 0, 'literal api_key classified single_entity is rejected');
  assert.match(issues[0], /credential secret/);
});

test('C2: templated secret ({{password}}) is accepted (caller_input)', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://x.com',
    endpoint: '/a',
    prerequisites: [{ kind: 'tag', tag: 'auth', args: { password: '{{password}}' } }],
    notes: { params: { password: { kind: 'string', example: 'hunter2' } } },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'prerequisites[0].args.password', value: '{{password}}' },
    { caller_input: 'password' },
  );
  assert.deepEqual(issues, [], 'a templated {{password}} bound to a declared param is fine');
});

test('C2: nested caller-input path is grounded by its declared root param', () => {
  const data = {
    strategy: 'page-script',
    origin: 'https://example.com',
    response: { from: 'result', format: 'json' },
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'search_items',
        args: { query: '{{queries.0}}' },
        vars: { result: 'body' },
      },
    ],
    notes: { params: { queries: { kind: 'json', example: '["pizza"]' } } },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'prerequisites[0].args.query', value: '{{queries.0}}' },
    { caller_input: 'queries.0' },
  );
  assert.deepEqual(
    issues,
    [],
    'a nested path inherits provenance from the declared top-level caller argument',
  );
});

test('C2: positional caller-input alias is grounded by declaration order', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: '/search?q={{0}}',
    notes: { params: { query: { kind: 'text', example: 'pizza' } } },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'endpoint', value: '/search?q={{0}}' },
    { caller_input: '0' },
  );
  assert.deepEqual(issues, [], 'a positional alias resolves to its declared caller argument');
});

test('C2: non-secret identifier (username) is NOT force-rejected on static', () => {
  // Only the secret half of a credential pair is forced; usernames/emails can
  // be legitimately frozen for a single-account strategy.
  const data = { strategy: 'fetch', baseUrl: 'https://x.com', endpoint: '/a', body: { username: 'bot_account' } };
  const issues = validateLiteralAnswer(
    data,
    { path: 'body.username', value: 'bot_account' },
    'static',
  );
  assert.deepEqual(issues, [], 'username static is not force-rejected by the secret rule');
});

// ---------- D. firstObservableUrl resolves placeholders ----------

test('D: firstObservableUrl resolves {{name}} via notes.params.<name>.example', () => {
  const url = firstObservableUrl({
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_minasidor', action: 'navigate', url: '{{minasidor_url}}' },
    ],
    notes: {
      params: {
        minasidor_url: { kind: 'url', example: 'https://example.com/minasidor/' },
      },
    },
  });
  assert.equal(url, 'https://example.com/minasidor/');
});

test('D: firstObservableUrl returns null when placeholder has no example', () => {
  const url = firstObservableUrl({
    strategy: 'recorded-path',
    steps: [{ id: 'navigate_x', action: 'navigate', url: '{{nope}}' }],
    notes: { params: {} },
  });
  assert.equal(url, null, 'unresolved template => null (skip surface check)');
});

test('D: firstObservableUrl returns the literal URL when no template is present', () => {
  const url = firstObservableUrl({
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_concrete', action: 'navigate', url: 'https://example.com/' },
    ],
  });
  assert.equal(url, 'https://example.com/');
});

// ---------- E. opaque-internal-ID detector exempts kind: "url" ----------

test('E: validateNoOpaqueUserParams accepts https:// URL when notes.params.<x>.kind is "url"', () => {
  // Strategy USES the placeholder so the "unused-param exemption" doesn't
  // skip the check — that branch was already lenient. The interesting
  // invariant: kind:"url" exempts the URI-scheme shape match.
  assert.doesNotThrow(() =>
    validateNoOpaqueUserParams({
      strategy: 'fetch',
      baseUrl: 'https://example.com',
      endpoint: '/redirect?to={{target}}',
      notes: {
        params: {
          target: { kind: 'url', example: 'https://example.com/dashboard' },
        },
      },
    }),
  );
});

test('E: validateNoOpaqueUserParams still rejects opaque IDs when kind is not "url"', () => {
  // Same shape, but kind: "id" — the URI-scheme pattern still doesn't match
  // the example "abc123def456" (no scheme), so this should pass on shape.
  // For a true positive, use a UUID-shaped example.
  assert.throws(
    () =>
      validateNoOpaqueUserParams({
        strategy: 'fetch',
        baseUrl: 'https://example.com',
        endpoint: '/items/{{item_id}}',
        notes: {
          params: {
            item_id: {
              kind: 'text',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
          },
        },
      }),
    /opaque-internal-ID/,
  );
});

// ---------- F. single_entity example-match accepts substring ----------

test('F: single_entity accepts when example appears as substring of literal', () => {
  const data = {
    strategy: 'recorded-path',
    steps: [
      {
        id: 'click_org',
        action: 'click',
        locators: { a11y: { role: 'link', name: "Granat Sweden AB" } },
      },
    ],
    notes: {
      params: {
        company_name: { kind: 'text', example: 'Granat Sweden AB' },
      },
    },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'body.company', value: "a:has-text('Granat Sweden AB')" },
    'single_entity',
    {},
  );
  assert.deepEqual(issues, [], 'substring match satisfies single_entity');
});

test('F: single_entity rejects when no example matches as substring', () => {
  const data = {
    strategy: 'fetch',
    notes: { params: { other: { kind: 'text', example: 'unrelated' } } },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'body.company', value: 'CompanyXYZ' },
    'single_entity',
    {},
  );
  assert.notEqual(issues.length, 0);
  assert.match(issues[0], /no notes\.params\.\*\.example/);
});

test('F: single_entity rejects examples shorter than min-length floor (anti-cheat)', () => {
  // Tiny examples (1-2 chars) would let the agent canned-answer through any
  // literal containing those characters. The floor mirrors the 2-char min on
  // the click-observed check — single_entity uses 3 to discourage cheating.
  const data = {
    strategy: 'fetch',
    notes: { params: { tiny: { kind: 'text', example: 'XY' } } },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'body.x', value: 'something_with_XY_inside' },
    'single_entity',
    {},
  );
  assert.notEqual(issues.length, 0, '2-char example does not satisfy single_entity');
});

// ---------- G. single_entity rejected for lookup-shaped / slug-param capabilities (F9a) ----------

test('G: single_entity rejected when capability slug implies a lookup', () => {
  const data = {
    strategy: 'fetch',
    endpoint: '/api/order/12345',
    notes: { params: { order_id: { kind: 'text', example: '12345' } } },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'endpoint', value: '/api/order/12345' },
    'single_entity',
    {},
    'get_order_by_id',
  );
  assert.notEqual(issues.length, 0);
  assert.match(issues[0], /not allowed here|lookup-implying/);
});

test('G: single_entity rejected when a notes.params entry is kind:"slug"', () => {
  const data = {
    strategy: 'fetch',
    endpoint: '/api/restaurants?category=italian',
    notes: { params: { cuisine: { kind: 'slug', example: 'italian' } } },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'endpoint', value: '/api/restaurants?category=italian' },
    'single_entity',
    {},
    'find_top_restaurants_by_cuisine',
  );
  assert.notEqual(issues.length, 0);
  assert.match(issues[0], /not allowed here|kind:"slug"/);
});

test('G: single_entity still accepted for a genuine fixed-entity capability', () => {
  const data = {
    strategy: 'fetch',
    endpoint: '/api/company/granat',
    notes: { params: { company: { kind: 'text', example: 'granat' } } },
  };
  const issues = validateLiteralAnswer(
    data,
    { path: 'endpoint', value: '/api/company/granat' },
    'single_entity',
    {},
    'get_company_profile',
  );
  assert.deepEqual(issues, []);
});

// ---------- H. lookup-prereq network-call guard (F9d) ----------

test('H: pure-DOM js-eval prereq is NOT flagged as an inline lookup', () => {
  const data = {
    strategy: 'fetch',
    endpoint: '/api/restaurants?category={{cuisine}}',
    prerequisites: [
      {
        kind: 'js-eval',
        name: 'norm',
        url: 'https://site.example.com/',
        binds: 'cuisine',
        expression: "return document.querySelector('h1').textContent.toLowerCase();",
      },
    ],
  };
  // The page-context url coincides with a captured path, but the expression
  // makes no network call → not a lookup.
  const issues = validateLookupPrereqsAreCapabilities(
    'find_top_restaurants_by_cuisine',
    data,
    new Set(['https://site.example.com/']),
  );
  assert.deepEqual(issues, []);
});

test('H: js-eval prereq with a real fetch() to a captured endpoint IS flagged', () => {
  const data = {
    strategy: 'fetch',
    endpoint: '/api/send',
    prerequisites: [
      {
        kind: 'js-eval',
        name: 'lookup',
        url: 'https://site.example.com/',
        binds: 'member_id',
        expression: "const r = await fetch('https://site.example.com/api/search?q=x'); return (await r.json()).id;",
      },
    ],
  };
  const issues = validateLookupPrereqsAreCapabilities(
    'send_message_by_name',
    data,
    new Set(['https://site.example.com/api/search']),
  );
  assert.notEqual(issues.length, 0);
});
