// Unit tests for the centralized did-you-mean helper. Every save-time
// validator that rejects an unknown field or invalid enum value routes
// through `didYouMeanSuffix`, so when the agent passes a close-miss value
// the rejection message names the likely intended value.

import test from 'node:test';
import assert from 'node:assert';

const { closestAllowed, didYouMeanSuffix, asEnum } = await import(
  '../dist/validators.js'
);

// ---- closestAllowed: the pure fuzzy-match core ----

test('closestAllowed: exact case-insensitive match returns null (not a typo)', () => {
  // If the value IS in the allowed set, caller wouldn't have rejected;
  // this helper specifically helps when the input is wrong.
  assert.strictEqual(closestAllowed('foo', ['foo', 'bar']), null);
});

test('closestAllowed: single-char typo is suggested', () => {
  assert.strictEqual(closestAllowed('iteration', ['verify_iterations', 'at', 'last_diff']), null);
  // "iteratoin" is 1 transposition from "iteration" which is not in the set;
  // the function only suggests from the ALLOWED list.
  assert.strictEqual(closestAllowed('verify_iteratoins', ['verify_iterations', 'at']), 'verify_iterations');
});

test('closestAllowed: plural-vs-singular is recognized', () => {
  assert.strictEqual(closestAllowed('iterations', ['verify_iterations']), null); // too far
  assert.strictEqual(closestAllowed('verify_iteration', ['verify_iterations']), 'verify_iterations');
});

test('closestAllowed: unrelated values return null', () => {
  assert.strictEqual(closestAllowed('xyz', ['foo', 'bar', 'baz']), null);
});

test('closestAllowed: picks the closest when multiple are close', () => {
  assert.strictEqual(
    closestAllowed('ws_1', ['ws_i', 'request_i', 'endpoint']),
    'ws_i',
  );
});

test('closestAllowed: gave_up enum typo suggests correct value', () => {
  const allowed = ['turn_budget', 'diverged', 'blocked', 'one_capture_insufficient', 'other'];
  assert.strictEqual(closestAllowed('diverge', allowed), 'diverged');
  assert.strictEqual(closestAllowed('turn_bugdet', allowed), 'turn_budget');
  assert.strictEqual(closestAllowed('blockd', allowed), 'blocked');
});

test('closestAllowed: empty input returns null', () => {
  assert.strictEqual(closestAllowed('', ['foo']), null);
});

test('closestAllowed: short-string strict threshold', () => {
  // 4-char strings only suggest when edit distance == 1.
  assert.strictEqual(closestAllowed('aaaa', ['bbbb']), null); // dist 4, rejected
  assert.strictEqual(closestAllowed('aabc', ['abbc']), 'abbc'); // dist 1, accepted
});

// ---- didYouMeanSuffix: the string suffix form ----

test('didYouMeanSuffix: returns empty when no close match', () => {
  assert.strictEqual(didYouMeanSuffix('xyz', ['foo', 'bar']), '');
});

test('didYouMeanSuffix: formats the suggestion', () => {
  assert.strictEqual(
    didYouMeanSuffix('diverge', ['diverged', 'blocked']),
    ' — did you mean "diverged"?',
  );
});

// ---- integration: asEnum surfaces did-you-mean in its error ----

test('asEnum: typo produces did-you-mean suggestion in thrown error', () => {
  assert.throws(
    () => asEnum('diverge', 'gave_up', ['diverged', 'blocked', 'other']),
    (err) => {
      assert.match(err.message, /is not allowed/);
      assert.match(err.message, /did you mean "diverged"/);
      return true;
    },
  );
});

test('asEnum: unrelated value does NOT add did-you-mean', () => {
  assert.throws(
    () => asEnum('xyz', 'gave_up', ['diverged', 'blocked', 'other']),
    (err) => {
      assert.match(err.message, /is not allowed/);
      assert.doesNotMatch(err.message, /did you mean/);
      return true;
    },
  );
});
