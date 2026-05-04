// Map-graph end_drive tests. Two guarantees:
//   (a) graph: 'map' end_drive skips auto-synth (records skip diagnostic).
//   (b) graph: 'discover' end_drive runs auto-synth (existing behavior).
//
// No real browser is spun up — these exercise the orchestrator directly.
// Browser-driven integration coverage lives in llm-tests/scenarios.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-map-mode-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// Late-bind the runtime barrel after KLURA_HOME is set.
const { endDrive } = await import('../dist/end-drive/orchestrator.js');
const { pool } = await import('../dist/runtime-state.js');

function fakeSessionShell({ graph, sessionId }) {
  return {
    id: sessionId,
    graph,
    platform: 'pm-test',
    declaredCapabilities: [],
    savedCapabilities: [],
    performActionHistory: [],
    artifactAccumulator: undefined,
    endDriveAttempts: 0,
    domNavigations: [],
    domFormsObserved: [],
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

test("graph: 'map' end_drive: auto-synth skipped, diagnostic emitted", async () => {
  const session = fakeSessionShell({ graph: 'map', sessionId: 'sess-map-1' });
  // One non-mutating perform_action so re-persistence gate doesn't fire.
  session.performActionHistory = [
    { at: Date.now(), action: 'navigate', url: 'https://x' },
  ];
  const restore = patchPool(session);
  try {
    const result = await endDrive(session.id, { platform: 'pm-test' });
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
    const synth = result._diagnostics?.synth ?? [];
    const skipEntries = synth.filter((s) => s.outcome === 'auto_synth_disabled');
    assert.ok(skipEntries.length >= 1, `expected auto_synth_disabled skip, got ${JSON.stringify(synth)}`);
    assert.equal(result.auto_synthesized, undefined, "no synth output for graph: 'map'");
  } finally {
    restore();
  }
});

test("graph: 'discover' end_drive: auto-synth runs (no skip diagnostic)", async () => {
  const session = fakeSessionShell({ graph: 'discover', sessionId: 'sess-task-1' });
  session.performActionHistory = [];
  const restore = patchPool(session);
  try {
    const result = await endDrive(session.id, { platform: 'pm-test' });
    assert.equal(result.ok, true);
    const synth = result._diagnostics?.synth ?? [];
    const skipEntries = synth.filter((s) => s.outcome === 'auto_synth_disabled');
    assert.equal(skipEntries.length, 0, "graph: 'discover' must not emit auto_synth_disabled skip");
  } finally {
    restore();
  }
});
