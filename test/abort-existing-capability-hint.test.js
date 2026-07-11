// `abort_session(kind: "existing_capability_covers")` must tell the agent that
// the saved strategy has NOT run yet.
//
// This is the one abort kind that names work still to be done: the agent claims
// a saved capability covers the task, but aborting only closes the session.
// Observed failure without the hint: the agent aborts with that kind, reports
// the task done, and the saved strategy never executes. The next call belongs on
// the response the agent is already reading, not in a SKILL.md line it may skip.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-abort-existing-cap-hint-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { abortSession } = await import('../dist/tools/abort_session.js');
const { pool } = await import('../dist/runtime-state/index.js');
const { registerCheckpointHandler, unregisterCheckpointHandler } = await import(
  '../dist/checkpoints/index.js'
);

// `continue` resolution means abort_session runs the teardown inline and
// returns the terminal shape — the path the hint rides on.
registerCheckpointHandler({
  name: 'abort-hint-test-auto-continue',
  kinds: ['abort_session_consent'],
  async handle() {
    return { status: 'continue' };
  },
});
process.on('exit', () => unregisterCheckpointHandler('abort-hint-test-auto-continue'));

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

function patchPool(session) {
  const origGet = pool.getSession;
  const origEnd = pool.endDrive;
  const origDriver = pool.driverFor;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.endDrive = async (id) => {
    if (id === session.id) return;
    return origEnd.call(pool, id);
  };
  pool.driverFor = (id) => {
    if (id === session.id) return { saveStorageState: async () => {} };
    return origDriver.call(pool, id);
  };
  return () => {
    pool.getSession = origGet;
    pool.endDrive = origEnd;
    pool.driverFor = origDriver;
  };
}

test('existing_capability_covers abort carries a hint naming the execute call', async () => {
  const session = makeFakeSession('sess_hint_yes', 'hint-platform-yes');
  const restore = patchPool(session);
  try {
    const result = await abortSession({
      session_id: session.id,
      reason: 'existing capability find_top_restaurants covers this — running the saved strategy instead',
      kind: 'existing_capability_covers',
    });
    assert.equal(result.ok, true);
    assert.equal(result.aborted, true);
    const hint = String(result._hint ?? '');
    assert.ok(hint, 'a hint is attached for existing_capability_covers');
    assert.match(hint, /has NOT run/i, 'hint states the strategy did not run');
    assert.match(hint, /start_session/, 'hint names the real tool');
    assert.match(hint, /graph: "execute"/, 'hint names the execute graph');
    assert.ok(hint.length < 300, `hint stays inside the _hint budget (got ${hint.length})`);
  } finally {
    restore();
  }
});

test('other abort kinds carry no execute hint', async () => {
  const session = makeFakeSession('sess_hint_no', 'hint-platform-no');
  const restore = patchPool(session);
  try {
    const result = await abortSession({
      session_id: session.id,
      reason: 'site is blocked — exhausted alternate entry paths and gate RE attempts',
      kind: 'origin_blocked',
    });
    assert.equal(result.ok, true);
    assert.equal(result.aborted, true);
    assert.equal(result._hint, undefined, 'no execute hint on an unrelated abort kind');
  } finally {
    restore();
  }
});
