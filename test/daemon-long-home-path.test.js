// A unix socket address is a fixed-size `sockaddr_un.sun_path` — 104 bytes on
// darwin/BSD, 108 on Linux — and `listen()` answers EINVAL for anything longer.
// A deep KLURA_HOME therefore broke every consumer tool for that home, with no
// usable diagnosis: the daemon's `uncaughtException` handler logged the EINVAL
// and kept the process alive, so the caller saw only a 10s "did not become
// ready" timeout, and the forked daemon's stderr was discarded anyway.
//
// Observed on bench workers, whose homes nest a timestamped batch directory
// under a scenario slug under a variant name — 137 bytes, comfortably over.
//
// The daemon now detects the overrun before binding and listens on loopback
// TCP instead, publishing the address in `daemon.addr`, which the client
// already knows how to dial.

import test from 'node:test';
import assert from 'node:assert';
import cp from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonScript = path.resolve(here, '..', 'bin', 'klura-daemon.js');
const clientModule = path.resolve(here, '..', 'dist', 'consumer', 'daemon-client.js');
const SUN_PATH_MAX_BYTES = process.platform === 'linux' ? 108 : 104;

function makeHome(depthNames) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-longpath-'));
  const home = path.join(root, ...depthNames);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ runtime: { idleTimeout: 30, listen: 'unix' } }),
  );
  return home;
}

/** Start a daemon and wait for its readiness IPC, capturing stderr. */
function startDaemon(home, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = cp.fork(daemonScript, [], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, KLURA_HOME: home },
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const done = (outcome) => {
      clearTimeout(timer);
      resolve({ ...outcome, stderr, child });
    };
    const timer = setTimeout(() => done({ ready: false, reason: 'timeout' }), timeoutMs);
    child.on('message', (m) => {
      if (m && m.kind === 'ready') done({ ready: true });
    });
    child.on('exit', (code) => done({ ready: false, reason: `exit ${code}` }));
  });
}

function kill(child) {
  try {
    process.kill(-child.pid);
  } catch {
    /* already gone */
  }
}

test('the platform really does reject an over-long unix socket path', async () => {
  // Pins the premise rather than trusting the constant: if a platform ever
  // stopped enforcing this, the fallback below would be dead weight.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun-'));
  const socketPath = path.join(dir, 'x'.repeat(SUN_PATH_MAX_BYTES));
  assert.ok(Buffer.byteLength(socketPath) > SUN_PATH_MAX_BYTES);
  const code = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code));
    server.listen(socketPath, () => {
      server.close();
      resolve('OK');
    });
  });
  assert.equal(code, 'EINVAL');
});

test('a home whose socket path overruns sun_path starts on loopback TCP', async () => {
  const home = makeHome(['klura-bench-2026-08-05T07-03-33-148Z', 'a-long-scenario-slug', 'warm-pool']);
  const socketPath = path.join(home, 'klura.sock');
  assert.ok(
    Buffer.byteLength(socketPath) > SUN_PATH_MAX_BYTES,
    `fixture home must exceed the limit, got ${Buffer.byteLength(socketPath)} bytes`,
  );

  const started = await startDaemon(home);
  try {
    assert.equal(started.ready, true, `daemon never became ready (${started.reason}): ${started.stderr}`);
    // No socket file; a published TCP address instead.
    assert.equal(fs.existsSync(socketPath), false);
    const addr = fs.readFileSync(path.join(home, 'daemon.addr'), 'utf8').trim();
    assert.match(addr, /^127\.0\.0\.1:\d+$/);
    // The reason is stated rather than silently swapped.
    assert.match(started.stderr, /over this platform's \d+-byte limit/);
  } finally {
    kill(started.child);
  }
});

test('a short home still uses the unix socket', async () => {
  const home = makeHome(['h']);
  const socketPath = path.join(home, 'klura.sock');
  assert.ok(Buffer.byteLength(socketPath) < SUN_PATH_MAX_BYTES);

  const started = await startDaemon(home);
  try {
    assert.equal(started.ready, true, `daemon never became ready (${started.reason}): ${started.stderr}`);
    assert.equal(fs.existsSync(socketPath), true);
    assert.equal(fs.existsSync(path.join(home, 'daemon.addr')), false);
  } finally {
    kill(started.child);
  }
});

test('a consumer call against an over-long home reaches the daemon', async () => {
  const home = makeHome(['klura-bench-2026-08-05T07-03-33-148Z', 'another-scenario-slug', 'cold']);
  assert.ok(Buffer.byteLength(path.join(home, 'klura.sock')) > SUN_PATH_MAX_BYTES);

  const source = `
    const { invokeConsumerDaemon } = require(${JSON.stringify(clientModule)});
    invokeConsumerDaemon('/consumer/search', { query: 'x' }).then(
      () => { process.stdout.write('ok'); process.exit(0); },
      (e) => { process.stdout.write(String(e && e.code)); process.exit(0); },
    );
  `;
  const code = await new Promise((resolve) => {
    const child = cp.spawn(process.execPath, ['-e', source], {
      env: { ...process.env, KLURA_HOME: home },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('exit', () => resolve(out.trim()));
  });

  // `daemon_rejected` proves the transport worked and the daemon answered —
  // there is no reachable package registry in a test environment.
  // `daemon_unavailable` is the regression.
  assert.notEqual(code, 'daemon_unavailable', 'consumer call could not reach the daemon');
});
