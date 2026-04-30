// In-process daemon coverage test. Unlike daemon-ipc.test.js which forks a
// subprocess (which makes V8 coverage flaky for shutdown paths), this file
// runs startDaemon() inside the test process with process.exit stubbed out.
// Everything stays in one process so coverage is captured cleanly.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-daemon-ip-'));
process.env.KLURA_HOME = TMP;

// Force pool mode to local so the daemon can boot without docker. No real
// sessions are created, so playwright isn't actually launched.
fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    daemon: { idleTimeout: 30, listen: 'unix' },
    pool: { mode: 'local', maxSessions: 1, idleTimeout: 30, headless: true, image: 'ignored' },
  }),
);

const { startDaemon, sendToDaemon } = await import('../dist/daemon.js');

// Stub process.exit BEFORE startDaemon so the internal shutdown() cleanup
// runs to completion without killing the test process.
const realExit = process.exit;
let stubExitCalledWith = null;
process.exit = ((code) => {
  stubExitCalledWith = code ?? 0;
  // Don't actually exit — let the test runner continue.
});

// Stub the SIGTERM/SIGINT handlers too — startDaemon registers them, but
// when the test runner sends them later we don't want to double-handle.
// (Not stubbing; these are only triggered externally.)

test.before(() => {
  startDaemon();
});

test.after(async () => {
  // Restore exit. If the shutdown test ran it already set exitCode via the
  // stub; that's fine, the test process keeps running until node's runner
  // finishes and exits naturally.
  process.exit = realExit;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  // Remove all SIGTERM/SIGINT handlers startDaemon installed so they don't
  // fire later.
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

// Give startDaemon's async listen() a moment before the first test runs.
test('daemon boots and responds to /status', async () => {
  // Wait up to 3s for the socket to exist.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !fs.existsSync(path.join(TMP, 'klura.sock'))) {
    await new Promise((r) => setTimeout(r, 30));
  }
  const result = await sendToDaemon('GET', '/status');
  assert.strictEqual(typeof result, 'object');
  assert.strictEqual(typeof result.uptime, 'number');
});

test('handleRequest error path: malformed body returns 500', async () => {
  // Send raw non-JSON to trigger the catch inside handleRequest.
  const { default: http } = await import('node:http');
  const result = await new Promise((resolve, reject) => {
    const raw = 'this is not json';
    const req = http.request(
      {
        socketPath: path.join(TMP, 'klura.sock'),
        path: '/strategy/mark-healed',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
  assert.strictEqual(result.status, 500);
  assert.ok(result.body.error);
});

test('POST /shutdown runs the internal shutdown() cleanup in-process', async () => {
  // Before /shutdown, the socket and pid file should exist.
  assert.ok(fs.existsSync(path.join(TMP, 'klura.sock')));
  assert.ok(fs.existsSync(path.join(TMP, 'daemon.pid')));

  const result = await sendToDaemon('POST', '/shutdown');
  assert.deepStrictEqual(result, { ok: true });

  // Give shutdown() a moment to drain (it's async). The 50ms setTimeout
  // inside shutdown() schedules process.exit — which is stubbed.
  await new Promise((r) => setTimeout(r, 150));

  // pid + socket should be gone; exit was stubbed → called with 0
  assert.strictEqual(fs.existsSync(path.join(TMP, 'daemon.pid')), false, 'pid file removed');
  assert.strictEqual(fs.existsSync(path.join(TMP, 'klura.sock')), false, 'socket removed');
  assert.strictEqual(stubExitCalledWith, 0, 'shutdown called process.exit(0)');
});
