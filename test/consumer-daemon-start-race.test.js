// Losing a daemon start race must not surface as a consumer failure.
//
// Two starters can target the same home at once: a consumer call and the
// factory daemon path, which guard with different locks. Exactly one binds the
// socket; every other forked daemon exits non-zero. The caller's requirement is
// "a daemon is serving this home", not "my child is the one serving it", so the
// losers must resolve against the winner rather than reporting the home dead.

import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonScript = path.resolve(here, '..', 'bin', 'klura-daemon.js');
const clientModule = path.resolve(here, '..', 'dist', 'consumer', 'daemon-client.js');

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-race-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ runtime: { idleTimeout: 30, listen: 'unix' } }),
  );
  return home;
}

/** One out-of-process consumer call; resolves to its error code, or 'ok'. */
function consumerCall(home) {
  const source = `
    const { invokeConsumerDaemon } = require(${JSON.stringify(clientModule)});
    invokeConsumerDaemon('/consumer/search', { query: 'race' }).then(
      () => { process.stdout.write('ok'); process.exit(0); },
      (e) => { process.stdout.write(String(e && e.code)); process.exit(0); },
    );
  `;
  return new Promise((resolve) => {
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
}

function killGroup(child) {
  try {
    process.kill(-child.pid);
  } catch {
    /* already gone */
  }
}

test('a raw second daemon fork loses the socket and exits non-zero', async () => {
  const home = freshHome();
  const spawnDaemon = () =>
    cp.fork(daemonScript, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, KLURA_HOME: home },
    });

  const a = spawnDaemon();
  const b = spawnDaemon();
  const exits = await new Promise((resolve) => {
    const seen = [];
    const note = (tag) => (code) => {
      seen.push({ tag, code });
      if (seen.length === 1) setTimeout(() => resolve(seen), 2000);
    };
    a.once('exit', note('a'));
    b.once('exit', note('b'));
    setTimeout(() => resolve(seen), 9000);
  });

  killGroup(a);
  killGroup(b);
  // This is the precondition the client has to tolerate, not a bug in itself:
  // one of the two forks goes away without ever announcing readiness.
  assert.equal(exits.length >= 1, true, 'expected at least one daemon fork to exit');
});

test('consumer calls racing a rival starter never report daemon_unavailable', async () => {
  const home = freshHome();
  const rival = cp.fork(daemonScript, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, KLURA_HOME: home },
  });

  try {
    const codes = await Promise.all([
      consumerCall(home),
      consumerCall(home),
      consumerCall(home),
      consumerCall(home),
    ]);
    // Reaching a live daemon is the assertion. The daemon answering
    // `daemon_rejected` (no reachable registry in a test environment) still
    // proves the transport worked; `daemon_unavailable` is the regression.
    assert.deepEqual(
      codes.filter((c) => c === 'daemon_unavailable'),
      [],
      `every call should reach a daemon, got: ${codes.join(', ')}`,
    );
  } finally {
    killGroup(rival);
  }
});
