// The pool's busy→idle edge can arrive with no RPC: the warm sweeper evicts
// the last warm slot on its own timer. When the daemon's one-shot idle timer
// fires while warm slots keep Pool.busy() true, it does not re-arm — only
// the pool's became-idle notification (subscribed on factory load) re-arms
// it, so the daemon still shuts down after the sweeper drains the pool.
// This file stubs the factory with a controllable busy flag plus an
// onBecameIdle capture and simulates the sweeper edge by invoking the
// captured subscriber directly.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-daemon-idle-warm-'));
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
// pool busy-flag the test controls. busy:true with zero sessions models the
// live-warm-pool state; the captured onBecameIdle subscriber stands in for
// the sweeper's eviction edge.
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
let becameIdleSubscriber = null;
const factoryStub = {
  listPlatformSkills: () => ({ platforms: [] }),
  _pool: {
    activeSessions: 0,
    busy: () => poolBusy,
    onBecameIdle: (cb) => {
      becameIdleSubscriber = cb;
      return () => {
        becameIdleSubscriber = null;
      };
    },
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
let notifyExit = () => {};
const exitCalled = new Promise((resolve) => {
  notifyExit = resolve;
});
process.exit = (code) => {
  stubExitCalledWith = code ?? 0;
  notifyExit();
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

test('pool became-idle notification re-arms idle shutdown after a fire-while-busy', async () => {
  // Load the stub factory; the daemon subscribes to the pool's became-idle
  // notification at this point.
  const skills = await sendToDaemon('GET', '/platform-skills');
  assert.deepStrictEqual(skills, { platforms: [] });
  assert.strictEqual(typeof becameIdleSubscriber, 'function', 'daemon subscribed on factory load');

  // Let the one-shot idle timer fire while only the warm pool keeps busy()
  // true — it returns without re-arming, and no further RPC arrives.
  await sleep((IDLE_TIMEOUT_S + 0.6) * 1000);
  assert.strictEqual(stubExitCalledWith, null, 'daemon alive after fire-while-busy');
  assert.strictEqual(poolShutdownCalls, 0);

  // Sweeper edge: the last warm slot evicts, the pool goes idle, and the
  // pool notifies with no request in flight. lastActivity is already past
  // the timeout, so the re-armed timer fires (and shuts down) immediately.
  poolBusy = false;
  becameIdleSubscriber();
  // The exit stub resolves `exitCalled` — the shutdown edge itself. The race
  // only bounds the wait; on timeout the assert below reports the stale null.
  await Promise.race([exitCalled, sleep(3000)]);
  assert.strictEqual(stubExitCalledWith, 0, 'daemon shut down from the became-idle edge alone');
  assert.strictEqual(poolShutdownCalls, 1, 'pool.shutdown ran during daemon shutdown');
  assert.strictEqual(fs.existsSync(SOCKET), false, 'socket removed by shutdown');
});
