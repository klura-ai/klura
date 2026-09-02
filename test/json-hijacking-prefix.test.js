// Anti-JSON-hijacking guards on a response body.
//
// A server that prepends `)]}'` to its JSON breaks a plain `JSON.parse`, and
// the Node transport's fallback hands the raw text back to the caller. The
// capability then saves clean and returns a string where rows were promised —
// there is no extract to come up empty and no status to inspect, so nothing
// downstream notices.
//
// Observed on the map fixture: three capabilities saved a `fetch` with
// `response.format: "json"` against a `)]}'`-prefixed body and every one
// returned nothing.

import test from 'node:test';
import assert from 'node:assert';
import {
  stripJsonHijackingPrefix,
  parseJsonAllowingHijackingPrefix,
} from '../dist/response/json-hijacking-prefix.js';

test('strips each guard in common use, with or without a trailing newline', () => {
  assert.deepEqual(stripJsonHijackingPrefix(")]}'\n[1]"), { text: '[1]', prefix: ")]}'" });
  assert.deepEqual(stripJsonHijackingPrefix(")]}',\n[1]"), { text: '[1]', prefix: ")]}'," });
  assert.deepEqual(stripJsonHijackingPrefix(")]}'[1]"), { text: '[1]', prefix: ")]}'" });
  assert.deepEqual(stripJsonHijackingPrefix(")]}'\r\n[1]"), { text: '[1]', prefix: ")]}'" });
  assert.deepEqual(stripJsonHijackingPrefix('for(;;);[1]'), { text: '[1]', prefix: 'for(;;);' });
  assert.deepEqual(stripJsonHijackingPrefix('while(1);[1]'), { text: '[1]', prefix: 'while(1);' });
});

test('a body with no guard is returned byte-identical', () => {
  const body = '{"a":1}';
  assert.deepEqual(stripJsonHijackingPrefix(body), { text: body, prefix: null });
});

test('parses guarded bodies and reports which guard was removed', () => {
  assert.deepEqual(parseJsonAllowingHijackingPrefix(")]}'\n[1,2]"), {
    value: [1, 2],
    prefix: ")]}'",
  });
  assert.deepEqual(parseJsonAllowingHijackingPrefix('{"a":1}'), { value: { a: 1 }, prefix: null });
});

test('a plain parse is attempted first, so valid JSON is never disturbed', () => {
  // The guard bytes appear INSIDE the document. Stripping first would corrupt
  // it; parsing first returns it intact.
  const body = JSON.stringify({ s: ")]}'" });
  const parsed = parseJsonAllowingHijackingPrefix(body);
  assert.deepEqual(parsed.value, { s: ")]}'" });
  assert.equal(parsed.prefix, null);
});

test('a body that is not JSON either way stays unparsed', () => {
  assert.equal(parseJsonAllowingHijackingPrefix('<html>nope</html>'), undefined);
  assert.equal(parseJsonAllowingHijackingPrefix(")]}'\nstill not json"), undefined);
  assert.equal(parseJsonAllowingHijackingPrefix(''), undefined);
});
