// update_strategy — the amend verb. Covers the logic unique to update_strategy
// (the pre-existence precondition + delegation to the audited save path). The
// full save-time audit is exercised by save-strategy's own tests; update_strategy
// delegates to the same saveStrategy() function, so an amend clears the same bar
// a create does by construction.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-update-strategy-'));
process.env.KLURA_HOME = tmp;
process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const skills = await import('../dist/strategies/skills.js');
const { updateStrategy } = await import('../dist/tools/save-strategy.js');

function fakeStrategy(endpoint = '/api/messages') {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint,
    notes: { params: {} },
  };
}

test('update_strategy: rejects when no saved strategy exists, points at save_strategy', async () => {
  await assert.rejects(
    () => updateStrategy('site-none', 'list_items', fakeStrategy(), 'changelog', undefined),
    /no_saved_strategy_to_update/,
  );
});

test('update_strategy: amends an existing strategy in place (delegates to the save path)', async () => {
  // Seed an existing strategy via the low-level writer.
  skills.saveStrategy('site-amend', 'list_items', fakeStrategy('/api/v1/messages'));
  const filePath = path.join(tmp, 'skills', 'site-amend', 'fetch', 'list_items.json');
  assert.ok(fs.existsSync(filePath), 'seed strategy written');
  const before = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(before.endpoint, '/api/v1/messages');

  // Amend the endpoint. No session_id → programmatic path (same path auto-synth
  // and tests use); proves the precondition passes and the commit overwrites.
  const result = await updateStrategy(
    'site-amend',
    'list_items',
    fakeStrategy('/api/v2/messages'),
    'bump to v2',
    undefined,
  );
  assert.equal(result.ok, true);

  const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(after.endpoint, '/api/v2/messages', 'amend overwrote the saved strategy');
});
