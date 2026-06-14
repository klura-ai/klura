// refreshRecencyStats computes sessions_since_last_attempt as a true delta
// against the sessions_total snapshot taken when the lift_attempt was recorded —
// NOT against sessions_contributed (an unrelated counter: how many sessions
// touched this capability). A capability contributed in every session would
// otherwise report a near-zero "sessions since" even after many intervening
// platform sessions.

import test from 'node:test';
import assert from 'node:assert/strict';

const { refreshRecencyStats } = await import('../dist/working-dir/logbook.js');

function entryWith(lastAttempt, sessionsContributed) {
  return {
    sessions_contributed: sessionsContributed,
    lift_attempts: lastAttempt ? [lastAttempt] : [],
  };
}

test('delta is current sessions_total minus the attempt-time snapshot', () => {
  const entry = entryWith(
    { attempted_at: new Date().toISOString(), sessions_total_at_attempt: 3 },
    99, // sessions_contributed is irrelevant to the delta
  );
  refreshRecencyStats(entry, 10);
  assert.equal(entry.sessions_since_last_attempt, 7);
});

test('zero intervening sessions right after the attempt is recorded', () => {
  const entry = entryWith(
    { attempted_at: new Date().toISOString(), sessions_total_at_attempt: 10 },
    1,
  );
  refreshRecencyStats(entry, 10);
  assert.equal(entry.sessions_since_last_attempt, 0);
});

test('does not go negative when the snapshot is somehow ahead', () => {
  const entry = entryWith(
    { attempted_at: new Date().toISOString(), sessions_total_at_attempt: 12 },
    1,
  );
  refreshRecencyStats(entry, 10);
  assert.equal(entry.sessions_since_last_attempt, 0);
});

test('legacy attempt without a snapshot leaves the field unknown, not wrong', () => {
  const entry = entryWith({ attempted_at: new Date().toISOString() }, 5);
  entry.sessions_since_last_attempt = 999; // stale value must be cleared
  refreshRecencyStats(entry, 10);
  assert.equal(entry.sessions_since_last_attempt, undefined);
});

test('no lift_attempts clears all recency fields', () => {
  const entry = entryWith(null, 5);
  entry.sessions_since_last_attempt = 3;
  entry.days_since_last_attempt = 2;
  entry.last_lift_attempt_at = 'x';
  refreshRecencyStats(entry, 10);
  assert.equal(entry.sessions_since_last_attempt, undefined);
  assert.equal(entry.days_since_last_attempt, undefined);
  assert.equal(entry.last_lift_attempt_at, undefined);
});
