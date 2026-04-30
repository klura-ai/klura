// Tests for the save-time probe's retry-once behavior on transient
// navigation-induced "context destroyed" errors. The retry is tight
// on purpose: it recovers from the specific mid-eval navigation flake
// observed on MediaWiki / SPA-rehydrating pages, but never hides
// genuine expression bugs (SyntaxError, missing globals, TypeError).

import test from 'node:test';
import assert from 'node:assert/strict';

const { isTransientNavigationError } = await import('../dist/strategies/probe/index.js');

test('isTransientNavigationError: matches "Execution context was destroyed"', () => {
  assert.strictEqual(
    isTransientNavigationError(new Error('Execution context was destroyed, most likely because of a navigation')),
    true,
  );
  assert.strictEqual(
    isTransientNavigationError(new Error('page.evaluate: Execution context was destroyed')),
    true,
  );
});

test('isTransientNavigationError: matches "frame was detached"', () => {
  assert.strictEqual(
    isTransientNavigationError(new Error('locator.click: Frame was detached')),
    true,
  );
});

test('isTransientNavigationError: matches "target closed"', () => {
  assert.strictEqual(
    isTransientNavigationError(new Error('page.evaluate: Target closed')),
    true,
  );
});

test('isTransientNavigationError: does NOT match real expression errors', () => {
  assert.strictEqual(
    isTransientNavigationError(new Error('SyntaxError: missing ) after argument list')),
    false,
  );
  assert.strictEqual(
    isTransientNavigationError(new Error("TypeError: Cannot read properties of undefined (reading 'tokens')")),
    false,
  );
  assert.strictEqual(
    isTransientNavigationError(new Error('ReferenceError: mw is not defined')),
    false,
  );
  assert.strictEqual(
    isTransientNavigationError(new Error('page.evaluate: Timeout 5000ms exceeded')),
    false,
  );
});

test('isTransientNavigationError: non-Error inputs', () => {
  assert.strictEqual(isTransientNavigationError('Execution context was destroyed'), true);
  assert.strictEqual(isTransientNavigationError(null), false);
  assert.strictEqual(isTransientNavigationError(undefined), false);
  assert.strictEqual(isTransientNavigationError({}), false);
});

// End-to-end retry-loop behavior is exercised via field-report manual
// rerun — the probe path depends on a live browser session / Playwright
// pool that's expensive to stub unit-wise. The predicate above is the
// load-bearing decision; if it classifies errors right, the retry-once
// loop in probeOneJsEvalPrereq does the right thing mechanically.
