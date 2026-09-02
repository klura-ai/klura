// Round accounting fires at exactly one point: the phase middleware's
// dispatch boundary. One admitted non-universal tool call = one pool round
// + one per-phase counter tick. Handler-side pool.getSession lookups add
// nothing; universal tools add nothing. Also covers the end_drive
// repeat-close detector, which compares the pool round count against the
// snapshot stamped at the previous close attempt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-round-accounting-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { pool } = await import('../dist/runtime-state/index.js');
const { assertToolAdmissibleBySessionId, ToolNotAdmissibleError } = await import(
  '../dist/phases/middleware.js'
);
const { dispatch } = await import('../dist/phases/state-machine.js');
const { computeReverseEngineerHandoff } = await import(
  '../dist/phases/drive/drive-to-triage-handoff.js'
);

function liftSession() {
  const session = pool.createNodeOnlySession({ platform: 'round-accounting-test' });
  dispatch(session, { kind: 'end_drive_unresolved' }); // drive → triage
  dispatch(session, { kind: 'plan_handoff' }); // triage → lift
  return session;
}

test('one admitted lift call = +1 lift round and +1 pool round; lookups add nothing', () => {
  const session = liftSession();
  assert.equal(session.lift.roundsSinceHandoff, 0);
  assert.equal(pool.getSessionRoundCount(session.id), 0);

  assertToolAdmissibleBySessionId(session.id, 'get_network_log');
  assert.equal(session.lift.roundsSinceHandoff, 1, 'exactly one tick per admitted call');
  assert.equal(pool.getSessionRoundCount(session.id), 1, 'exactly one pool round per call');

  // Handler-style lookups — however many a handler makes — register nothing.
  for (let i = 0; i < 4; i += 1) pool.getSession(session.id);
  assert.equal(session.lift.roundsSinceHandoff, 1);
  assert.equal(pool.getSessionRoundCount(session.id), 1);
});

test('universal tools burn no budget and register no round', () => {
  const session = liftSession();
  assertToolAdmissibleBySessionId(session.id, 'list_platform_skills');
  assert.equal(session.lift.roundsSinceHandoff, 0);
  assert.equal(pool.getSessionRoundCount(session.id), 0);
});

test('triage-phase calls tick triage only — session.lift stays untouched', () => {
  const session = pool.createNodeOnlySession({ platform: 'round-accounting-test' });
  dispatch(session, { kind: 'end_drive_unresolved' }); // drive → triage
  assert.equal(session.lift, undefined, 'lift struct absent until lift entry');

  assertToolAdmissibleBySessionId(session.id, 'get_network_log');
  assert.equal(session.triage.roundsSinceEntry, 1);
  assert.equal(
    session.lift,
    undefined,
    'triage activity must not create or charge the lift budget',
  );
});

test('soft block engages exactly at the lift budget', () => {
  const session = liftSession();
  session.lift.budget = 3;

  assertToolAdmissibleBySessionId(session.id, 'get_network_log'); // 1
  assertToolAdmissibleBySessionId(session.id, 'get_network_log'); // 2
  assert.equal(session.lift.softBlockEngaged, false, 'under budget');
  assertToolAdmissibleBySessionId(session.id, 'get_network_log'); // 3 = budget
  assert.equal(session.lift.softBlockEngaged, true, 'engaged at budget');

  // RE-active tools are now blocked; the exhausted allowlist still admits.
  assert.throws(
    () => assertToolAdmissibleBySessionId(session.id, 'get_network_log'),
    ToolNotAdmissibleError,
  );
  assertToolAdmissibleBySessionId(session.id, 'save_strategy');
});

// ---- end_drive repeat-close detector ----

function handoffSession(platform) {
  // No strategy on disk under the isolated KLURA_HOME → the declared
  // capability is unresolved → computeReverseEngineerHandoff returns a
  // handoff (never null).
  const session = pool.createNodeOnlySession({ platform });
  session.graph = 'discover';
  session.declaredCapabilities = [{ capability: 'list_items', args: {}, declared_at: Date.now() }];
  return session;
}

test('repeat-close: unchanged round count at attempt ≥ 2 → REPEAT-CLOSE message', () => {
  const session = handoffSession('repeat-close-a');
  for (let i = 0; i < 3; i += 1) pool.registerUserRound(session.id);
  session.endDriveAttempts = 2;
  // The orchestrator stamps this snapshot when a handoff fires; the repeat
  // end_drive itself registers at most one more round.
  session.roundCountAtLastCloseAttempt = pool.getSessionRoundCount(session.id);

  const handoff = computeReverseEngineerHandoff(session, 'repeat-close-a');
  assert.ok(handoff, 'unresolved capability produces a handoff');
  assert.match(handoff.message, /REPEAT-CLOSE DETECTED/);
});

test('repeat-close: intervening rounds since the snapshot → normal handoff', () => {
  const session = handoffSession('repeat-close-b');
  for (let i = 0; i < 3; i += 1) pool.registerUserRound(session.id);
  session.endDriveAttempts = 2;
  session.roundCountAtLastCloseAttempt = pool.getSessionRoundCount(session.id);
  // Agent did real work between closes: two more admitted rounds.
  pool.registerUserRound(session.id);
  pool.registerUserRound(session.id);

  const handoff = computeReverseEngineerHandoff(session, 'repeat-close-b');
  assert.ok(handoff);
  assert.doesNotMatch(handoff.message, /REPEAT-CLOSE DETECTED/);
});

test('repeat-close: never fires on the first close attempt', () => {
  const session = handoffSession('repeat-close-c');
  const handoff = computeReverseEngineerHandoff(session, 'repeat-close-c');
  assert.ok(handoff);
  assert.doesNotMatch(handoff.message, /REPEAT-CLOSE DETECTED/);
});
