// Unit tests for the checkpoint-handler framework. Direct dispatch:
// runtime picks the last-registered plugin claiming the kind. Token-gate
// on handover ensures the agent must acknowledge before any other tool
// runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-checkpoints-test-'));
process.env.KLURA_HOME = TMP;
fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    daemon: { idleTimeout: 30, listen: 'unix' },
    pool: { mode: 'local', maxSessions: 1, idleTimeout: 30, headless: true, driver: 'playwright' },
  }),
);
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const {
  registerCheckpointHandler,
  unregisterCheckpointHandler,
  listCheckpointHandlers,
  invokeCheckpoint,
} = await import('../dist/checkpoints/index.js');

const FAKE_SESSION = /** @type {any} */ ({ id: 'sess-fake' });

function makeEvent(context, overrides = {}) {
  return {
    session_id: 'sess-fake',
    context,
    ...overrides,
  };
}

test('registerCheckpointHandler: rejects missing name', () => {
  assert.throws(
    () =>
      registerCheckpointHandler({
        kinds: ['triage_plan'],
        handle: async () => ({ status: 'continue' }),
      }),
    /name required/,
  );
});

test('registerCheckpointHandler: rejects missing kinds', () => {
  assert.throws(
    () =>
      registerCheckpointHandler({
        name: 'test-no-kinds',
        handle: async () => ({ status: 'continue' }),
      }),
    /kinds \(non-empty CheckpointKind\[\]\) required/,
  );
});

test('registerCheckpointHandler: rejects empty kinds array', () => {
  assert.throws(
    () =>
      registerCheckpointHandler({
        name: 'test-empty-kinds',
        kinds: [],
        handle: async () => ({ status: 'continue' }),
      }),
    /kinds \(non-empty CheckpointKind\[\]\) required/,
  );
});

test('registerCheckpointHandler: rejects missing handle', () => {
  assert.throws(
    () =>
      registerCheckpointHandler({
        name: 'test-no-handle',
        kinds: ['triage_plan'],
      }),
    /handle \(async function\) required/,
  );
});

test('listCheckpointHandlers: includes registered defaults', () => {
  const names = listCheckpointHandlers().map((h) => h.name);
  assert.ok(names.includes('default-ask-user-checkpoint'), 'ask-user default present');
  assert.ok(names.includes('default-handover-viewer-checkpoint'), 'viewer default present');
  assert.ok(
    names.includes('default-pre-action-consent-checkpoint'),
    'pre-action-consent default present',
  );
});

test('invokeCheckpoint: dispatches by kind (default-ask-user-checkpoint for triage_plan)', async () => {
  const res = await invokeCheckpoint(
    'triage_plan',
    makeEvent({ kind: 'triage_plan', rounds_since_handoff: 20 }),
    FAKE_SESSION,
  );
  assert.equal(res.status, 'handover');
  assert.equal(res.target, 'user');
});

test('invokeCheckpoint: last-registered wins for claimed kind', async () => {
  registerCheckpointHandler({
    name: 'test-continue-check-in',
    kinds: ['triage_plan'],
    handle: async () => ({ status: 'continue', hint: 'auto-continue' }),
  });
  try {
    const res = await invokeCheckpoint(
      'triage_plan',
      makeEvent({ kind: 'triage_plan' }),
      FAKE_SESSION,
    );
    assert.equal(res.status, 'continue');
    assert.equal(res.hint, 'auto-continue');
  } finally {
    unregisterCheckpointHandler('test-continue-check-in');
  }
});

test('invokeCheckpoint: unregister reverts to default', async () => {
  registerCheckpointHandler({
    name: 'test-transient',
    kinds: ['triage_plan'],
    handle: async () => ({ status: 'continue' }),
  });
  unregisterCheckpointHandler('test-transient');
  const res = await invokeCheckpoint(
    'triage_plan',
    makeEvent({ kind: 'triage_plan' }),
    FAKE_SESSION,
  );
  // Default is default-ask-user-checkpoint → handover.
  assert.equal(res.status, 'handover');
});

test('invokeCheckpoint: throws when no handler claims kind', async () => {
  // Register a stub that claims a bogus kind to ensure the error message
  // includes registered handlers; then check an unclaimed kind.
  // All shipped kinds have defaults, so we simulate by unregistering
  // defaults claiming the target kind for the duration of this test.
  unregisterCheckpointHandler('default-handover-viewer-checkpoint');
  try {
    await assert.rejects(
      () =>
        invokeCheckpoint(
          'recorded_step_failed',
          makeEvent({ kind: 'recorded_step_failed' }),
          FAKE_SESSION,
        ),
      /no checkpoint handler claims kind="recorded_step_failed"/,
    );
  } finally {
    // Re-register the default.
    const { registerCheckpointDefaults } = await import(
      '../dist/checkpoints/default-handlers.js'
    );
    registerCheckpointDefaults();
  }
});

test('same-name registration replaces prior handler', async () => {
  registerCheckpointHandler({
    name: 'test-replace',
    kinds: ['triage_plan'],
    handle: async () => ({ status: 'resolved', value: 'first' }),
  });
  registerCheckpointHandler({
    name: 'test-replace',
    kinds: ['triage_plan'],
    handle: async () => ({ status: 'resolved', value: 'second' }),
  });
  try {
    const res = await invokeCheckpoint(
      'triage_plan',
      makeEvent({ kind: 'triage_plan' }),
      FAKE_SESSION,
    );
    assert.equal(res.value, 'second');
  } finally {
    unregisterCheckpointHandler('test-replace');
  }
});

test('unregisterCheckpointHandler: no-op on unknown', () => {
  unregisterCheckpointHandler('definitely-not-registered');
  assert.ok(true);
});

// -- token-gate --------------------------------------------

const { pool } = await import('../dist/runtime-state/index.js');
const { mintCheckpointToken, assertNoPendingCheckpoint } = await import(
  '../dist/checkpoints/index.js'
);

function withFakeSession(fn) {
  const sid = `test-sess-${Math.random().toString(36).slice(2, 8)}`;
  const originalGet = pool.getSession.bind(pool);
  pool.getSession = (id) => (id === sid ? FAKE_SESSION : originalGet(id));
  try {
    return fn(sid);
  } finally {
    pool.getSession = originalGet;
  }
}

test('mintCheckpointToken: attaches pending state to session', () =>
  withFakeSession((sid) => {
    const token = mintCheckpointToken(sid, 'recorded_step_failed', {
      kind: 'recorded_step_failed',
    });
    assert.ok(typeof token === 'string' && token.length > 0);
    assert.throws(
      () => assertNoPendingCheckpoint(sid, {}),
      /pending_checkpoint/,
    );
  }));

test('assertNoPendingCheckpoint: accepts matching token + user_response', () =>
  withFakeSession((sid) => {
    const token = mintCheckpointToken(sid, 'triage_plan', { kind: 'triage_plan' });
    assertNoPendingCheckpoint(sid, {
      checkpoint_token: token,
      user_response: 'continue please',
    });
    // Cleared after ack.
    assertNoPendingCheckpoint(sid, {});
  }));

test('assertNoPendingCheckpoint: accepts cancelled with reason', () =>
  withFakeSession((sid) => {
    const token = mintCheckpointToken(sid, 'triage_plan', { kind: 'triage_plan' });
    assertNoPendingCheckpoint(sid, {
      checkpoint_token: token,
      cancelled: true,
      reason: 'user walked away',
    });
  }));

test('assertNoPendingCheckpoint: rejects cancel without reason', () =>
  withFakeSession((sid) => {
    const token = mintCheckpointToken(sid, 'triage_plan', { kind: 'triage_plan' });
    assert.throws(
      () =>
        assertNoPendingCheckpoint(sid, {
          checkpoint_token: token,
          cancelled: true,
        }),
      /cancelled checkpoint requires a non-empty reason/,
    );
  }));

test('assertNoPendingCheckpoint: rejects ack without user_response / viewer_result', () =>
  withFakeSession((sid) => {
    const token = mintCheckpointToken(sid, 'triage_plan', { kind: 'triage_plan' });
    assert.throws(
      () =>
        assertNoPendingCheckpoint(sid, {
          checkpoint_token: token,
        }),
      /acknowledgement must include/,
    );
  }));

test('assertNoPendingCheckpoint: rejects wrong token', () =>
  withFakeSession((sid) => {
    mintCheckpointToken(sid, 'triage_plan', { kind: 'triage_plan' });
    assert.throws(
      () =>
        assertNoPendingCheckpoint(sid, {
          checkpoint_token: 'bogus-token',
          user_response: 'hi',
        }),
      /pending_checkpoint/,
    );
  }));

test('assertNoPendingCheckpoint: no-op when no pending', () =>
  withFakeSession((sid) => {
    assertNoPendingCheckpoint(sid, {});
    assert.ok(true);
  }));
