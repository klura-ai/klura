// readProfileLockHolder turns a connect-mode "failed to attach" into an
// actionable signal by naming a LIVE Chrome holding the profile's
// SingletonLock — the pid drives both the failure hint and the orphan reap.
// Regression for a live-site crash, where a leaked Chrome held the lock and the
// failure gave no hint why.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { readProfileLockHolder } = await import('../dist/drivers/profile-lock.js');

function tmpProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klura-lock-'));
}
function writeLock(dir, target) {
  fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
}

test('no lock file → null', () => {
  assert.strictEqual(readProfileLockHolder(tmpProfile()), null);
});

test('live holder → holder naming the pid and profile dir', () => {
  const dir = tmpProfile();
  writeLock(dir, `somehost-${process.pid}`); // this test process is alive
  const holder = readProfileLockHolder(dir);
  assert.strictEqual(holder.pid, process.pid);
  assert.strictEqual(holder.profileDir, dir);
});

test('stale lock (dead pid) → null, not a false alarm', () => {
  const dir = tmpProfile();
  // 2^31-ish pid that cannot be live on any real system.
  writeLock(dir, 'somehost-2147480000');
  assert.strictEqual(readProfileLockHolder(dir), null);
});

test('malformed lock target → null', () => {
  const dir = tmpProfile();
  writeLock(dir, 'no-pid-here-abc');
  assert.strictEqual(readProfileLockHolder(dir), null);
});

// A profile holds one Chrome, and two klura processes may want it at once. The
// lease is what lets the second tell a Chrome another process is driving from
// one a dead run left behind: the first is shared, the second is reaped.

const {
  acquireProfileLease,
  releaseProfileLease,
  otherProfileLeases,
  readProfileDevToolsEndpoint,
  recordProfileChrome,
  assessProfileChrome,
} = await import('../dist/drivers/profile-lock.js');

function lease(dir, pid) {
  fs.mkdirSync(path.join(dir, 'klura-leases'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'klura-leases', String(pid)), '');
}
const DEAD_PID = 2147480000;

test('a profile nobody holds or leases is free', () => {
  assert.deepStrictEqual(assessProfileChrome(tmpProfile()), { kind: 'free' });
});

test('a Chrome on the profile with no live lessee is an orphan', () => {
  const dir = tmpProfile();
  writeLock(dir, `somehost-${process.pid}`);
  lease(dir, DEAD_PID);
  assert.deepStrictEqual(assessProfileChrome(dir), { kind: 'orphan', pid: process.pid });
  // The dead process's lease is cleared on the way, so it cannot vouch for a
  // Chrome later on behalf of whatever reuses its pid.
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'klura-leases')), []);
});

test('a Chrome another live process leases is shared, with its endpoint', () => {
  const dir = tmpProfile();
  writeLock(dir, `somehost-${process.pid}`);
  lease(dir, process.ppid);
  recordProfileChrome(dir, process.pid, 'http://127.0.0.1:49152');
  assert.deepStrictEqual(assessProfileChrome(dir), {
    kind: 'shared',
    pid: process.pid,
    endpoint: 'http://127.0.0.1:49152',
    lessees: [process.ppid],
  });
});

test('a lessee whose Chrome is not up yet is shared with no endpoint to attach to', () => {
  const dir = tmpProfile();
  lease(dir, process.ppid);
  // A record left by an earlier Chrome says nothing about one not yet started.
  recordProfileChrome(dir, DEAD_PID, 'http://127.0.0.1:49152');
  assert.deepStrictEqual(assessProfileChrome(dir), {
    kind: 'shared',
    pid: null,
    endpoint: null,
    lessees: [process.ppid],
  });
});

test("a process's own lease does not make the profile look shared to itself", () => {
  const dir = tmpProfile();
  acquireProfileLease(dir);
  assert.deepStrictEqual(otherProfileLeases(dir), []);
  assert.deepStrictEqual(assessProfileChrome(dir), { kind: 'free' });
  releaseProfileLease(dir);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'klura-leases')), []);
  releaseProfileLease(dir); // releasing twice is harmless
});

test('the recorded endpoint is believed only for the Chrome that holds the profile now', () => {
  const dir = tmpProfile();
  assert.strictEqual(readProfileDevToolsEndpoint(dir, process.pid), null);
  recordProfileChrome(dir, process.pid, 'http://127.0.0.1:9222');
  assert.strictEqual(readProfileDevToolsEndpoint(dir, process.pid), 'http://127.0.0.1:9222');
  // The same record, read for a different Chrome, is a leftover.
  assert.strictEqual(readProfileDevToolsEndpoint(dir, process.ppid), null);
  fs.writeFileSync(path.join(dir, 'klura-chrome.json'), 'not json');
  assert.strictEqual(readProfileDevToolsEndpoint(dir, process.pid), null);
});
