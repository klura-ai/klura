import test from 'node:test';
import assert from 'node:assert';
import { Pool } from '../dist/pool/pool.js';

class NoopDriver {
  get capabilities() {
    return [];
  }

  async createSession() {
    return { id: 'unused', intercepted: [], intercepting: false };
  }

  async destroySession() {}

  async closeBrowser() {}
}

test('session lookups are pure; only registerUserRound moves round accounting', async () => {
  const pool = new Pool(NoopDriver, { idleTimeout: 1 });
  const session = pool.createNodeOnlySession({ platform: 'example' });
  session.lift = {
    handoffAt: Date.now(),
    roundsSinceHandoff: 7,
    budget: 0,
    softBlockEngaged: false,
  };

  try {
    assert.strictEqual(pool.peekSession(session.id), session);
    assert.equal(pool.peekSession('sess_missing'), null);
    assert.equal(pool.getSessionRoundCount(session.id), 0);
    assert.equal(session.lift.roundsSinceHandoff, 7);

    // getSession is a pure lookup — repeated handler-style lookups leave
    // both the pool round count and the phase counter untouched.
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual(pool.getSession(session.id), session);
    }
    assert.equal(pool.getSessionRoundCount(session.id), 0);
    assert.equal(session.lift.roundsSinceHandoff, 7);

    // registerUserRound is the single increment point for the pool count,
    // and it never touches per-phase bookkeeping — tickPhaseCounter in the
    // phase middleware is the sole writer of roundsSinceHandoff.
    pool.registerUserRound(session.id);
    assert.equal(pool.getSessionRoundCount(session.id), 1);
    assert.equal(session.lift.roundsSinceHandoff, 7);

    // Unknown ids are a no-op, not a throw.
    pool.registerUserRound('sess_missing');
    assert.equal(pool.getSessionRoundCount('sess_missing'), 0);
  } finally {
    await pool.endDrive(session.id);
    await pool.shutdown();
  }
});
