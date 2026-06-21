// detectUnreferencedParams: a top-level `params` key that no {{key}}/:key token
// references is silently dropped at execute time (params never auto-append to the
// query string), so the value never reaches the server. Surfaced at save time.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectUnreferencedParams } = await import('../dist/gate/save-warnings.js');

test('fires when a params key is referenced by no token', () => {
  const w = detectUnreferencedParams({
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.test',
    endpoint: '/search',
    params: { format: 'json', locale: 'en' },
  });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'params_key_unreferenced');
  assert.match(w[0].message, /format/);
  assert.match(w[0].message, /locale/);
});

test('clean when every params key is referenced via {{key}} in the endpoint', () => {
  const w = detectUnreferencedParams({
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.test',
    endpoint: '/search?format={{format}}',
    params: { format: 'json' },
  });
  assert.deepEqual(w, []);
});

test('clean when referenced via :key REST token', () => {
  const w = detectUnreferencedParams({
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.test',
    endpoint: '/items/:format',
    params: { format: 'json' },
  });
  assert.deepEqual(w, []);
});

test('clean when referenced in body or headers', () => {
  const w = detectUnreferencedParams({
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://api.test',
    endpoint: '/x',
    body: { fmt: '{{format}}' },
    headers: { 'X-Locale': '{{locale}}' },
    params: { format: 'json', locale: 'en' },
  });
  assert.deepEqual(w, []);
});

test('only the unreferenced keys are flagged (mixed)', () => {
  const w = detectUnreferencedParams({
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.test',
    endpoint: '/search?format={{format}}',
    params: { format: 'json', dead: 'x' },
  });
  assert.equal(w.length, 1);
  assert.match(w[0].message, /dead/);
  assert.doesNotMatch(w[0].message, /\bformat\b/);
});

test('no params → no warning', () => {
  assert.deepEqual(
    detectUnreferencedParams({ strategy: 'fetch', endpoint: '/x', baseUrl: 'https://api.test' }),
    [],
  );
});

test('does not partial-match a longer token (substring guard)', () => {
  // params key `fmt` must NOT be considered referenced by `{{format}}`.
  const w = detectUnreferencedParams({
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.test',
    endpoint: '/search?format={{format}}',
    params: { fmt: 'json' },
  });
  assert.equal(w.length, 1);
  assert.match(w[0].message, /fmt/);
});
