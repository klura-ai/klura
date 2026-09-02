// Regression: the end_drive `silent_no_save` guard must not fire when every
// declared capability is already resolved by a strategy on disk.
//
// Repro shape (github/create_issue warm run): a warm session declares
// `create_issue`, which already has a saved strategy from a prior session.
// The agent re-drives the UI, saves nothing new, then calls end_drive. The
// drive→triage handoff is skipped (capability resolved), so the agent acks
// the triage_acknowledgment warning — and `silent_no_save` must not fire
// after it, because its premise ("closing would leave nothing on disk") is
// false: the prior strategy is still there. Firing there deadlocks the
// session, since save_strategy and submit_triage_plan are both inadmissible
// from drive.
//
// The guard now gates on `triageWouldFire` — it fires only when a declared
// capability is genuinely unresolved (no non-stale saved strategy on disk).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-silent-no-save-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { endDrive } = await import('../dist/phases/drive/end-drive-orchestrator.js');
const { pool } = await import('../dist/runtime-state/index.js');

function writeSavedStrategy(platform, capability) {
  const dir = path.join(TMP, 'skills', platform, 'fetch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${capability}.json`),
    JSON.stringify({
      strategy: 'fetch',
      baseUrl: 'https://example.test',
      endpoint: '/',
      method: 'GET',
      schema_version: 1,
    }),
  );
}

function fakeSessionShell({ sessionId, platform, capability, lift }) {
  return {
    id: sessionId,
    graph: 'discover',
    platform,
    declaredCapabilities: capability ? [{ capability, args: {}, declared_at: Date.now() }] : [],
    savedCapabilities: [],
    performActionHistory: [],
    artifactAccumulator: undefined,
    endDriveAttempts: 0,
    domNavigations: [],
    domFormsObserved: [],
    intercepted: [],
    lift,
    // A session with lift bookkeeping is in the lift phase — the state
    // machine is the only writer of both fields, so they travel together.
    ...(lift ? { phase: 'lift', liftHandoffAt: Date.now() } : {}),
  };
}

function patchPool(session) {
  const fakeDriver = {
    cleanupDebuggerState: async () => {},
    getInterceptedRequests: async () => [],
    getInterceptedWebSocketFrames: async () => [],
    getDebuggerPauseState: () => null,
    saveStorageState: async () => {},
  };
  const origGet = pool.getSession;
  const origDriver = pool.driverFor;
  const origClose = pool.endDrive;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.driverFor = (id) => (id === session.id ? fakeDriver : origDriver.call(pool, id));
  pool.endDrive = async (id) => {
    if (id === session.id) return;
    return origClose.call(pool, id);
  };
  return () => {
    pool.getSession = origGet;
    pool.driverFor = origDriver;
    pool.endDrive = origClose;
  };
}

test('silent_no_save: closes clean when the declared capability is already saved on disk', async () => {
  const platform = 'silent-test';
  const capability = 'create_issue';
  writeSavedStrategy(platform, capability);

  const session = fakeSessionShell({
    sessionId: 'sess_already_saved',
    platform,
    capability,
  });
  const restore = patchPool(session);
  try {
    // First end_drive: the capability is resolved → triage handoff would be
    // skipped → the triage_acknowledgment warning fires.
    const first = await endDrive(session.id, {});
    assert.equal(
      first.phase,
      'end_drive_audit',
      `expected audit gate, got ${JSON.stringify(first)}`,
    );
    assert.match(
      first.message ?? '',
      /triage_acknowledgment/,
      `expected the triage_acknowledgment warning, got: ${first.message}`,
    );

    // Second end_drive: ack the triage skip. The audit passes; auto-synth
    // produces nothing (empty action history). triageWouldFire is false
    // (capability resolved on disk), so the silent_no_save guard stays silent
    // and the session closes.
    const second = await endDrive(session.id, {
      acks: {
        triage_acknowledgment:
          'create_issue already has a saved fetch strategy on disk; no graduation candidate observed',
      },
    });
    assert.ok(
      !String(second.message ?? '').includes('silent_no_save'),
      `silent_no_save must not fire when the capability is already saved — got ${JSON.stringify(second)}`,
    );
    assert.equal(second.ok, true, `expected a clean close, got ${JSON.stringify(second)}`);
    assert.equal(
      second.phase,
      undefined,
      'a resolved capability closes terminally, no further phase',
    );
  } finally {
    restore();
  }
});

test('silent_no_save: still fires when a declared capability is genuinely unresolved', async () => {
  // No strategy on disk → the capability is unresolved → triageWouldFire is
  // true. The session is on the abandon-from-lift path (in lift phase, prior
  // handoff fired), so the orchestrator skips the LIFT handoff and reaches
  // the guard. With
  // nothing saved and nothing auto-synthesized, the guard must still reject:
  // closing here genuinely would leave nothing on disk.
  const session = fakeSessionShell({
    sessionId: 'sess_unresolved',
    platform: 'silent-test-unresolved',
    capability: 'list_things',
    lift: { handoffAt: Date.now(), roundsSinceHandoff: 0, budget: 0, softBlockEngaged: false },
  });
  const restore = patchPool(session);
  try {
    const result = await endDrive(session.id, {});
    assert.ok(
      String(result.message ?? '').includes('silent_no_save'),
      `expected silent_no_save rejection for an unresolved capability, got ${JSON.stringify(result)}`,
    );
    assert.equal(result.ok, false);
  } finally {
    restore();
  }
});
