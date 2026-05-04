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
const { validateLiteralAnswer } = await import('../dist/gate/save-audit.js');
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
