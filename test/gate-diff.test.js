// diffPaths — structural diff used by Level-3 gates (Audit, buildTokenGate)
// to surface which fields shifted between a token's audited payload and the
// retry payload. Empty result means equal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { diffPaths } = await import('../dist/gate/diff.js');

test('equal primitives → empty diff', () => {
  assert.deepEqual(diffPaths(1, 1), []);
  assert.deepEqual(diffPaths('a', 'a'), []);
  assert.deepEqual(diffPaths(null, null), []);
  assert.deepEqual(diffPaths(undefined, undefined), []);
});

test('equal objects → empty diff', () => {
  assert.deepEqual(diffPaths({ a: 1, b: 2 }, { a: 1, b: 2 }), []);
  assert.deepEqual(diffPaths({ a: 1, b: 2 }, { b: 2, a: 1 }), [], 'key order does not matter');
});

test('changed primitive at root → root path', () => {
  assert.deepEqual(diffPaths(1, 2), ['(root)']);
  assert.deepEqual(diffPaths('a', 'b'), ['(root)']);
});

test('changed nested field surfaces as dotted path', () => {
  assert.deepEqual(diffPaths({ a: { b: 1 } }, { a: { b: 2 } }), ['a.b']);
});

test('changed array element surfaces with bracket index', () => {
  assert.deepEqual(diffPaths({ xs: [1, 2, 3] }, { xs: [1, 9, 3] }), ['xs[1]']);
});

test('added/removed object key', () => {
  assert.deepEqual(diffPaths({ a: 1 }, { a: 1, b: 2 }), ['b (added)']);
  assert.deepEqual(diffPaths({ a: 1, b: 2 }, { a: 1 }), ['b (removed)']);
});

test('array length change — extra element flagged', () => {
  assert.deepEqual(diffPaths([1, 2], [1, 2, 3]), ['[2] (added)']);
  assert.deepEqual(diffPaths([1, 2, 3], [1, 2]), ['[2] (removed)']);
});

test('object → array at the same path → root-level mismatch', () => {
  assert.deepEqual(diffPaths({ a: { b: 1 } }, { a: [1] }), ['a']);
});

test('null vs object differs', () => {
  assert.deepEqual(diffPaths({ a: null }, { a: { x: 1 } }), ['a']);
});

test('keyed-array diff: arrays of {path, value} diff by path, not by index', () => {
  // The literal_provenance classifier emits hash slices shaped like
  // `[{path: 'endpoint', value: '/v1'}, {path: 'body.text', value: '...'}]`.
  // The agent thinks in payload paths, not array indices — keying by `path`
  // produces "endpoint", not "[0].value".
  const a = [
    { path: 'endpoint', value: '/api/v1/send' },
    { path: 'body.text', value: 'hi' },
  ];
  const b = [
    { path: 'endpoint', value: '/api/v2/send' },
    { path: 'body.text', value: 'hi' },
  ];
  assert.deepEqual(diffPaths(a, b), ['endpoint.value']);
});

test('keyed-array diff: added/removed entries use path-based markers', () => {
  const a = [{ path: 'endpoint', value: '/v1' }];
  const b = [
    { path: 'endpoint', value: '/v1' },
    { path: 'body.text', value: '{{text}}' },
  ];
  assert.deepEqual(diffPaths(a, b), ['body.text (added)']);
});

test('keyed-array diff falls back to positional when paths are not unique', () => {
  const a = [
    { path: 'x', value: 1 },
    { path: 'x', value: 2 },
  ];
  const b = [
    { path: 'x', value: 1 },
    { path: 'x', value: 9 },
  ];
  // Duplicate `path` disqualifies keyed mode → positional diff fires.
  assert.deepEqual(diffPaths(a, b), ['[1].value']);
});

test('multiple diffs in stable, sorted order', () => {
  const a = { foo: 1, bar: 'old', nested: { x: 1, y: 2 } };
  const b = { foo: 1, bar: 'new', nested: { x: 1, y: 9, z: 3 } };
  assert.deepEqual(diffPaths(a, b), ['bar', 'nested.y', 'nested.z (added)']);
});
