// Staleness-policy and serialized-RMW tests for the shared owner-file lock
// (runtime/src/utils/owner-file-lock.ts) — the single lock primitive behind
// capability mutation, the consumer store locks, the daemon singleton, and
// every `<file>.lock` read-modify-write guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-owner-file-lock-'));
process.env.KLURA_HOME = TMP;

const {
  OwnerFileLockError,
  tryAcquireOwnerFileLock,
  releaseOwnerFileLock,
  withOwnerFileLock,
  withOwnerFileLockAsync,
  updateJsonFile,
  looseJsonCodec,
} = await import('../dist/utils/owner-file-lock.js');

const MODULE_URL = pathToFileURL(
  path.join(process.cwd(), 'dist', 'utils', 'owner-file-lock.js'),
).href;

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

let lockCounter = 0;
function freshLockPath() {
  lockCounter += 1;
  const dir = path.join(TMP, `locks-${lockCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'subject.lock');
}

function fabricateOwner(lockPath, { pid, nonce, acquireNonce = 'b'.repeat(16), createdAt = Date.now() }) {
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      schema_version: 3,
      pid,
      process_nonce: nonce,
      acquire_nonce: acquireNonce,
      process_marker: 'held_file_v1',
      created_at_ms: createdAt,
    }),
  );
}

test('acquire, run, release: lock file exists inside and is gone after', () => {
  const lockPath = freshLockPath();
  const result = withOwnerFileLock(lockPath, () => {
    assert.equal(fs.existsSync(lockPath), true);
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(owner.pid, process.pid);
    return 'ran';
  });
  assert.equal(result, 'ran');
  assert.equal(fs.existsSync(lockPath), false);
});

test('two holds of the same lock never carry identical owner records', () => {
  const lockPath = freshLockPath();
  let first;
  withOwnerFileLock(lockPath, () => {
    first = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  });
  let second;
  withOwnerFileLock(lockPath, () => {
    second = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  });
  assert.equal(first.pid, second.pid);
  assert.equal(first.process_nonce, second.process_nonce);
  assert.notEqual(first.acquire_nonce, second.acquire_nonce);
});

test('a dead-pid owner record is recovered inline', () => {
  const lockPath = freshLockPath();
  fabricateOwner(lockPath, { pid: 99999999, nonce: 'a'.repeat(32) });
  const ran = withOwnerFileLock(lockPath, () => true);
  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('a same-pid owner with a nonmatching nonce and no held marker is recovered', () => {
  // Pid reuse across a restart: the owner record names this pid but the
  // dead process's marker file is not held open by anybody — recoverable.
  const lockPath = freshLockPath();
  fabricateOwner(lockPath, { pid: process.pid, nonce: '0'.repeat(32) });
  assert.equal(
    withOwnerFileLock(lockPath, () => 'reclaimed'),
    'reclaimed',
  );
});

test('a same-pid owner whose marker is held open in this process is live contention', () => {
  // A sibling lock-module instance inside this live process (a worker
  // thread's module registry, or a second runtime copy) has its own nonce
  // but holds its marker file open in this pid. That is a live holder —
  // the lock must NOT be recovered out from under it.
  const lockPath = freshLockPath();
  const nonce = 'c'.repeat(32);
  fabricateOwner(lockPath, { pid: process.pid, nonce });
  const markerPath = path.join(
    path.dirname(lockPath),
    '.process-owners',
    `${process.pid}-${nonce}.lease`,
  );
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const fd = fs.openSync(markerPath, 'w');
  try {
    assert.throws(
      () => withOwnerFileLock(lockPath, () => 'never'),
      (error) => error instanceof OwnerFileLockError && error.code === 'owner_file_locked',
    );
    assert.equal(fs.existsSync(lockPath), true, 'live sibling lock must survive the attempt');
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(markerPath);
    fs.unlinkSync(lockPath);
  }
});

test('fresh malformed locks fail closed; aged malformed locks recover', () => {
  const lockPath = freshLockPath();
  fs.writeFileSync(lockPath, '');
  assert.throws(
    () => withOwnerFileLock(lockPath, () => 'never'),
    (error) => error instanceof OwnerFileLockError && error.code === 'owner_file_locked',
  );
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  assert.equal(
    withOwnerFileLock(lockPath, () => 'recovered'),
    'recovered',
  );
});

test('the invalid-lock grace window honors the injected clock', () => {
  const lockPath = freshLockPath();
  fs.writeFileSync(lockPath, 'garbage');
  const farFuture = () => Date.now() + 3_600_000;
  assert.equal(
    withOwnerFileLock(lockPath, () => 'recovered', { now: farFuture }),
    'recovered',
  );
});

test('onLocked maps live contention to the caller error type', () => {
  const lockPath = freshLockPath();
  class CallerError extends Error {}
  const handle = tryAcquireOwnerFileLock(lockPath);
  assert.ok(handle);
  try {
    // The holder is this process with a matching nonce — a second acquisition
    // sees a live owner and must surface the caller-supplied error.
    assert.throws(
      () => withOwnerFileLock(lockPath, () => 'never', { onLocked: () => new CallerError('busy') }),
      (error) => error instanceof CallerError,
    );
  } finally {
    releaseOwnerFileLock(handle);
  }
});

test('release verifies ownership and never unlinks a foreign lock', () => {
  const lockPath = freshLockPath();
  const handle = tryAcquireOwnerFileLock(lockPath);
  assert.ok(handle);
  fs.unlinkSync(lockPath);
  fabricateOwner(lockPath, { pid: 99999998, nonce: 'b'.repeat(32) });
  releaseOwnerFileLock(handle);
  assert.equal(fs.existsSync(lockPath), true, 'foreign lock must survive a stale release');
  fs.unlinkSync(lockPath);
});

test('a live unrelated process cannot hold a lock through pid reuse', async () => {
  const lockPath = freshLockPath();
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import fs from 'node:fs';
        process.send?.({ ready: true });
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      `,
    ],
    { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] },
  );
  const exitPromise = once(child, 'exit');
  await once(child, 'message');
  assert.ok(child.pid);

  const nonce = crypto.randomBytes(16).toString('hex');
  const markerPath = path.join(
    path.dirname(lockPath),
    '.process-owners',
    `${child.pid}-${nonce}.lease`,
  );
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  // Marker file exists but the child does not hold it open — verification
  // proves the owner record is a pid-reuse artifact.
  fs.writeFileSync(markerPath, '');
  fabricateOwner(lockPath, { pid: child.pid, nonce });

  assert.equal(
    withOwnerFileLock(lockPath, () => 'reclaimed'),
    'reclaimed',
  );

  child.stdin.end('x');
  await exitPromise;
});

test('cross-process: a held lock rejects, releases cleanly on exit', async () => {
  const lockPath = freshLockPath();
  const childSource = `
    import fs from 'node:fs';
    const [moduleUrl, lockPath] = process.argv.slice(1);
    const { withOwnerFileLock } = await import(moduleUrl);
    withOwnerFileLock(lockPath, () => {
      process.send?.({ ready: true });
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    });
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', childSource, MODULE_URL, lockPath],
    { env: { ...process.env }, stdio: ['pipe', 'ignore', 'inherit', 'ipc'] },
  );
  const exitPromise = once(child, 'exit');
  const [message] = await once(child, 'message');
  assert.deepEqual(message, { ready: true });

  assert.throws(
    () => withOwnerFileLock(lockPath, () => 'never'),
    (error) => error instanceof OwnerFileLockError,
  );

  child.stdin.end('x');
  const [exitCode, signal] = await exitPromise;
  assert.equal(signal, null);
  assert.equal(exitCode, 0);
  assert.equal(
    withOwnerFileLock(lockPath, () => 'after'),
    'after',
  );
});

test('a SIGKILLed holder leaves a recoverable lock', async () => {
  const lockPath = freshLockPath();
  const childSource = `
    import fs from 'node:fs';
    const [moduleUrl, lockPath] = process.argv.slice(1);
    const { withOwnerFileLock } = await import(moduleUrl);
    withOwnerFileLock(lockPath, () => {
      process.send?.({ ready: true });
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    });
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', childSource, MODULE_URL, lockPath],
    { env: { ...process.env }, stdio: ['pipe', 'ignore', 'inherit', 'ipc'] },
  );
  const exitPromise = once(child, 'exit');
  await once(child, 'message');
  child.kill('SIGKILL');
  const [, signal] = await exitPromise;
  assert.equal(signal, 'SIGKILL');
  assert.equal(fs.existsSync(lockPath), true);

  assert.equal(
    withOwnerFileLock(lockPath, () => 'recovered'),
    'recovered',
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test('withOwnerFileLockAsync holds the lock across awaits and releases after', async () => {
  const lockPath = freshLockPath();
  await withOwnerFileLockAsync(lockPath, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(lockPath), true);
  });
  assert.equal(fs.existsSync(lockPath), false);
});

test('updateJsonFile: mutate → null skips the write', () => {
  const target = path.join(TMP, 'skip', 'state.json');
  const wrote = updateJsonFile(
    target,
    looseJsonCodec(() => ({})),
    () => null,
  );
  assert.equal(wrote, false);
  assert.equal(fs.existsSync(target), false);
});

test('updateJsonFile: reads through the codec, writes atomically', () => {
  const target = path.join(TMP, 'rmw', 'state.json');
  const codec = looseJsonCodec(() => ({ count: 0 }));
  assert.equal(
    updateJsonFile(target, codec, (state) => {
      state.count += 1;
      return state;
    }),
    true,
  );
  updateJsonFile(target, codec, (state) => {
    state.count += 1;
    return state;
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { count: 2 });
  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('updateJsonFile: corrupt state file reads as the empty shape', () => {
  const target = path.join(TMP, 'corrupt', 'state.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{not json');
  updateJsonFile(
    target,
    looseJsonCodec(() => ({ repaired: true, count: 0 })),
    (state) => {
      state.count += 1;
      return state;
    },
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { repaired: true, count: 1 });
});

test('updateJsonFile: concurrent multi-process increments lose no updates', async () => {
  const target = path.join(TMP, 'contended', 'counter.json');
  const PER_CHILD = 25;
  const childSource = `
    const [moduleUrl, target, iterations] = process.argv.slice(1);
    const { updateJsonFile, looseJsonCodec, OwnerFileLockError } = await import(moduleUrl);
    const codec = looseJsonCodec(() => ({ count: 0 }));
    let applied = 0;
    let attempts = 0;
    while (applied < Number(iterations)) {
      attempts += 1;
      if (attempts > 100000) throw new Error('livelock in test child');
      try {
        updateJsonFile(target, codec, (state) => {
          state.count += 1;
          return state;
        });
        applied += 1;
      } catch (error) {
        if (!(error instanceof OwnerFileLockError)) throw error;
        // Contended with the sibling child — bounded retry at the boundary.
      }
    }
  `;
  const children = [0, 1].map(() =>
    spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource, MODULE_URL, target, String(PER_CHILD)],
      { env: { ...process.env }, stdio: ['ignore', 'ignore', 'inherit'] },
    ),
  );
  const exits = await Promise.all(children.map((child) => once(child, 'exit')));
  for (const [code, signal] of exits) {
    assert.equal(signal, null);
    assert.equal(code, 0);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { count: PER_CHILD * 2 });
});
