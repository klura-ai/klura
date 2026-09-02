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
  checkpointEvent,
} = await import('../dist/checkpoints/index.js');

const FAKE_SESSION = /** @type {any} */ ({ id: 'sess-fake' });

function makeEvent(kind, context = {}, overrides = {}) {
  return {
    kind,
    session_id: 'sess-fake',
    context,
    ...overrides,
  };
}

test('checkpointEvent builders: stamped kind wins over a kind key from an untyped caller', () => {
  const event = checkpointEvent.triage_plan(
    /** @type {any} */ ({ kind: 'surface_changed', session_id: 'sess-fake', context: {} }),
  );
  assert.equal(event.kind, 'triage_plan');
});

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

test('invokeCheckpoint: dispatches by event.kind (default-ask-user-checkpoint for triage_plan)', async () => {
  const res = await invokeCheckpoint(
    makeEvent('triage_plan', { rounds_since_handoff: 20 }),
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
    const res = await invokeCheckpoint(makeEvent('triage_plan'), FAKE_SESSION);
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
  const res = await invokeCheckpoint(makeEvent('triage_plan'), FAKE_SESSION);
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
      () => invokeCheckpoint(makeEvent('recorded_step_failed'), FAKE_SESSION),
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
    const res = await invokeCheckpoint(makeEvent('triage_plan'), FAKE_SESSION);
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
    const token = mintCheckpointToken({
      kind: 'recorded_step_failed',
      session_id: sid,
      context: {},
    });
    assert.ok(typeof token === 'string' && token.length > 0);
    assert.throws(
      () => assertNoPendingCheckpoint(sid, {}),
      /pending_checkpoint/,
    );
  }));

test('assertNoPendingCheckpoint: accepts matching token + user_response', () =>
  withFakeSession((sid) => {
    const token = mintCheckpointToken({ kind: 'triage_plan', session_id: sid, context: {} });
    assertNoPendingCheckpoint(sid, {
      checkpoint_token: token,
      user_response: 'continue please',
    });
    // Cleared after ack.
    assertNoPendingCheckpoint(sid, {});
  }));

// A pending checkpoint blocks every session-scoped tool, `abort_session`
// included, and a token is minted only when a NEW checkpoint fires — which no
// blocked call can reach. So the replacement the gate issues on an expired
// token is the session's only exit, and it has to reach the agent.
test('assertNoPendingCheckpoint: an unusable token still yields a usable replacement', () =>
  withFakeSession((sid) => {
    mintCheckpointToken({ kind: 'abort_session_consent', session_id: sid, context: {} });
    let message = '';
    try {
      assertNoPendingCheckpoint(sid, {
        checkpoint_token: 'expired-or-unknown',
        user_response: 'no, keep going',
      });
      assert.fail('expected the stale token to be rejected');
    } catch (err) {
      message = err.message;
    }
    assert.match(message, /token_unknown_or_expired/);
    const replacement = message.match(/checkpoint_token: (\S+?) —/)?.[1];
    assert.ok(replacement, `rejection must carry a replacement token, got: ${message}`);

    // The replacement must actually clear the checkpoint — otherwise the
    // session stays wedged and the token is decoration.
    assertNoPendingCheckpoint(sid, {
      checkpoint_token: replacement,
      user_response: 'no, keep going',
    });
    assertNoPendingCheckpoint(sid, {});
  }));

test('assertNoPendingCheckpoint: accepts cancelled with reason', () =>
  withFakeSession((sid) => {
    const token = mintCheckpointToken({ kind: 'triage_plan', session_id: sid, context: {} });
    assertNoPendingCheckpoint(sid, {
      checkpoint_token: token,
      cancelled: true,
      reason: 'user walked away',
    });
  }));

test('assertNoPendingCheckpoint: rejects cancel without reason', () =>
  withFakeSession((sid) => {
    const token = mintCheckpointToken({ kind: 'triage_plan', session_id: sid, context: {} });
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
    const token = mintCheckpointToken({ kind: 'triage_plan', session_id: sid, context: {} });
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
    mintCheckpointToken({ kind: 'triage_plan', session_id: sid, context: {} });
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
