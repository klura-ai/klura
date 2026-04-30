// Unit tests for clearSkills() and clearAll(). The split is load-bearing
// for benchmark runners: clearSkills wipes strategy state so each
// fresh/discovery iteration starts clean, while leaving the user's
// storage-state cookies and identity fields intact so they don't have to
// re-authenticate every run.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-clear-test-'));
process.env.KLURA_HOME = HOME;

const { clearSkills, clearAll } = await import('../dist/strategies/skills.js');

function seed() {
  // Strategy state (should be wiped by clearSkills)
  fs.mkdirSync(path.join(HOME, 'skills/foo/api'), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, 'skills/foo/api/bar.json'),
    JSON.stringify({ strategy: 'fetch' }),
  );
  // Per-platform workdir (logbook, health, sessions, artifacts — may contain PII).
  fs.mkdirSync(path.join(HOME, 'workdir/foo'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'workdir/foo/health.json'), '{}');

  // User state (must survive clearSkills)
  fs.mkdirSync(path.join(HOME, 'storage-state'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'storage-state/foo.json'), '{"cookies":[]}');
  fs.writeFileSync(path.join(HOME, 'identities.json'), '{"foo":{"email":"a@b.c"}}');
  fs.writeFileSync(path.join(HOME, 'config.json'), '{"secrets":{}}');
  fs.writeFileSync(path.join(HOME, 'device.json'), '{"userAgent":"x"}');
}

function exists(rel) {
  return fs.existsSync(path.join(HOME, rel));
}

test('clearSkills wipes skills/ and workdir/', () => {
  seed();
  clearSkills();
  assert.strictEqual(exists('skills/foo/api/bar.json'), false);
  assert.strictEqual(exists('workdir/foo/health.json'), false);
  assert.strictEqual(exists('skills'), false);
  assert.strictEqual(exists('workdir'), false);
});

test('clearSkills preserves storage-state cookies', () => {
  seed();
  clearSkills();
  assert.strictEqual(exists('storage-state/foo.json'), true);
});

test('clearSkills preserves identities.json', () => {
  seed();
  clearSkills();
  assert.strictEqual(exists('identities.json'), true);
});

test('clearSkills preserves config.json (secret resolvers)', () => {
  seed();
  clearSkills();
  assert.strictEqual(exists('config.json'), true);
});

test('clearSkills preserves device.json (daemon device profile)', () => {
  seed();
  clearSkills();
  assert.strictEqual(exists('device.json'), true);
});

test('clearSkills is idempotent and safe when state is missing', () => {
  clearAll(); // true blank
  clearSkills(); // should not throw
  clearSkills(); // still should not throw
});

test('clearAll still wipes everything including user state', () => {
  seed();
  clearAll();
  for (const rel of [
    'skills/foo/api/bar.json',
    'workdir/foo/health.json',
    'storage-state/foo.json',
    'identities.json',
    'config.json',
    'device.json',
  ]) {
    assert.strictEqual(exists(rel), false, `${rel} should be gone after clearAll`);
  }
});
