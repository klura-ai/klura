// restart_runtime must exit the process ONLY when this process is the
// standalone background daemon (a separate CLI client re-dials and respawns
// it). Embedded — klura chat / execute --agent / an MCP host — sharing the
// process with the caller's session, it must refuse instead of exiting, or it
// kills the session with nothing to respawn it. Regression for the crash loop
// where a chat-mode restart_runtime process.exit()'d the REPL and leaked its
// connect-mode Chrome.

import test from 'node:test';
import assert from 'node:assert';

const { restartRuntime } = await import('../dist/tools/config-tools.js');
const { markStandaloneDaemon } = await import('../dist/runtime-state/process-role.js');

// Embedded case FIRST — before markStandaloneDaemon() flips the (one-way) flag.
test('refuses to exit when embedded (not the standalone daemon)', () => {
  const realExit = process.exit;
  let exited = false;
  process.exit = () => {
    exited = true;
  };
  try {
    const r = restartRuntime({});
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /standalone background daemon/);
    // The refusal is synchronous and schedules no exit — give any stray
    // setImmediate a tick to prove it never fires.
    return new Promise((resolve) =>
      setImmediate(() => {
        assert.strictEqual(exited, false, 'embedded restart must not exit the process');
        resolve();
      }),
    );
  } finally {
    process.exit = realExit;
  }
});

test('proceeds to respawn when this process IS the standalone daemon', async () => {
  markStandaloneDaemon();
  const realExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code ?? 0;
  };
  try {
    const r = restartRuntime({});
    assert.strictEqual(r.ok, true);
    assert.match(r.message, /restarting/);
    // The exit is scheduled via setImmediate after an async pool drain; wait a
    // couple ticks for it to land against the stub.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(exitCode, 0, 'daemon restart drains then exits(0)');
  } finally {
    process.exit = realExit;
  }
});
