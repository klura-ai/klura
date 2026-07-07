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
