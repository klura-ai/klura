// `findMissingCapturedQueryParams` detects the canonical "captured but
// dropped" failure mode: the agent saved a strategy whose URL template
// drops one or more query params that were present on the captured
// request. Most servers received those params at discovery; dropping
// them silently produces HTTP 4xx at warm time.
//
// Reproduced live in v4 field-reports/stackoverflow/search_questions
// warm — Stack Exchange `/2.3/search/advanced` requires `site=stackoverflow`,
// the cold-saved strategy dropped it, every warm call returned 400.

import test from 'node:test';
import assert from 'node:assert';

const verify = await import('../dist/strategies/verify-observed.js');
const { findMissingCapturedQueryParams } = verify;

function fetchStrategy(endpoint, baseUrl = 'https://api.example.test') {
  return {
    strategy: 'fetch',
    method: 'GET',
    baseUrl,
    endpoint,
  };
}

test('captured param templated in strategy → no warning', () => {
  const strategy = fetchStrategy('/v1/search?q={{query}}');
  const observed = ['https://api.example.test/v1/search?q=typescript'];
  assert.deepEqual(findMissingCapturedQueryParams(strategy, observed), []);
});

test('captured param hardcoded as static in strategy → no warning', () => {
  const strategy = fetchStrategy('/v1/search?q={{query}}&site=stackoverflow');
  const observed = ['https://api.example.test/v1/search?q=typescript&site=stackoverflow'];
  assert.deepEqual(findMissingCapturedQueryParams(strategy, observed), []);
});

test('captured param dropped from strategy → warning fires (the stackoverflow #9 repro)', () => {
  const strategy = fetchStrategy('/2.3/search/advanced?q={{query}}');
  const observed = [
    'https://api.example.test/2.3/search/advanced?q=typescript+conditional+types&site=stackoverflow',
  ];
  const missing = findMissingCapturedQueryParams(strategy, observed);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].param, 'site');
  assert.equal(missing[0].observed_value, 'stackoverflow');
});

test('multiple dropped params each surface as a distinct warning entry', () => {
  const strategy = fetchStrategy('/v1/search?q={{query}}');
  const observed = [
    'https://api.example.test/v1/search?q=foo&site=stackoverflow&pagesize=10&order=desc',
  ];
  const missing = findMissingCapturedQueryParams(strategy, observed);
  assert.equal(missing.length, 3);
  const names = new Set(missing.map((m) => m.param));
  assert.deepEqual(names, new Set(['site', 'pagesize', 'order']));
});

test('multiple captures dedupe by param name — first observed value wins', () => {
  const strategy = fetchStrategy('/v1/search?q={{query}}');
  const observed = [
    'https://api.example.test/v1/search?q=foo&site=stackoverflow',
    'https://api.example.test/v1/search?q=bar&site=stackoverflow',
    'https://api.example.test/v1/search?q=baz&site=meta',
  ];
  const missing = findMissingCapturedQueryParams(strategy, observed);
  assert.equal(missing.length, 1, 'one missing param across the three captures');
  assert.equal(missing[0].param, 'site');
  // First observed wins; the audit doesn't care which value — the agent
  // gets the param name + an example to template against.
  assert.equal(missing[0].observed_value, 'stackoverflow');
});

test('observed URL on a different path is ignored (the unobserved-url detector covers that case)', () => {
  const strategy = fetchStrategy('/v1/search?q={{query}}');
  const observed = [
    'https://api.example.test/v1/other?site=stackoverflow', // different path
  ];
  assert.deepEqual(findMissingCapturedQueryParams(strategy, observed), []);
});

test('observed URL on a different host is ignored', () => {
  const strategy = fetchStrategy('/v1/search?q={{query}}');
  const observed = ['https://other-host.test/v1/search?site=stackoverflow'];
  assert.deepEqual(findMissingCapturedQueryParams(strategy, observed), []);
});

test('strategy with no endpoint (e.g. recorded-path no navigates) → no warning', () => {
  const strategy = { strategy: 'recorded-path', steps: [] };
  assert.deepEqual(findMissingCapturedQueryParams(strategy, ['https://example.test/path']), []);
});

test('empty observed URLs → no warning (unobserved-url detector handles "captured nothing")', () => {
  const strategy = fetchStrategy('/v1/search?q={{query}}');
  assert.deepEqual(findMissingCapturedQueryParams(strategy, []), []);
});

test('trailing slash variance does not break matching', () => {
  const strategy = fetchStrategy('/v1/search?q={{query}}');
  const observed = ['https://api.example.test/v1/search/?q=foo&site=stackoverflow']; // trailing slash
  const missing = findMissingCapturedQueryParams(strategy, observed);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].param, 'site');
});
