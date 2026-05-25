// SaveWarningAcker hijack: when a harness registers an acker, the
// runtime IGNORES the LLM's notes.save_warnings_acked and calls the
// acker for each emitted ackable warning. Harness-attested reasons get
// persisted to the saved strategy. A `decision: 'reject'` from the
// acker blocks the save.
//
// This closes the canned-reason cheat: LLM can write
// `save_warnings_acked: [{kind, reason: "this is fine"}]` all it wants;
// when an acker is registered, the runtime overrides with what the
// USER actually said.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  registerSaveWarningAcker,
  unregisterSaveWarningAcker,
  getRegisteredSaveWarningAcker,
} = await import('../dist/audit/lift/save-warning-acker.js');

test('registry: register + get + unregister round-trip', () => {
  const acker = {
    name: 'test-acker-1',
    async ack() {
      return { decision: 'approve', reason: 'ok' };
    },
  };
  registerSaveWarningAcker(acker);
  assert.strictEqual(getRegisteredSaveWarningAcker()?.name, 'test-acker-1');
  unregisterSaveWarningAcker('test-acker-1');
  assert.strictEqual(getRegisteredSaveWarningAcker(), null);
});

test('registry: re-registering with same name replaces (idempotent)', async () => {
  registerSaveWarningAcker({
    name: 'test-acker-2',
    async ack() {
      return { decision: 'approve', reason: 'v1' };
    },
  });
  registerSaveWarningAcker({
    name: 'test-acker-2',
    async ack() {
      return { decision: 'approve', reason: 'v2' };
    },
  });
  const got = getRegisteredSaveWarningAcker();
  assert.ok(got);
  const result = await got.ack({ kind: 'x', message: 'y' }, { platform: 'p', capability: 'c' });
  assert.strictEqual(result.reason, 'v2');
  unregisterSaveWarningAcker('test-acker-2');
});

test('registry: unregister with non-matching name is a no-op (latest acker stays)', () => {
  registerSaveWarningAcker({
    name: 'test-acker-3',
    async ack() {
      return { decision: 'approve', reason: 'still here' };
    },
  });
  unregisterSaveWarningAcker('different-name');
  assert.strictEqual(getRegisteredSaveWarningAcker()?.name, 'test-acker-3');
  unregisterSaveWarningAcker('test-acker-3');
});

test('acker.ack signature: receives warning + ctx, returns {decision, reason}', async () => {
  let captured;
  registerSaveWarningAcker({
    name: 'test-acker-4',
    async ack(warning, ctx) {
      captured = { warning, ctx };
      return { decision: 'approve', reason: 'user said yes' };
    },
  });
  try {
    const acker = getRegisteredSaveWarningAcker();
    const result = await acker.ack(
      { kind: 'unparametrized_session_id', message: 'session id extracted from URL', hint: 'pass via arg' },
      { platform: 'discord', capability: 'send_message', tier: 'fetch' },
    );
    assert.strictEqual(captured.warning.kind, 'unparametrized_session_id');
    assert.strictEqual(captured.ctx.platform, 'discord');
    assert.strictEqual(captured.ctx.capability, 'send_message');
    assert.strictEqual(captured.ctx.tier, 'fetch');
    assert.deepStrictEqual(result, { decision: 'approve', reason: 'user said yes' });
  } finally {
    unregisterSaveWarningAcker('test-acker-4');
  }
});
