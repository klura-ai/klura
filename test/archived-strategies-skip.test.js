// Failed post-save validation renames `<cap>.json` → `<cap>.broken.json`.
// Before this fix, `list_platform_skills` walked all `*.json` files and
// stripped only the `.json` suffix, so it surfaced a phantom `<cap>.broken`
// capability. Agents then re-saved under that name, creating
// `<cap>.broken.broken.json`. Subsequent failures kept appending.
//
// Two layers of fix:
//   1. listing/walking helpers skip `*.broken.json` entries
//   2. archiveStrategy is idempotent on a slug already ending in `.broken`

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Tests sandbox KLURA_HOME via env so the real ~/.klura/ isn't touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-broken-test-'));
process.env.KLURA_HOME = tmp;

const skills = await import('../dist/strategies/skills.js');
const { listPlatformSkills, saveStrategy, archiveStrategy, findCapabilitiesProviding } = skills;

function fakeStrategy() {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/messages',
    notes: { params: {} },
  };
}

test('listPlatformSkills: skips *.broken.json files', async () => {
  saveStrategy('site-a', 'msg', fakeStrategy());
  archiveStrategy('site-a', 'msg', 'fetch', 'test');
  // Now site-a/fetch/ has msg.broken.json but no msg.json.
  saveStrategy('site-a', 'msg', fakeStrategy());
  // Both msg.json AND msg.broken.json exist.

  const skillsList = listPlatformSkills();
  const siteA = skillsList.find((s) => s.platform === 'site-a');
  assert.ok(siteA, 'site-a should appear');
  const caps = siteA.capabilities.map((c) => c.name);
  assert.deepStrictEqual(caps, ['msg'], 'only the active msg capability, no msg.broken phantom');
});

test('archiveStrategy: idempotent on already-archived slug', () => {
  saveStrategy('site-b', 'fetch_msg', fakeStrategy());
  // First archive: msg.json → msg.broken.json
  archiveStrategy('site-b', 'fetch_msg', 'fetch', 'first failure');
  assert.ok(
    fs.existsSync(path.join(tmp, 'skills', 'site-b', 'fetch', 'fetch_msg.broken.json')),
    'archive created',
  );

  // Re-save under the same name (active is recreated)
  saveStrategy('site-b', 'fetch_msg', fakeStrategy());

  // Caller passes the .broken-suffixed name (the buggy callpath we're guarding)
  archiveStrategy('site-b', 'fetch_msg.broken', 'fetch', 'should not chain');

  assert.strictEqual(
    fs.existsSync(path.join(tmp, 'skills', 'site-b', 'fetch', 'fetch_msg.broken.broken.json')),
    false,
    'NO double-.broken chain',
  );
  assert.ok(
    fs.existsSync(path.join(tmp, 'skills', 'site-b', 'fetch', 'fetch_msg.broken.json')),
    'single .broken still exists',
  );
});

test('findCapabilitiesProviding: skips *.broken.json files', () => {
  const strat = { ...fakeStrategy(), provides: ['auth'] };
  saveStrategy('site-c', 'login', strat);
  archiveStrategy('site-c', 'login', 'fetch', 'test');
  saveStrategy('site-c', 'login', strat);

  const providers = findCapabilitiesProviding('site-c', 'auth');
  assert.deepStrictEqual(providers, ['login'], 'no login.broken phantom in provider list');
});
