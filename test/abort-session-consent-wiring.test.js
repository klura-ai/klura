// Integration: the abort_session_consent deferred-action wiring.
//
// `abort_session` stages `session.pendingAbort` and emits the
// `abort_session_consent` checkpoint via `invokeCheckpointAndGate`.
// `ack_checkpoint` resolves it: consent runs `performAbortTeardown`
// (pool.endDrive + ledger append); decline clears the staged entry and
// tells the agent to keep RE-ing. Without this wiring, the agent's
// `ack_checkpoint("yes")` returned a hint telling them to re-call
// `abort_session`, which re-emitted a fresh consent token → infinite loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-abort-consent-wiring-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { abortSession } = await import('../dist/tools/abort_session.js');
const { ackCheckpoint } = await import('../dist/checkpoints/api.js');
const { registerCheckpointDefaults } = await import('../dist/checkpoints/default-handlers.js');
const { pool } = await import('../dist/runtime-state/index.js');
const { readRecentAborts } = await import('../dist/working-dir/logbook.js');

// Default `abort_session_consent` handler returns `handover` — the agent
// gets an envelope and must `ack_checkpoint` to land the teardown.
registerCheckpointDefaults();

function makeFakeSession(id, platform) {
  return {
    id,
    platform,
    intercepted: [],
    intercepting: false,
    performActionHistory: [],
    phase: 'drive',
    declaredCapabilities: [],
  };
}

function patchPool(session, endDriveSpy) {
  const origGet = pool.getSession;
  const origEnd = pool.endDrive;
  const origDriver = pool.driverFor;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.endDrive = async (id) => {
    if (id === session.id) {
      endDriveSpy.calls++;
      return;
    }
    return origEnd.call(pool, id);
  };
  pool.driverFor = (id) => {
    if (id === session.id) {
      return { saveStorageState: async () => {} };
    }
    return origDriver.call(pool, id);
  };
  return () => {
    pool.getSession = origGet;
    pool.endDrive = origEnd;
    pool.driverFor = origDriver;
  };
}

test('consent ack → performAbortTeardown runs; ledger entry written; pendingAbort cleared', async () => {
  const platform = 'abort-consent-yes';
  const session = makeFakeSession('sess_abort_consent_yes', platform);
  const endDriveSpy = { calls: 0 };
  const restore = patchPool(session, endDriveSpy);
  try {
    // abort_session emits the consent checkpoint and stages pendingAbort.
    const result = await abortSession({
      session_id: session.id,
      reason: 'site is blocked — exhausted alternate entry paths and gate RE attempts',
      kind: 'origin_blocked',
    });
    assert.equal(result.aborted, false, 'aborted=false until consent lands');
    assert.ok(result._checkpoint, 'envelope present on first call');
    assert.equal(result._checkpoint.kind, 'abort_session_consent');
    assert.ok(result._checkpoint.checkpoint_token, 'envelope carries a checkpoint_token');
    assert.ok(session.pendingAbort, 'pendingAbort staged on session');
    assert.equal(session.pendingAbort.kind, 'origin_blocked');
    assert.equal(endDriveSpy.calls, 0, 'pool.endDrive NOT called until consent');

    const ack = await ackCheckpoint({
      session_id: session.id,
      checkpoint_token: result._checkpoint.checkpoint_token,
      user_response: 'yes — exhausted, abort',
    });

    assert.ok(
      String(ack._hint ?? '')
        .toLowerCase()
        .includes('aborted'),
      `expected an aborted hint, got ${JSON.stringify(ack)}`,
    );
    assert.equal(session.pendingAbort, undefined, 'pendingAbort cleared after ack');
    assert.equal(endDriveSpy.calls, 1, 'pool.endDrive called exactly once on consent');
    const aborts = readRecentAborts(platform);
    assert.equal(aborts.length, 1, 'ledger entry written');
    assert.equal(aborts[0].kind, 'origin_blocked');
    assert.equal(aborts[0].session_id, session.id);
  } finally {
    restore();
  }
});

test('regression: consent prompt renders the real abort classification, not the checkpoint kind', async () => {
  // The consent prompt's "(kind: `...`)" slot must show the AbortKind the
  // agent passed to abort_session (typed `abort_kind` on the checkpoint
  // context), not the checkpoint's own kind label.
  const platform = 'abort-consent-prompt';
  const session = makeFakeSession('sess_abort_consent_prompt', platform);
  const endDriveSpy = { calls: 0 };
  const restore = patchPool(session, endDriveSpy);
  try {
    const result = await abortSession({
      session_id: session.id,
      reason: 'origin serves an interstitial block page on every entry path tried',
      kind: 'origin_blocked',
    });
    assert.ok(result._checkpoint, 'envelope present');
    const prompt = String(result._checkpoint.prompt ?? '');
    assert.match(
      prompt,
      /kind: `origin_blocked`/,
      'prompt must render the abort classification the agent passed',
    );
    assert.ok(
      !prompt.includes('kind: `abort_session_consent`'),
      'prompt must not mislabel the abort classification with the checkpoint kind',
    );
    // Clean up the staged abort so this session leaks no pending state.
    await ackCheckpoint({
      session_id: session.id,
      checkpoint_token: result._checkpoint.checkpoint_token,
      cancelled: true,
      reason: 'prompt-content regression check only',
    });
  } finally {
    restore();
  }
});

test('decline ack → no teardown; pendingAbort cleared; agent told to keep trying', async () => {
  const platform = 'abort-consent-no';
  const session = makeFakeSession('sess_abort_consent_no', platform);
  const endDriveSpy = { calls: 0 };
  const restore = patchPool(session, endDriveSpy);
  try {
    const result = await abortSession({
      session_id: session.id,
      reason: 'js challenge persists across nav — considering abort after RE attempts',
      kind: 'origin_blocked',
    });
    assert.ok(result._checkpoint, 'envelope present');
    assert.ok(session.pendingAbort, 'pendingAbort staged');

    const ack = await ackCheckpoint({
      session_id: session.id,
      checkpoint_token: result._checkpoint.checkpoint_token,
      cancelled: true,
      reason: 'try wait + re-snap and the cheap js_eval reads first',
    });

    const hint = String(ack._hint ?? '').toLowerCase();
    assert.ok(
      hint.includes('cancel') || hint.includes('keep') || hint.includes('try'),
      `expected a keep-trying hint, got ${JSON.stringify(ack)}`,
    );
    assert.equal(session.pendingAbort, undefined, 'pendingAbort cleared even on decline');
    assert.equal(endDriveSpy.calls, 0, 'pool.endDrive NOT called on decline');
    const aborts = readRecentAborts(platform);
    assert.equal(aborts.length, 0, 'no ledger entry on decline');
  } finally {
    restore();
  }
});

test('regression: ack consent does NOT require re-calling abort_session (no checkpoint-loop)', async () => {
  // The bug: ack_checkpoint("yes") returned a hint instructing the agent to
  // re-call abort_session. Re-calling re-emitted a fresh checkpoint token and
  // the loop never landed. The fix runs the teardown inline inside
  // ack_checkpoint, so a single (abort_session → ack_checkpoint) pair is
  // sufficient.
  const platform = 'abort-no-loop';
  const session = makeFakeSession('sess_abort_no_loop', platform);
  const endDriveSpy = { calls: 0 };
  const restore = patchPool(session, endDriveSpy);
  try {
    const result = await abortSession({
      session_id: session.id,
      reason: 'site DNS-dead across 4 paths — out-of-band hard block',
      kind: 'site_dead',
    });
    const ack = await ackCheckpoint({
      session_id: session.id,
      checkpoint_token: result._checkpoint.checkpoint_token,
      user_response: 'yes',
    });
    const hint = String(ack._hint ?? '').toLowerCase();
    assert.ok(
      hint.includes('do not call abort_session') || hint.includes('do not re') || hint.includes('not call abort'),
      `ack hint must tell the agent NOT to re-call abort_session, got ${JSON.stringify(ack)}`,
    );
    assert.equal(endDriveSpy.calls, 1, 'a single ack suffices to land the teardown');
  } finally {
    restore();
  }
});
