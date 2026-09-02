// Idle-shutdown busy-predicate coverage. The daemon's runtime.idleTimeout
// must not shut down a process whose warm pool is live: Pool.busy() is the
// single idle/teardown authority (it covers live sessions AND warm slots),
// and the daemon consults it through factory._pool.busy(). This file runs
// startDaemon() in-process with process.exit stubbed and a stub factory
// module primed into require.cache, so the busy flag is controllable without
// launching a browser.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-daemon-idle-'));
process.env.KLURA_HOME = TMP;

const IDLE_TIMEOUT_S = 2;

fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    runtime: { idleTimeout: IDLE_TIMEOUT_S, listen: 'unix' },
    pool: { maxSessions: 1, idleTimeout: 30 },
  }),
);

// Prime the factory module the daemon lazily require()s with a stub whose
// pool busy-flag the test controls. activeSessions stays 0 throughout —
// busy:true with zero sessions models exactly the live-warm-pool state the
// idle predicate must respect.
const require = createRequire(import.meta.url);
const FACTORY_INDEX = path.resolve(
  new URL(import.meta.url).pathname,
  '..',
  '..',
  'dist',
  'index.js',
);
let poolBusy = true;
let poolShutdownCalls = 0;
const factoryStub = {
  listPlatformSkills: () => ({ platforms: [] }),
  _pool: {
    activeSessions: 0,
    busy: () => poolBusy,
    shutdown: async () => {
      poolShutdownCalls += 1;
    },
  },
};
require.cache[FACTORY_INDEX] = {
  id: FACTORY_INDEX,
  filename: FACTORY_INDEX,
  loaded: true,
  exports: factoryStub,
};

const { startDaemon, sendToDaemon } = await import('../dist/daemon.js');

const SOCKET = path.join(TMP, 'klura.sock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The socket appearing in KLURA_HOME is the daemon's listen edge — watch the
// directory for it rather than re-checking existence on a timer.
const waitForSocket = (timeoutMs) =>
  new Promise((resolve, reject) => {
    const watcher = fs.watch(TMP);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon socket did not appear within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      watcher.close();
      clearTimeout(timer);
    };
    const check = () => {
      if (!fs.existsSync(SOCKET)) return;
      cleanup();
      resolve();
    };
    watcher.on('change', check);
    check();
  });

// Stub process.exit BEFORE startDaemon so the internal shutdown() cleanup
// runs to completion without killing the test process.
const realExit = process.exit;
let stubExitCalledWith = null;
process.exit = (code) => {
  stubExitCalledWith = code ?? 0;
};

test.before(async () => {
  startDaemon();
  await waitForSocket(3000);
});

test.after(() => {
  process.exit = realExit;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

test('idle timeout does not shut down a daemon whose pool is busy', async () => {
  // Load the (stubbed) factory so the idle predicate consults the pool.
  const skills = await sendToDaemon('GET', '/platform-skills');
  assert.deepStrictEqual(skills, { platforms: [] });

  // Let the idle timer fire while busy() is true. activeSessions is 0 the
  // whole time — only the pool's busy predicate keeps the daemon alive.
  await sleep((IDLE_TIMEOUT_S + 0.6) * 1000);
  assert.strictEqual(stubExitCalledWith, null, 'daemon must not exit while pool is busy');
  assert.ok(fs.existsSync(SOCKET), 'socket must survive an idle fire while busy');
  assert.strictEqual(poolShutdownCalls, 0, 'pool must not be torn down while busy');
});

test('idle timeout shuts the daemon down once the pool reports not busy', async () => {
  poolBusy = false;
  // A timer that fired while busy does not re-arm itself; the next request
  // (a lifecycle edge) re-arms it.
  const status = await sendToDaemon('GET', '/status');
  assert.strictEqual(status.activeSessions, 0);

  await sleep((IDLE_TIMEOUT_S + 0.6) * 1000);
  assert.strictEqual(stubExitCalledWith, 0, 'daemon exits once idle and not busy');
  assert.strictEqual(poolShutdownCalls, 1, 'pool.shutdown ran during daemon shutdown');
  assert.strictEqual(fs.existsSync(SOCKET), false, 'socket removed by shutdown');
});
