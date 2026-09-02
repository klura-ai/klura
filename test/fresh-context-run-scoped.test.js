// C2: the verification browser context is scoped to the verification RUN, not
// to a single executor call.
//
// A consent click, login, or any other prereq side effect has to still be there
// when the request that depends on it fires. The facade therefore keeps one
// context per (platform, identity) alive for the whole run and tears them all
// down in `finally`. Identity isolation is not negotiable — cookie-jar bleed
// across identities is the invariant the warm pool already protects.

import test from 'node:test';
import assert from 'node:assert/strict';

const { withFreshVerificationPool } = await import('../dist/pool/fresh-context-pool.js');

function makeBase() {
  const created = [];
  const ended = [];
  let nextId = 0;
  let failNext = false;
  const base = {
    async createSession(opts = {}) {
      created.push({ ...opts });
      if (failNext) {
        failNext = false;
        throw new Error('spawn refused');
      }
      return { id: `session-${++nextId}`, intercepted: [], intercepting: false };
    },
    createNodeOnlySession(opts) {
      return { id: 'node-only', nodeOnly: true, ...opts };
    },
    async endDrive(sessionId) {
      ended.push(sessionId);
    },
    getSession(sessionId) {
      return { id: sessionId };
    },
    driverFor(sessionId) {
      return { id: `driver-for-${sessionId}` };
    },
    async shutdown() {},
    get activeSessions() {
      return 0;
    },
    get activeSessionIds() {
      return [];
    },
    get idleSince() {
      return 0;
    },
    get connectEnabled() {
      return false;
    },
  };
  return {
    base,
    created,
    ended,
    failNextCreate() {
      failNext = true;
    },
  };
}

// ---------- case 1: one context per run, torn down once ----------

test('repeat createSession for the same (platform, identity) reuses one context', async () => {
  const state = makeBase();
  const ids = await withFreshVerificationPool(state.base, async (pool) => {
    const a = await pool.createSession({ platform: 'acme' });
    const b = await pool.createSession({ platform: 'acme' });
    const c = await pool.createSession({ platform: 'acme' });
    return [a.id, b.id, c.id];
  });
  assert.deepEqual(ids, ['session-1', 'session-1', 'session-1']);
  assert.equal(state.created.length, 1);
  assert.deepEqual(state.ended, ['session-1']);
});

// ---------- case 2: side effects survive an executor's endDrive ----------

test('endDrive is a no-op for run-owned sessions and teardown happens once', async () => {
  const state = makeBase();
  await withFreshVerificationPool(state.base, async (pool) => {
    const session = await pool.createSession({ platform: 'acme' });
    // Each executor closes "its" session in a finally block; the run owns it.
    await pool.endDrive(session.id);
    await pool.endDrive(session.id);
    assert.deepEqual(state.ended, [], 'the run, not the executor, owns context lifetime');
    const again = await pool.createSession({ platform: 'acme' });
    assert.equal(again.id, session.id, 'the post-consent context is still the same one');
  });
  assert.deepEqual(state.ended, ['session-1']);
  assert.equal(state.created.length, 1);
});

test('endDrive still forwards for sessions the run does not own', async () => {
  const state = makeBase();
  await withFreshVerificationPool(state.base, async (pool) => {
    await pool.endDrive('foreign-session');
  });
  assert.deepEqual(state.ended, ['foreign-session']);
});

// ---------- case 3: identity isolation ----------

test('a different identity on the same platform gets a SECOND context', async () => {
  const state = makeBase();
  const ids = await withFreshVerificationPool(state.base, async (pool) => {
    const a = await pool.createSession({ platform: 'acme', identity: 'alice' });
    const b = await pool.createSession({ platform: 'acme', identity: 'bob' });
    const aAgain = await pool.createSession({ platform: 'acme', identity: 'alice' });
    return [a.id, b.id, aAgain.id];
  });
  assert.deepEqual(ids, ['session-1', 'session-2', 'session-1']);
  assert.equal(state.created.length, 2);
  assert.deepEqual(state.ended.sort(), ['session-1', 'session-2']);
});

test('a cross-platform capability prereq gets a SECOND context', async () => {
  const state = makeBase();
  const ids = await withFreshVerificationPool(state.base, async (pool) => {
    const caller = await pool.createSession({ platform: 'acme' });
    const prereq = await pool.createSession({ platform: 'partner-idp' });
    return [caller.id, prereq.id];
  });
  assert.deepEqual(ids, ['session-1', 'session-2']);
  assert.equal(state.created.length, 2);
  assert.deepEqual(state.created[0].platform, 'acme');
  assert.deepEqual(state.created[1].platform, 'partner-idp');
  assert.deepEqual(state.ended.sort(), ['session-1', 'session-2']);
});

// ---------- case 4: the contamination guards the facade always carried ----------

test('every created session is internal, fresh-context and storage-state free', async () => {
  const state = makeBase();
  await withFreshVerificationPool(state.base, async (pool) => {
    await pool.createSession({ platform: 'acme', storageState: '/tmp/discovery-cookies.json' });
  });
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].internal, true);
  assert.equal(state.created[0].freshContext, true);
  assert.equal(
    Object.hasOwn(state.created[0], 'storageState'),
    false,
    'persisted discovery storage must not seed verification',
  );
});

test('the facade exposes no ready-page checkout and no shared js-eval cache', async () => {
  const state = makeBase();
  await withFreshVerificationPool(state.base, async (pool) => {
    assert.equal(pool.tryCheckoutReadySession, undefined);
    assert.equal(pool.jsEvalCache, undefined);
  });
});

// ---------- case 5: teardown is guaranteed, isolated and idempotent ----------

test('a throwing body still tears every context down', async () => {
  const state = makeBase();
  await assert.rejects(
    withFreshVerificationPool(state.base, async (pool) => {
      await pool.createSession({ platform: 'acme' });
      await pool.createSession({ platform: 'other' });
      throw new Error('verification blew up');
    }),
    /verification blew up/,
  );
  assert.deepEqual(state.ended.sort(), ['session-1', 'session-2']);
});

test('one context that refuses to close does not strand the others', async () => {
  const state = makeBase();
  const ended = [];
  state.base.endDrive = async (sessionId) => {
    ended.push(sessionId);
    if (sessionId === 'session-1') throw new Error('context wedged');
  };
  await withFreshVerificationPool(state.base, async (pool) => {
    await pool.createSession({ platform: 'a' });
    await pool.createSession({ platform: 'b' });
    await pool.createSession({ platform: 'c' });
  });
  assert.deepEqual(ended.sort(), ['session-1', 'session-2', 'session-3']);
});

test('shutdown disposes the run scope, and a second disposal is a no-op', async () => {
  const state = makeBase();
  await withFreshVerificationPool(state.base, async (pool) => {
    await pool.createSession({ platform: 'acme' });
    await pool.shutdown();
    assert.deepEqual(state.ended, ['session-1']);
  });
  assert.deepEqual(state.ended, ['session-1'], 'the finally disposal must not double-close');
});

// ---------- case 6: a failed spawn does not poison the slot ----------

test('a failed createSession leaves the (platform, identity) slot retryable', async () => {
  const state = makeBase();
  await withFreshVerificationPool(state.base, async (pool) => {
    state.failNextCreate();
    await assert.rejects(pool.createSession({ platform: 'acme' }), /spawn refused/);
    const retry = await pool.createSession({ platform: 'acme' });
    assert.equal(retry.id, 'session-1');
  });
  assert.deepEqual(state.ended, ['session-1']);
});

// ---------- case 7: plumbing passes straight through ----------

test('node-only sessions, driver lookup and pool getters delegate to the base pool', async () => {
  const state = makeBase();
  await withFreshVerificationPool(state.base, async (pool) => {
    assert.equal(pool.createNodeOnlySession({ platform: 'acme' }).id, 'node-only');
    assert.equal(pool.driverFor('session-9').id, 'driver-for-session-9');
    assert.equal(pool.getSession('session-9').id, 'session-9');
    assert.equal(pool.connectEnabled, false);
    assert.equal(pool.activeSessions, 0);
    assert.deepEqual(pool.activeSessionIds, []);
    assert.equal(pool.idleSince, 0);
    // registerUserRound is optional on the base pool; calling it must not throw.
    pool.registerUserRound('session-9');
  });
});
