// An HTML extract that hands the caller a serialized JSON document instead of
// a value from inside it is an ackable save-probe advisory, plus the probe/
// execute parity that makes the advisory meaningful: `json` has to survive the
// probe's spec narrowing, or the probe would validate a different extraction
// than warm execute performs.

import test from 'node:test';
import assert from 'node:assert';
import {
  assertNoUnpathedJsonBlobs,
  extractFetchHtmlExtracts,
} from '../dist/strategies/probe/fetch-html.js';
import { WARNING_KINDS } from '../dist/vocab/index.js';

const KIND = WARNING_KINDS.htmlExtractReturnsJsonBlob;
const URL_UNDER_PROBE = 'https://example.test/@someone';

function specFor(extract) {
  return { url: URL_UNDER_PROBE, extract };
}

test('json survives the probe spec narrowing (probe/execute parity)', () => {
  const [spec] = extractFetchHtmlExtracts({
    strategy: 'fetch',
    baseUrl: 'https://example.test',
    endpoint: '/@{{username}}',
    response: {
      format: 'html',
      extract: {
        followers: { selector: '#d', json: '__SCOPE__["a.b"].followerCount' },
        title: { selector: 'h1' },
      },
    },
  });
  assert.equal(spec.extract.followers.json, '__SCOPE__["a.b"].followerCount');
  assert.equal(spec.extract.title.json, undefined);
});

test('a leaf returning a serialized JSON document is flagged', () => {
  const blob = JSON.stringify({ userInfo: { stats: { followerCount: 9600000 } }, seo: {} });
  assert.throws(
    () =>
      assertNoUnpathedJsonBlobs(
        specFor({ profileJson: { selector: 'script#__DATA__' } }),
        { profileJson: blob },
        new Set(),
      ),
    (err) => {
      assert.match(err.message, new RegExp(`invalid_strategy: ${KIND}`));
      // Names the offending entry, the size, and what to descend into.
      assert.match(err.message, /response\.extract\.profileJson/);
      assert.match(err.message, /userInfo, seo/);
      // Teaches the fix inline, including the dotted-key trap.
      assert.match(err.message, /json: "a\.b\.c"|json` dot-path/);
      assert.match(err.message, /Bracket-quote any key containing a dot/);
      return true;
    },
  );
});

test('flagging is decided on the extracted bytes, not the selector spelling', () => {
  // `#__DATA__` never says "script" — a shape-only check would miss it, which
  // is the whole reason this runs on probe output.
  const blob = JSON.stringify({ a: 1 });
  assert.throws(
    () =>
      assertNoUnpathedJsonBlobs(specFor({ d: { selector: '#__DATA__' } }), { d: blob }, new Set()),
    new RegExp(KIND),
  );
});

test('a leaf that already declares json is never flagged', () => {
  assert.doesNotThrow(() =>
    assertNoUnpathedJsonBlobs(
      specFor({ followers: { selector: '#d', json: 'userInfo.stats.followerCount' } }),
      { followers: 9600000 },
      new Set(),
    ),
  );
});

test('ordinary text and attribute reads are never flagged', () => {
  assert.doesNotThrow(() =>
    assertNoUnpathedJsonBlobs(
      specFor({
        title: { selector: 'h1' },
        rows: { selector: '.row', multiple: true },
        // Digits parse as JSON but are not a document — only objects/arrays count.
        count: { selector: '.count' },
      }),
      { title: 'National Geographic', rows: ['a', 'b'], count: '1447' },
      new Set(),
    ),
  );
});

test('the advisory clears when the author acks the kind', () => {
  const blob = JSON.stringify({ a: 1 });
  assert.doesNotThrow(() =>
    assertNoUnpathedJsonBlobs(
      specFor({ d: { selector: '#__DATA__' } }),
      { d: blob },
      new Set([KIND]),
    ),
  );
});

test('every flagged entry is named in one rejection, not one at a time', () => {
  const blob = JSON.stringify({ a: 1 });
  assert.throws(
    () =>
      assertNoUnpathedJsonBlobs(
        specFor({ one: { selector: '#a' }, two: { selector: '#b' }, ok: { selector: 'h1' } }),
        { one: blob, two: blob, ok: 'plain text' },
        new Set(),
      ),
    (err) => {
      assert.match(err.message, /response\.extract\.one/);
      assert.match(err.message, /response\.extract\.two/);
      assert.equal(/response\.extract\.ok\b/.test(err.message), false);
      assert.match(err.message, /2 extract entries/);
      return true;
    },
  );
});
