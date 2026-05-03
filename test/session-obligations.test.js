// Session-obligation lift-required reminder. Pure function over Session
// state — no driver, no pool, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeSessionObligation } = await import('../dist/session-obligations.js');

function mkSession(overrides = {}) {
  return {
    id: 'sess_test',
    intercepted: [],
    intercepting: false,
    ...overrides,
  };
}

test('returns null for read-only session (no perform_action history)', () => {
  const session = mkSession({ performActionHistory: [] });
  assert.equal(computeSessionObligation(session), null);
});

test('returns null when only navigate / wait actions logged', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'navigate', url: 'https://x.test/' },
      { at: 2, action: 'wait' },
    ],
  });
  assert.equal(computeSessionObligation(session), null);
});

test('fires after a click action with no save', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'navigate', url: 'https://x.test/' },
      { at: 2, action: 'click', selector: 'button' },
    ],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
  assert.equal(obl.kind, 'lift_required');
  assert.equal(obl.session_id, 'sess_test');
  assert.equal(obl.mutating_actions, 1);
});

test('fires after a type action with no save', () => {
  const session = mkSession({
    performActionHistory: [{ at: 1, action: 'type', value: 'hello' }],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
  assert.equal(obl.mutating_actions, 1);
});

test('counts all mutating action kinds', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'click' },
      { at: 2, action: 'type', value: 'x' },
      { at: 3, action: 'fill_editor', value: 'y' },
      { at: 4, action: 'key_press', key: 'Enter' },
      { at: 5, action: 'select', value: 'opt' },
      { at: 6, action: 'navigate' },  // not counted
      { at: 7, action: 'wait' },       // not counted
    ],
  });
  const obl = computeSessionObligation(session);
  assert.equal(obl.mutating_actions, 5);
});

test('clears after a save_strategy that came AFTER the last mutation', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'click' },
      { at: 2, action: 'type', value: 'x' },
    ],
    savedCapabilities: [{ capability: 'send_message', at: 3, tier: 'page-script' }],
  });
  assert.equal(computeSessionObligation(session), null);
});

test('re-fires when a fresh mutation happens after a save', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'click' },
      { at: 2, action: 'type', value: 'x' },
    ],
    savedCapabilities: [{ capability: 'send_message', at: 3, tier: 'page-script' }],
  });
  // Add a new mutation after the save:
  session.performActionHistory.push({ at: 4, action: 'click' });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
});

test('respects liftMode: "skip"', () => {
  const session = mkSession({
    liftMode: 'skip',
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  assert.equal(computeSessionObligation(session), null);
});

test('message text mentions end_drive and LIFT', () => {
  const session = mkSession({
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.match(obl.message, /end_drive/);
  assert.match(obl.message, /LIFT/);
  assert.match(obl.message, /klura:\/\/reference/);
});

test('TRIAGE phase points at submit_triage_plan, not save_strategy', () => {
  const session = mkSession({
    phase: 'triage',
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.match(obl.message, /TRIAGE/);
  assert.match(obl.message, /submit_triage_plan/);
  assert.match(obl.message, /DO NOT tell the user the task is complete/);
  assert.doesNotMatch(obl.message, /MUST be `save_strategy`/);
});

test('LIFT phase points at save_strategy with don\'t-claim-done', () => {
  const session = mkSession({
    phase: 'lift',
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.match(obl.message, /LIFT/);
  assert.match(obl.message, /MUST be `save_strategy`/);
  assert.match(obl.message, /DO NOT tell the user the task is complete/);
});
