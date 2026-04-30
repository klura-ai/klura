// Unit tests for per-capability policy caps + setCapabilityPolicy.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-pcp-test-'));
process.env.KLURA_HOME = TMP;

const policyMod = await import('../dist/strategies/policy.js');
const {
  setCapabilityPolicy,
  isTierAllowed,
  loadPolicy,
  savePolicy,
  clearPolicy,
} = policyMod;

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('setCapabilityPolicy writes per-capability cap', () => {
  setCapabilityPolicy('sitea', 'send_message', 'recorded-path');
  const saved = loadPolicy('sitea');
  assert.strictEqual(saved.per_capability?.send_message?.max_strategy_tier, 'recorded-path');
});

test('isTierAllowed respects per-capability cap', () => {
  setCapabilityPolicy('siteb', 'send_message', 'recorded-path');
  // Capped at recorded-path: page-script and fetch are blocked for send_message
  assert.strictEqual(isTierAllowed('siteb', 'send_message', 'recorded-path'), true);
  assert.strictEqual(isTierAllowed('siteb', 'send_message', 'page-script'), false);
  assert.strictEqual(isTierAllowed('siteb', 'send_message', 'fetch'), false);
  // Other capabilities on same platform: platform default (fetch) applies
  assert.strictEqual(isTierAllowed('siteb', 'other_cap', 'fetch'), true);
  assert.strictEqual(isTierAllowed('siteb', 'other_cap', 'page-script'), true);
});

test('setCapabilityPolicy stores reason', () => {
  setCapabilityPolicy('sitec', 'send_msg', 'recorded-path', 'user declined RE-lift offer');
  const saved = loadPolicy('sitec');
  assert.strictEqual(saved.per_capability?.send_msg?.reason, 'user declined RE-lift offer');
});

test('per_capability additional to default_max_strategy_tier — more restrictive wins', () => {
  savePolicy('sited', {
    default_max_strategy_tier: 'page-script',
    per_capability: {
      send_msg: { max_strategy_tier: 'recorded-path' },
    },
  });
  assert.strictEqual(isTierAllowed('sited', 'send_msg', 'recorded-path'), true);
  assert.strictEqual(isTierAllowed('sited', 'send_msg', 'page-script'), false);
  assert.strictEqual(isTierAllowed('sited', 'other', 'page-script'), true);
  assert.strictEqual(isTierAllowed('sited', 'other', 'fetch'), false);
});

test('setCapabilityPolicy rejects reason > 200 chars', () => {
  const long = 'x'.repeat(201);
  assert.throws(
    () => setCapabilityPolicy('sitee', 'cap', 'recorded-path', long),
    /invalid_policy/,
  );
});

test('clearPolicy removes per-capability caps too', () => {
  setCapabilityPolicy('sitef', 'cap1', 'recorded-path');
  assert.strictEqual(isTierAllowed('sitef', 'cap1', 'fetch'), false);
  clearPolicy('sitef');
  assert.strictEqual(isTierAllowed('sitef', 'cap1', 'fetch'), true);
});
