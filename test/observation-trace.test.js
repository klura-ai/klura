// Observation-trace — per-session set of strings the agent saw via tool
// responses, used at save time to flag baked observed property names.
// Replaces the earlier regex-based "looks-minified" heuristic with a
// provenance check that also catches long obfuscated names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  extractObservedStrings,
  recordObservations,
  getObservedStrings,
  extractPropertyKeys,
  findObservedKeys,
  STABLE_API_NAMES,
} = await import('../dist/response/observation-trace.js');

function mkSession() {
  return {
    id: 'sess_test',
    intercepted: [],
    intercepting: false,
  };
}

test('extractObservedStrings: pulls strings from arrays (Object.keys-shape)', () => {
  const out = extractObservedStrings(['me', 'xa', 'ab']);
  assert.deepEqual(out.sort(), ['ab', 'me', 'xa']);
});

test('extractObservedStrings: pulls keys + nested values from objects', () => {
  const out = extractObservedStrings({ outer: { inner: 'somevalue' } });
  // 'outer' and 'inner' are keys; 'somevalue' is a value
  assert.ok(out.includes('outer'));
  assert.ok(out.includes('inner'));
  assert.ok(out.includes('somevalue'));
});

test('extractObservedStrings: includes single-char strings (canonical minified case)', () => {
  // `o`, `a`, `b` etc. are single-char keys that minified bundles use —
  // exactly what the gate is built to catch. They MUST be recorded.
  const out = extractObservedStrings(['a', 'me', 'o']);
  assert.deepEqual(out.sort(), ['a', 'me', 'o']);
});

test('extractObservedStrings: skips strings over MAX_LENGTH', () => {
  const longStr = 'a'.repeat(500);
  const out = extractObservedStrings([longStr, 'fine']);
  assert.deepEqual(out, ['fine']);
});

test('extractObservedStrings: handles null/undefined gracefully', () => {
  assert.deepEqual(extractObservedStrings(null), []);
  assert.deepEqual(extractObservedStrings(undefined), []);
  assert.deepEqual(extractObservedStrings(42), []);
});

test('recordObservations: builds session.observedStrings', () => {
  const session = mkSession();
  recordObservations(session, ['me', 'xa']);
  const observed = getObservedStrings(session);
  assert.ok(observed.has('me'));
  assert.ok(observed.has('xa'));
});

test('recordObservations: filters out STABLE_API_NAMES', () => {
  const session = mkSession();
  recordObservations(session, ['cookie', 'href', 'value', 'customKey']);
  const observed = getObservedStrings(session);
  assert.ok(!observed.has('cookie'));
  assert.ok(!observed.has('href'));
  assert.ok(!observed.has('value'));
  assert.ok(observed.has('customKey'));
});

test('recordObservations: never throws on cyclic / pathological input', () => {
  const cyclic = {};
  cyclic.recursive_ref = cyclic;
  const session = mkSession();
  // Should not throw. Recursion cap prevents stack-blow.
  recordObservations(session, cyclic);
  // The key 'recursive_ref' should be recorded (not in STABLE_API_NAMES).
  assert.ok(getObservedStrings(session).has('recursive_ref'));
});

test('extractPropertyKeys: dot access', () => {
  const keys = extractPropertyKeys('window.__app.me.o.nonce');
  // Skip root 'window'; rest are property keys.
  assert.deepEqual(
    keys.map((k) => k.key),
    ['__app', 'me', 'o', 'nonce'],
  );
});

test('extractPropertyKeys: bracket-string-literal access canonicalized', () => {
  const keys = extractPropertyKeys('window["__app"]["me"]["o"].nonce');
  assert.deepEqual(
    keys.map((k) => k.key),
    ['__app', 'me', 'o', 'nonce'],
  );
});

test('extractPropertyKeys: optional chaining markers stripped', () => {
  const keys = extractPropertyKeys('obj?.a?.b?.value');
  assert.deepEqual(
    keys.map((k) => k.key),
    ['a', 'b', 'value'],
  );
});

test('findObservedKeys: flags only keys in the observation set, ignores stable names', () => {
  const session = mkSession();
  recordObservations(session, ['__app', 'me', 'o']); // observed names
  // 'cookie' would be in STABLE_API_NAMES, ignored even if observed.

  const flagged = findObservedKeys('window.__app.me.o.nonce', session);
  // 'nonce' was NOT observed; '__app', 'me', 'o' were.
  const keys = flagged.map((f) => f.key).sort();
  assert.deepEqual(keys, ['__app', 'me', 'o']);
});

test('findObservedKeys: stable contract path is never flagged', () => {
  const session = mkSession();
  // Even if 'cookie' or 'value' somehow got recorded (they shouldn't),
  // findObservedKeys filters them via STABLE_API_NAMES.
  recordObservations(session, ['cookie', 'value']);
  const flagged = findObservedKeys('document.cookie', session);
  assert.deepEqual(flagged, []);
});

test('findObservedKeys: long obfuscated names are flagged just like short ones', () => {
  const session = mkSession();
  recordObservations(session, ['__store_xyz123', 'userMessages_a4b']);
  const flagged = findObservedKeys('window.__store_xyz123.userMessages_a4b.send', session);
  const keys = flagged.map((f) => f.key).sort();
  assert.deepEqual(keys, ['__store_xyz123', 'userMessages_a4b']);
});

test('findObservedKeys: returns [] when observation set is empty', () => {
  const session = mkSession();
  const flagged = findObservedKeys('window.__app.me.o.nonce', session);
  assert.deepEqual(flagged, []);
});

test('STABLE_API_NAMES: contains expected DOM/JS standards', () => {
  for (const k of [
    'cookie',
    'value',
    'href',
    'pathname',
    'body',
    'document',
    'target',
    'length',
    'constructor',
    'args',
  ]) {
    assert.ok(STABLE_API_NAMES.has(k), `expected ${k} in STABLE_API_NAMES`);
  }
});
