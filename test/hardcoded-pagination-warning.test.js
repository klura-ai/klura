// hardcoded-pagination save warning — structural detection of a baked page size.
//
// A `size` / `limit` / `pagesize` / `hitsPerPage` query value that is a bare
// integer (not a `{{placeholder}}`) is a caller concern frozen at discovery.
// The detector is structural: bounded key vocabulary + integer value, never
// matched against the user's request text.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectHardcodedPaginationValue } = await import(
  '../dist/gate/save-warnings-pagination.js'
);
const { WARNING_KINDS } = await import('../dist/vocab/index.js');

const flag = (endpoint) => detectHardcodedPaginationValue({ strategy: 'fetch', endpoint });

test('flags a baked size / hitsPerPage / pagesize value', () => {
  for (const ep of [
    '/-/v1/search?text={{q}}&size=3',
    '/-/v1/search?text={{q}}&size=10',
    '/api/v1/search?query={{query}}&tags=story&hitsPerPage=10',
    '/2.3/search/advanced?sort=votes&q={{q}}&site=stackoverflow&pagesize=3',
  ]) {
    const w = flag(ep);
    assert.equal(w.length, 1, `expected a warning for ${ep}`);
    assert.equal(w[0].kind, WARNING_KINDS.hardcodedPaginationValue);
    assert.ok(Array.isArray(w[0].context.flagged) && w[0].context.flagged.length === 1);
  }
});

test('does not flag a templated (caller-driven) size', () => {
  assert.deepEqual(flag('/-/v1/search?text={{q}}&size={{count}}'), []);
});

test('does not flag non-pagination static params (site, order, tags)', () => {
  assert.deepEqual(flag('/search?q={{q}}&site=stackoverflow&order=desc&tags=story'), []);
});

test('does not flag an endpoint with no query string', () => {
  assert.deepEqual(flag('/api/items'), []);
});

test('does not flag a non-integer size value', () => {
  assert.deepEqual(flag('/thumbs?size=large'), []);
});

test('key matching is separator/case-insensitive', () => {
  assert.equal(flag('/x?q={{q}}&hits_per_page=25').length, 1);
  assert.equal(flag('/x?q={{q}}&HitsPerPage=25').length, 1);
  assert.equal(flag('/x?q={{q}}&per_page=25').length, 1);
});

test('flags multiple baked pagination params at once', () => {
  const w = flag('/x?q={{q}}&limit=20&pagesize=5');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].context.flagged, ['limit=20', 'pagesize=5']);
});
