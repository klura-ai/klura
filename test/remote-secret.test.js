import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// remote-secret.ts resolves KLURA_HOME dynamically on each call (by design,
// so tests can point at a temp dir just-in-time). We still need to reset
// the module-scope cache between tests since it keys on (envValue, path).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-remote-secret-test-'));
process.env.KLURA_HOME = TMP;
delete process.env.KLURA_REMOTE_SECRET;

const { getRemoteSecret, _resetRemoteSecretCacheForTests } = await import(
  '../dist/remote/secret.js'
);

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function freshHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `klura-remote-secret-${prefix}-`));
  process.env.KLURA_HOME = dir;
  delete process.env.KLURA_REMOTE_SECRET;
  _resetRemoteSecretCacheForTests();
  return dir;
}

test('env var wins over file, no file written', () => {
  const dir = freshHome('env-wins');
  process.env.KLURA_REMOTE_SECRET = 'env-provided-secret-123';
  _resetRemoteSecretCacheForTests();
  const secret = getRemoteSecret();
  assert.strictEqual(secret, 'env-provided-secret-123');
  assert.strictEqual(
    fs.existsSync(path.join(dir, 'remote-secret.key')),
    false,
    'file should not be written when env var is set',
  );
});

test('file auto-created with mode 0600 on first call', () => {
  const dir = freshHome('auto-create');
  const secretPath = path.join(dir, 'remote-secret.key');
  assert.strictEqual(fs.existsSync(secretPath), false);
  const secret = getRemoteSecret();
  assert.match(secret, /^[0-9a-f]{64}$/, 'generated secret should be 32 bytes hex');
  assert.strictEqual(fs.existsSync(secretPath), true, 'file should now exist');
  const stat = fs.statSync(secretPath);
  // On Unix, mode & 0o777 gives the permission bits. 0600 = owner r/w only.
  assert.strictEqual(stat.mode & 0o777, 0o600, 'file mode should be 0600');
  assert.strictEqual(fs.readFileSync(secretPath, 'utf8').trim(), secret);
});

test('existing file is read, not regenerated', () => {
  const dir = freshHome('existing-file');
  const secretPath = path.join(dir, 'remote-secret.key');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretPath, 'pre-existing-secret-value', { mode: 0o600 });
  const secret = getRemoteSecret();
  assert.strictEqual(secret, 'pre-existing-secret-value');
});

test('cache: repeated calls return the same value without re-reading', () => {
  const dir = freshHome('cache');
  const secret1 = getRemoteSecret();
  // Delete the file; if we were re-reading on every call, the next call
  // would regenerate a new secret. Because of the cache, it stays the same.
  fs.unlinkSync(path.join(dir, 'remote-secret.key'));
  const secret2 = getRemoteSecret();
  assert.strictEqual(secret1, secret2, 'cached secret should be returned');
});

test('cache invalidation: changing KLURA_HOME bypasses the old cache', () => {
  const dir1 = freshHome('cache-dir1');
  const secret1 = getRemoteSecret();
  // Point at a fresh dir without manually resetting the cache — the cache
  // entry is keyed on the resolved path, so a new path should produce a
  // new secret.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-remote-secret-cache-dir2-'));
  process.env.KLURA_HOME = dir2;
  const secret2 = getRemoteSecret();
  assert.notStrictEqual(secret1, secret2, 'different KLURA_HOME should produce a different secret');
  try {
    fs.rmSync(dir2, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('cache invalidation: setting env var after file-read switches to env', () => {
  freshHome('cache-env-switch');
  const fileSecret = getRemoteSecret();
  process.env.KLURA_REMOTE_SECRET = 'env-override-secret';
  const envSecret = getRemoteSecret();
  assert.strictEqual(envSecret, 'env-override-secret');
  assert.notStrictEqual(envSecret, fileSecret);
});

test('empty file is treated as missing and regenerated', () => {
  const dir = freshHome('empty-file');
  const secretPath = path.join(dir, 'remote-secret.key');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretPath, '', { mode: 0o600 });
  const secret = getRemoteSecret();
  assert.match(secret, /^[0-9a-f]{64}$/, 'should have regenerated on empty file');
  assert.strictEqual(fs.readFileSync(secretPath, 'utf8').trim(), secret);
});
