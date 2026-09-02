// The end-drive orchestrator's already_closed no-op must still release the
// pool entry. The execute-graph FSM stamps terminal{closed} on auto-exec
// success without touching the pool, so the agent's follow-up end_drive is
// where the id actually dies: the session leaves pool._sessions, its
// session-scope hooks run, and Pool.busy() can go quiet. Without the
// release, every execute-graph success pins a session (and, on the browser
// path, a warm slot with inUse: true) until process exit.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-end-drive-closed-'));
process.env.KLURA_HOME = TMP;

const { endDrive } = await import('../dist/phases/drive/end-drive-orchestrator.js');
const runtimeState = await import('../dist/runtime-state/index.js');
const scope = await import('../dist/pool/session-scope.js');

test.after(async () => {
  await runtimeState.pool.shutdown();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('already_closed end_drive releases the pool entry and runs scope disposal', async () => {
  const pool = runtimeState.pool;
  // Model the execute-graph fast path: node-only session shell, FSM already
  // stamped terminal{closed} by dispatchExecuteGraphOutcome.
  const session = pool.createNodeOnlySession({ platform: 'closed-release-p' });
  session.graph = 'execute';
  session.status = 'closed';

  let hookRuns = 0;
  scope.onSessionDispose(session.id, 'test-hook', () => {
    hookRuns += 1;
  });

  const before = pool.activeSessions;
  const result = await endDrive(session.id, {});

  assert.equal(result.ok, true);
  assert.equal(result.already_closed, true);
  assert.equal(pool.peekSession(session.id), null, 'pool entry released on already-closed close');
  assert.equal(pool.activeSessions, before - 1);
  assert.equal(hookRuns, 1, 'session-scope disposal ran for the dying id');
});
