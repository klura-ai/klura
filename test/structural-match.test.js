// Structural match for try_generator* — JSON-shape comparison.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { structuralMatch } = await import('../dist/response/structural-match.js');

function bytes(s) {
  return new TextEncoder().encode(s);
}

test('identical JSON → match', () => {
  const a = bytes('{"app_id":"123","payload":"hi"}');
  const b = bytes('{"app_id":"123","payload":"hi"}');
  const r = structuralMatch(a, b);
  assert.equal(r.ok, true);
});

test('same shape, different values → match', () => {
  const a = bytes('{"app_id":"772021","payload":"hello"}');
  const b = bytes('{"app_id":"999999","payload":"world"}');
  const r = structuralMatch(a, b);
  assert.equal(r.ok, true);
  assert.equal(r.info.kind, 'structural_match');
});

test('missing key → mismatch with path', () => {
  const a = bytes('{"app_id":"1","payload":"hi","otid":"123"}');
  const b = bytes('{"app_id":"1","payload":"hi"}');
  const r = structuralMatch(a, b);
  assert.equal(r.ok, false);
  assert.match(r.diff.path, /otid/);
  assert.equal(r.diff.got_type, 'missing');
});

test('different value types → mismatch', () => {
  const a = bytes('{"count":5}');
  const b = bytes('{"count":"five"}');
  const r = structuralMatch(a, b);
  assert.equal(r.ok, false);
  assert.equal(r.diff.expected_type, 'number');
  assert.equal(r.diff.got_type, 'string');
});

test('array length mismatch → fail', () => {
  const a = bytes('{"tasks":[1,2,3]}');
  const b = bytes('{"tasks":[1,2]}');
  const r = structuralMatch(a, b);
  assert.equal(r.ok, false);
  assert.match(r.diff.path, /length/);
});

test('array same length, element type matches → ok', () => {
  const a = bytes('{"tasks":[{"label":"a"},{"label":"b"}]}');
  const b = bytes('{"tasks":[{"label":"x"},{"label":"y"}]}');
  const r = structuralMatch(a, b);
  assert.equal(r.ok, true);
});

test('nested escaped JSON unwraps and matches on shape', () => {
  const expected = bytes(
    '{"app_id":"123","payload":"{\\"epoch_id\\":7451,\\"tasks\\":[{\\"label\\":\\"46\\"}]}"}',
  );
  const got = bytes(
    '{"app_id":"999","payload":"{\\"epoch_id\\":1234,\\"tasks\\":[{\\"label\\":\\"99\\"}]}"}',
  );
  const r = structuralMatch(expected, got);
  assert.equal(r.ok, true, 'nested escaped JSON unwrapped and compared');
});

test('binary envelope with no JSON → no_json_found', () => {
  // Pure binary garbage — no `{`/`[` at all.
  const a = new Uint8Array([0x32, 0xfd, 0x09, 0x00, 0x07]);
  const b = new Uint8Array([0x32, 0xfd, 0x09, 0x00, 0x08]);
  const r = structuralMatch(a, b);
  assert.equal(r.ok, false);
  assert.equal(r.info.kind, 'no_json_found');
});

test('length-prefixed binary envelope with embedded JSON → matches', () => {
  // Mimics /ls_req: some binary prefix, then JSON body.
  const prefix = String.fromCharCode(0x32, 0xfd, 0x09, 0x00, 0x07);
  const a = bytes(prefix + '{"app_id":"1","tasks":[]}');
  const b = bytes(prefix + '{"app_id":"2","tasks":[]}');
  const r = structuralMatch(a, b);
  assert.equal(r.ok, true);
});

test('top-level array matches arrays', () => {
  const a = bytes('[{"x":1},{"x":2}]');
  const b = bytes('[{"x":10},{"x":20}]');
  const r = structuralMatch(a, b);
  assert.equal(r.ok, true);
});
