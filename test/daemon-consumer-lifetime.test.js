import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-daemon-consumer-lifetime-'));
const socketPath = path.join(home, 'klura.sock');
const daemonScript = path.resolve(here, '..', 'bin', 'klura-daemon.js');
const preload = path.join(here, 'fixtures', 'daemon-consumer-stall.cjs');

fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    runtime: { idleTimeout: 1, listen: 'unix' },
    pool: { maxSessions: 1, idleTimeout: 30 },
  }),
);

function waitForSocket(deadline) {
  return new Promise((resolve, reject) => {
    const watch = fs.watch(home, () => {
      if (!fs.existsSync(socketPath)) return;
      clearTimeout(timeout);
      watch.close();
      resolve();
    });
    const timeout = setTimeout(
      () => {
        watch.close();
        reject(new Error(`daemon socket ${socketPath} did not appear in time`));
      },
      Math.max(0, deadline - Date.now()),
    );
    if (fs.existsSync(socketPath)) {
      clearTimeout(timeout);
      watch.close();
      resolve();
    }
  });
}

function postConsumerCall() {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: '/consumer/call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += String(chunk);
        });
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(body) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

test('a consumer request keeps the daemon alive through its idle deadline', async () => {
  const daemon = cp.fork(daemonScript, [], {
    env: { ...process.env, KLURA_HOME: home },
    execArgv: ['--require', preload],
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => daemon.once('exit', resolve));
  try {
    // Daemon boot pulls in the browser pool, so the budget has to survive a
    // machine running the rest of the suite in parallel.
    await waitForSocket(Date.now() + 15_000);
    const response = postConsumerCall();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(fs.existsSync(socketPath), true);
    assert.deepEqual(await response, {
      status: 200,
      body: { kind: 'consumer_daemon_test_result' },
    });
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('daemon did not shut down after consumer completion')),
          3_000,
        ),
      ),
    ]);
  } finally {
    if (!daemon.killed) daemon.kill('SIGTERM');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
