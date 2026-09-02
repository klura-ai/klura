// Serialization contract for the storage-state jar: every writer of
// `<platform>.json` — the Set-Cookie merge RMW and the whole-file save —
// takes the same `<file>.lock`, so neither can lose the other's write.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-storage-state-lock-'));
process.env.KLURA_HOME = TMP;

const { OwnerFileLockError, tryAcquireOwnerFileLock, releaseOwnerFileLock } = await import(
  '../dist/utils/owner-file-lock.js'
);
const { readStorageStateCookies, saveStorageState, storageStatePath, writeStorageStateCookies } =
  await import('../dist/strategies/storage-state.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test('saveStorageState writes the jar atomically and releases the shared file lock', () => {
  const filePath = saveStorageState('locked-jar', { cookies: [], origins: [] });
  assert.equal(filePath, storageStatePath('locked-jar'));
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { cookies: [], origins: [] });
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
});

test('a held jar lock rejects a whole-file save instead of racing the merge', () => {
  const filePath = storageStatePath('contended-jar');
  writeStorageStateCookies(
    'contended-jar',
    ['session=alpha; Path=/'],
    'https://contended.example/login',
  );
  const handle = tryAcquireOwnerFileLock(`${filePath}.lock`);
  assert.notEqual(handle, null);
  try {
    assert.throws(() => saveStorageState('contended-jar', '{}'), OwnerFileLockError);
  } finally {
    releaseOwnerFileLock(handle);
  }
  // The merge that landed before the contention window is intact.
  const { header } = readStorageStateCookies('contended-jar', 'https://contended.example/');
  assert.equal(header, 'session=alpha');
  // With the lock released the authoritative save wins.
  saveStorageState('contended-jar', '{}');
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{}');
});

test('a whole-file save and a Set-Cookie merge preserve each other through the lock', () => {
  saveStorageState('serialized-jar', {
    cookies: [],
    origins: [{ origin: 'https://serialized.example', localStorage: [] }],
  });
  writeStorageStateCookies('serialized-jar', ['token=beta; Path=/'], 'https://serialized.example/');
  const state = JSON.parse(fs.readFileSync(storageStatePath('serialized-jar'), 'utf8'));
  assert.equal(state.cookies.length, 1);
  assert.equal(state.cookies[0].name, 'token');
  assert.deepEqual(state.origins, [{ origin: 'https://serialized.example', localStorage: [] }]);
});
