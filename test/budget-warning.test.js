// composeBudgetWarning: surfaces a `_hint`-style nudge on long-lived
// sessions so agents see the budget before getting SIGKILLed by an
// orchestrator wall-clock cap. Soft cap is 12 minutes; below that
// returns null.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { composeBudgetWarning } = await import(
  '../dist/session-obligations/budget-warning.js'
);

test('fresh session (startedAt now) → no warning', () => {
  const session = { id: 'sess-fresh', startedAt: Date.now() };
  assert.equal(composeBudgetWarning(session), null);
});

test('session > 12 minutes old → warning includes elapsed minutes + wrap-up surfaces', () => {
  const session = {
    id: 'sess-old',
    startedAt: Date.now() - 13 * 60 * 1000,
  };
  const warning = composeBudgetWarning(session);
  assert.ok(warning);
  assert.match(warning, /~13 minutes/);
  assert.match(warning, /end_drive/);
  assert.match(warning, /abort_session/);
});

test('session without startedAt → null (defensive; older sessions may pre-date the field)', () => {
  const session = { id: 'sess-no-stamp' };
  assert.equal(composeBudgetWarning(session), null);
});

test('session right at the soft cap (12m) → no warning (strict <)', () => {
  const session = {
    id: 'sess-edge',
    startedAt: Date.now() - 12 * 60 * 1000 + 100, // 100ms under the cap
  };
  assert.equal(composeBudgetWarning(session), null);
});
