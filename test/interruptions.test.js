// Unit tests for the interruption-handler framework. Menu-driven dispatch:
// runtime lists every registered handler + an event-context payload, the
// agent picks by name, runtime invokes. Token-gate on handover ensures the
// agent must acknowledge before any other tool runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-interruptions-test-'));
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
  registerInterruptionHandler,
  unregisterInterruptionHandler,
  listInterruptionHandlers,
  invokeInterruptionHandler,
} = await import('../dist/interruptions/index.js');

const FAKE_SESSION = /** @type {any} */ ({ id: 'sess-fake' });

function makeEvent(context, overrides = {}) {
  return {
    session_id: 'sess-fake',
    context,
    ...overrides,
  };
}

test('registerInterruptionHandler: rejects missing name', () => {
  assert.throws(
    () => registerInterruptionHandler({ description: 'x', handle: async () => ({ status: 'continue' }) }),
    /name required/,
  );
});

test('registerInterruptionHandler: rejects missing description', () => {
  assert.throws(
    () =>
      registerInterruptionHandler({
        name: 'test-missing-desc',
        handle: async () => ({ status: 'continue' }),
      }),
    /description \(non-empty string\) required/,
  );
});

test('registerInterruptionHandler: rejects empty description', () => {
  assert.throws(
    () =>
      registerInterruptionHandler({
        name: 'test-empty-desc',
        description: '   ',
        handle: async () => ({ status: 'continue' }),
      }),
    /description \(non-empty string\) required/,
  );
});

test('registerInterruptionHandler: rejects missing handle', () => {
  assert.throws(
    () =>
      registerInterruptionHandler({
        name: 'test-no-handle',
        description: 'x',
      }),
    /handle \(async function\) required/,
  );
});

test('listInterruptionHandlers: includes registered entries', () => {
  registerInterruptionHandler({
    name: 'test-list-continue',
    description: 'Test stub returning continue; use when context.reason is "smoke_test".',
    handle: async () => ({ status: 'continue' }),
  });
  try {
    const list = listInterruptionHandlers();
    const names = list.map((h) => h.name);
    assert.ok(names.includes('test-list-continue'), 'registered handler surfaces');
    // `credential-autofill` ships as a plugin; scope of interruption
    // registry is agent-detected events only.
    assert.ok(names.includes('credential-autofill'), 'credential-autofill plugin present');
    // Shape: only {name, description}, no handle/predicate leaks.
    for (const entry of list) {
      assert.deepEqual(Object.keys(entry).sort(), ['description', 'name']);
    }
  } finally {
    unregisterInterruptionHandler('test-list-continue');
  }
});

test('invokeInterruptionHandler: resolves continue', async () => {
  registerInterruptionHandler({
    name: 'test-invoke-continue',
    description: 'Continue stub.',
    handle: async () => ({ status: 'continue', hint: 'plow on' }),
  });
  try {
    const res = await invokeInterruptionHandler(
      'test-invoke-continue',
      makeEvent({ reason: 'auth_wall_seen' }),
      FAKE_SESSION,
    );
    assert.equal(res.status, 'continue');
    assert.equal(res.hint, 'plow on');
  } finally {
    unregisterInterruptionHandler('test-invoke-continue');
  }
});

test('invokeInterruptionHandler: resolves with value', async () => {
  registerInterruptionHandler({
    name: 'test-captcha-static-apple',
    description:
      'Test stub for CAPTCHA; returns value APPLE. Use when context.reason is captcha_challenge.',
    handle: async () => ({ status: 'resolved', value: { captcha_token: 'APPLE' } }),
  });
  try {
    const res = await invokeInterruptionHandler(
      'test-captcha-static-apple',
      makeEvent({ reason: 'captcha_challenge' }),
      FAKE_SESSION,
    );
    assert.equal(res.status, 'resolved');
    assert.deepEqual(res.value, { captcha_token: 'APPLE' });
  } finally {
    unregisterInterruptionHandler('test-captcha-static-apple');
  }
});

test('invokeInterruptionHandler: 404 on unknown name', async () => {
  await assert.rejects(
    () => invokeInterruptionHandler('does-not-exist', makeEvent({ reason: 'x' }), FAKE_SESSION),
    /invalid_strategy: unknown resolver "does-not-exist"/,
  );
});

test('invokeInterruptionHandler: 404 error lists known names', async () => {
  try {
    await invokeInterruptionHandler('bogus', makeEvent({ reason: 'x' }), FAKE_SESSION);
    assert.fail('should have thrown');
  } catch (err) {
    // Error message contains registered names — helps agent correct typo.
    assert.match(err.message, /registered: \[/);
    assert.match(err.message, /credential-autofill/);
  }
});

test('same-name registration replaces prior handler', async () => {
  registerInterruptionHandler({
    name: 'test-replace',
    description: 'first',
    handle: async () => ({ status: 'resolved', value: 'first' }),
  });
  registerInterruptionHandler({
    name: 'test-replace',
    description: 'second',
    handle: async () => ({ status: 'resolved', value: 'second' }),
  });
  try {
    const res = await invokeInterruptionHandler(
      'test-replace',
      makeEvent({ reason: 'x' }),
      FAKE_SESSION,
    );
    assert.equal(res.value, 'second');
    const list = listInterruptionHandlers();
    const entry = list.find((h) => h.name === 'test-replace');
    assert.equal(entry.description, 'second');
  } finally {
    unregisterInterruptionHandler('test-replace');
  }
});

test('unregisterInterruptionHandler: no-op on unknown', () => {
  // Should not throw.
  unregisterInterruptionHandler('definitely-not-registered');
  assert.ok(true);
});

// -- resolveInterruption public API + token-gate --------------------------

// resolveInterruption (runtime-level wrapper) mints tokens on handover and
// stashes pending state per-session. Tests at this layer need a real
// session id — use klura.startSession / closeSession would be overkill, so
// we go through the exported API functions that accept session_id and
// rely on the pool.getSession lookup failing gracefully. Instead: we
// exercise the lower-level `mintInterruptionToken` + `assertNoPendingInterruption`
// via a real session stand-in.

const { pool } = await import('../dist/runtime-state.js');
const { mintInterruptionToken, assertNoPendingInterruption } = await import(
  '../dist/tool-helpers.js'
);

function withFakeSession(fn) {
  // Inject a minimal session into the pool. The pool's internal map is
  // private; stub .getSession for the duration of the test.
  const sid = `test-sess-${Math.random().toString(36).slice(2, 8)}`;
  const originalGet = pool.getSession.bind(pool);
  pool.getSession = (id) => (id === sid ? FAKE_SESSION : originalGet(id));
  try {
    return fn(sid);
  } finally {
    pool.getSession = originalGet;
  }
}

test('mintInterruptionToken: attaches pending state to session', () =>
  withFakeSession((sid) => {
    const token = mintInterruptionToken(sid, { reason: 'captcha_challenge' });
    assert.ok(typeof token === 'string' && token.length > 0);
    // Without the token, any subsequent check rejects.
    assert.throws(
      () => assertNoPendingInterruption(sid, {}),
      /pending_interruption/,
    );
  }));

test('assertNoPendingInterruption: accepts matching token + user_response', () =>
  withFakeSession((sid) => {
    const token = mintInterruptionToken(sid, { reason: 'auth_wall_seen' });
    assertNoPendingInterruption(sid, {
      interruption_token: token,
      user_response: 'continue please',
    });
    // After ack, the pending state is cleared — further calls pass.
    assertNoPendingInterruption(sid, {});
  }));

test('assertNoPendingInterruption: accepts cancelled with reason', () =>
  withFakeSession((sid) => {
    const token = mintInterruptionToken(sid, { reason: 'auth_wall_seen' });
    assertNoPendingInterruption(sid, {
      interruption_token: token,
      cancelled: true,
      reason: 'user walked away, abandoning',
    });
  }));

test('assertNoPendingInterruption: rejects cancel without reason', () =>
  withFakeSession((sid) => {
    const token = mintInterruptionToken(sid, { reason: 'auth_wall_seen' });
    assert.throws(
      () =>
        assertNoPendingInterruption(sid, {
          interruption_token: token,
          cancelled: true,
        }),
      /cancelled interruption requires a non-empty reason/,
    );
  }));

test('assertNoPendingInterruption: rejects ack without user_response / viewer_result', () =>
  withFakeSession((sid) => {
    const token = mintInterruptionToken(sid, { reason: 'auth_wall_seen' });
    assert.throws(
      () =>
        assertNoPendingInterruption(sid, {
          interruption_token: token,
          // no payload, no cancelled
        }),
      /acknowledgement must include/,
    );
  }));

test('assertNoPendingInterruption: rejects wrong / stale token', () =>
  withFakeSession((sid) => {
    mintInterruptionToken(sid, { reason: 'auth_wall_seen' });
    assert.throws(
      () =>
        assertNoPendingInterruption(sid, {
          interruption_token: 'bogus-token',
          user_response: 'hi',
        }),
      /pending_interruption/,
    );
  }));

test('assertNoPendingInterruption: no-op when no pending', () =>
  withFakeSession((sid) => {
    assertNoPendingInterruption(sid, {});
    // no throw
    assert.ok(true);
  }));
