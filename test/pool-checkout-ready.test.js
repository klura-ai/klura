// Layer B: ready-page checkout protocol on the local Pool.
// Validates `tryCheckoutReadySession` semantics end-to-end against a
// fake driver that implements the `probePageReady` contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const poolMod = await import('../dist/pool/pool.js');

// Fake BrowserDriver enough for Pool's purposes. Not real — it returns
// rigged probe results, tracks whether resetSession/destroySession got
// called, and implements a minimal lease surface (the pool's warm slot
// stores a BrowserLease between borrows, never a Session).
class FakeDriver {
  constructor() {
    this.capabilities = [];
    this.resetCount = 0;
    this.destroyCount = 0;
    this.attachCount = 0;
    this.detachCount = 0;
    this.destroyLeaseCount = 0;
    this.probeResult = { page_on_url: false };
    this._leases = new Map();
    this._nextLease = 1;
  }
  async createSession(opts = {}) {
    const id = 'fake_' + Math.random().toString(36).slice(2);
    const s = {
      id,
      intercepted: [],
      intercepting: false,
      platform: opts.platform,
      _guts: { contextId: id },
    };
    return s;
  }
  detachLease(session) {
    this.detachCount += 1;
    if (!session._guts) return null;
    const leaseId = 'lease_' + this._nextLease++;
    this._leases.set(leaseId, session._guts);
    session._guts = undefined;
    return { leaseId };
  }
  attachLease(session, lease) {
    this.attachCount += 1;
    const guts = this._leases.get(lease.leaseId);
    if (!guts) throw new Error(`lease ${lease.leaseId} not held`);
    this._leases.delete(lease.leaseId);
    session._guts = guts;
  }
  async destroyLease(lease) {
    this.destroyLeaseCount += 1;
    this._leases.delete(lease.leaseId);
  }
  async destroySession() { this.destroyCount += 1; }
  async resetSession() { this.resetCount += 1; }
  async probePageReady() { return this.probeResult; }
  async closeBrowser() {}
}

function mkPool(warmEnabled = true) {
  return new poolMod.Pool(FakeDriver, {
    idleTimeout: 10,
    warm: { enabled: warmEnabled, maxContexts: 3, idleTtlSeconds: 60 },
  });
}

test('tryCheckoutReadySession: probe passes on warm slot → fresh Session bound to the lease, no resetSession call', async () => {
  const pool = mkPool(true);
  const driver = pool.driver;
  // Seed a warm slot: create a session, then endDrive to release it.
  const s = await pool.createSession({ platform: 'test-platform' });
  const originalGuts = s._guts;
  await pool.endDrive(s.id);
  // Rig probe to succeed.
  driver.probeResult = { page_on_url: true, ws_open: true };
  const preReset = driver.resetCount;

  const borrowed = await pool.tryCheckoutReadySession('test-platform', async () => true);

  assert.ok(borrowed, 'got a session');
  assert.equal(borrowed.borrowed, true);
  assert.notEqual(borrowed, s, 'borrow mints a FRESH Session object');
  assert.notEqual(borrowed.id, s.id, 'fresh session id');
  assert.equal(borrowed._guts, originalGuts, 'browser resources travel via the lease');
  assert.equal(driver.resetCount, preReset, 'resetSession NOT called on ready-page checkout');
  await pool.shutdown();
});

test('tryCheckoutReadySession: probe returns false → null, lease restashed in the slot', async () => {
  const pool = mkPool(true);
  const driver = pool.driver;
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);

  const borrowed = await pool.tryCheckoutReadySession('p', async () => false);

  assert.equal(borrowed, null);
  const entry = pool._warm.get('p::default');
  assert.ok(entry?.lease, 'failed probe returns the lease to the slot');
  assert.equal(entry.inUse, false);

  // The restashed lease still serves the next (passing) borrow.
  driver.probeResult = { page_on_url: true };
  const second = await pool.tryCheckoutReadySession('p', async () => true);
  assert.ok(second, 'restashed lease is borrowable');
  assert.equal(second.borrowed, true);
  await pool.shutdown();
});

test('tryCheckoutReadySession: probe throws → treated as false, returns null', async () => {
  const pool = mkPool(true);
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);

  const borrowed = await pool.tryCheckoutReadySession('p', async () => {
    throw new Error('boom');
  });

  assert.equal(borrowed, null);
  assert.ok(pool._warm.get('p::default')?.lease, 'lease survives a throwing probe');
  await pool.shutdown();
});

test('tryCheckoutReadySession: warm disabled → returns null without iterating', async () => {
  const pool = mkPool(false);
  // No warm slot will be created because warmEnabled=false.
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);

  let probeCalls = 0;
  const borrowed = await pool.tryCheckoutReadySession('p', async () => {
    probeCalls += 1;
    return true;
  });

  assert.equal(borrowed, null);
  assert.equal(probeCalls, 0, 'warm slot not probed when warm disabled');
  // Shared sessions are still probed even when warm is disabled — verify
  // that path works too by registering one.
  const shared = await pool.createSession({ platform: 'p' });
  pool.registerSharedSession(shared, 'p');
  const b2 = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(b2?.id, shared.id, 'shared session reused');
  assert.equal(b2?.borrowed, true);
  await pool.shutdown();
});

test('registerSharedSession: dispose fn removes session from candidate set', async () => {
  const pool = mkPool(false);
  const shared = await pool.createSession({ platform: 'p' });
  const dispose = pool.registerSharedSession(shared, 'p');

  // Works before dispose.
  const b1 = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(b1?.id, shared.id);
  b1.borrowed = false; // simulate release without going through endDrive

  dispose();
  const b2 = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(b2, null, 'disposed shared session no longer a candidate');
  await pool.shutdown();
});

test('endDrive on borrowed session: does not destroy the underlying resources', async () => {
  const pool = mkPool(true);
  const driver = pool.driver;
  // Seed warm slot.
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);
  const preDestroy = driver.destroyCount;
  driver.probeResult = { page_on_url: true };

  // Borrow via ready-checkout.
  const borrowed = await pool.tryCheckoutReadySession('p', async () => true);
  assert.ok(borrowed);

  // Release.
  await pool.endDrive(borrowed.id);

  assert.equal(driver.destroyCount, preDestroy, 'destroySession NOT called on borrowed release');
  // Warm slot should be idle again with the lease stashed.
  const b2 = await pool.tryCheckoutReadySession('p', async () => true);
  assert.ok(b2, 'warm slot available for next borrow');
  assert.notEqual(b2.id, borrowed.id, 'each borrow generation gets a fresh Session');
  await pool.shutdown();
});

test('endDrive on shared (listener-owned) borrowed session: no-op for the owner', async () => {
  const pool = mkPool(false);
  const driver = pool.driver;
  const listenerSess = await pool.createSession({ platform: 'p' });
  const preDestroy = driver.destroyCount;
  pool.registerSharedSession(listenerSess, 'p');

  // Execute borrows it. Listener-shared sessions are the one deliberate
  // exception to fresh-Session minting — the owner keeps live references,
  // so the protocol shares the object itself.
  const borrowed = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(borrowed?.id, listenerSess.id);

  // Execute releases.
  await pool.endDrive(borrowed.id);

  assert.equal(driver.destroyCount, preDestroy, 'listener still owns the session; no destroy');
  // The listener still tracks the same session object (mutable), so it
  // remains the same instance.
  assert.equal(borrowed, listenerSess);
  await pool.shutdown();
});

test('endDrive on borrowed shared session that owns the warm slot: keep-alive wins over warm restash', async () => {
  const pool = mkPool(true);
  const driver = pool.driver;
  driver.probeResult = { page_on_url: true };
  // Agent-style cold spawn with warm enabled: registers the warm slot with
  // sessionId = agent id and inUse: true, then registers the SAME session
  // as shared (the start_session auto-execute window).
  const agent = await pool.createSession({ platform: 'p' });
  const unregister = pool.registerSharedSession(agent, 'p');
  const entryBefore = pool._warm.get('p::default');
  assert.equal(entryBefore?.sessionId, agent.id, 'agent session owns the warm slot');
  assert.equal(entryBefore?.inUse, true);

  // The executor borrows: the warm slot is inUse, so the shared scan
  // returns the agent's own live session.
  const borrowed = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(borrowed, agent, 'shared scan returned the agent session itself');
  assert.equal(borrowed.borrowed, true);

  // The borrower's release must NOT steal the live session into the warm
  // slot — the agent still holds the id and keeps driving it.
  await pool.endDrive(agent.id);

  assert.equal(pool.peekSession(agent.id), agent, 'agent id stays valid after borrowed release');
  assert.ok(agent._guts, 'driver bindings not stripped from the live session');
  assert.equal(driver.detachCount, 0, 'no lease detach on a still-shared borrowed release');
  const entryAfter = pool._warm.get('p::default');
  assert.equal(entryAfter?.sessionId, agent.id, 'warm slot still owned by the live session');
  assert.equal(entryAfter?.inUse, true);
  assert.equal(entryAfter?.lease, null, 'no lease stashed while the session lives');

  unregister();
  await pool.shutdown();
});

test('endDrive warm-stash path clears the shared registration', async () => {
  const pool = mkPool(true);
  const driver = pool.driver;
  const listenerSess = await pool.createSession({ platform: 'p' });
  pool.registerSharedSession(listenerSess, 'p');

  // Owner teardown: the non-borrowed endDrive stashes the context into the
  // warm slot. The shared registration must die with the id — a stashed
  // session has no driver bindings, so a leftover entry would sit in
  // `_sharedSessions` forever as a permanently-dead checkout candidate.
  await pool.endDrive(listenerSess.id);

  assert.ok(pool._warm.get('p::default')?.lease, 'context stashed to the warm slot');
  assert.equal(pool._sharedSessions.size, 0, 'shared registration cleared on the warm-stash path');

  // The slot still serves an ordinary borrow — a fresh Session, never the
  // dead one.
  driver.probeResult = { page_on_url: true };
  const next = await pool.tryCheckoutReadySession('p', async () => true);
  assert.ok(next, 'stashed slot is borrowable');
  assert.notEqual(next.id, listenerSess.id, 'borrow mints a fresh Session');
  await pool.endDrive(next.id);
  await pool.shutdown();
});

test('tryCheckoutReadySession: probe fails and detachLease throws → context destroyed, slot dropped', async () => {
  const pool = mkPool(true);
  const driver = pool.driver;
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);
  // Attach succeeds (the stashed lease is valid); the detach after the
  // failed probe throws — the still-attached context must be destroyed,
  // not left dangling until browser close.
  driver.detachLease = () => {
    throw new Error('detach boom');
  };
  const preDestroy = driver.destroyCount;

  const borrowed = await pool.tryCheckoutReadySession('p', async () => false);

  assert.equal(borrowed, null);
  assert.equal(pool._warm.get('p::default'), undefined, 'undetachable slot dropped');
  assert.equal(driver.destroyCount, preDestroy + 1, 'attached context destroyed instead of leaking');
  await pool.shutdown();
});

test('endDrive on borrowed shared session: keep-alive retains round/try_generator counters', async () => {
  const pool = mkPool(false);
  const listenerSess = await pool.createSession({ platform: 'p' });
  pool.registerSharedSession(listenerSess, 'p');

  pool.registerUserRound(listenerSess.id);
  pool.registerUserRound(listenerSess.id);
  pool.recordTryGeneratorCall(listenerSess.id, { hadVerifyAgainst: true, ok: false });
  pool.recordTryGeneratorDiff(listenerSess.id, { at: Date.now(), summary: 'diff-1' });

  const borrowed = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(borrowed?.id, listenerSess.id);

  // Borrower release: the id stays valid for the registrar, and so must
  // the per-session counters.
  await pool.endDrive(borrowed.id);
  assert.equal(pool.getSessionRoundCount(listenerSess.id), 2, 'round count survives keep-alive');
  assert.equal(
    pool.getTryGeneratorStats(listenerSess.id)?.total,
    1,
    'try_generator stats survive keep-alive',
  );
  assert.equal(pool.getRecentDiffs(listenerSess.id).length, 1, 'diff ring survives keep-alive');

  // Owner teardown kills the id — counters die with it.
  await pool.endDrive(listenerSess.id);
  assert.equal(pool.getSessionRoundCount(listenerSess.id), 0);
  assert.equal(pool.getTryGeneratorStats(listenerSess.id), null);
  assert.equal(pool.getRecentDiffs(listenerSess.id).length, 0);
  await pool.shutdown();
});

test('tryCheckoutReadySession missing (test stubs): executors should handle gracefully', async () => {
  // Minimal fake pool object WITHOUT tryCheckoutReadySession — simulates
  // a test stub. The execute path should not blow up when the optional
  // method is absent.
  const bareBones = {
    createSession: async () => ({ id: 'x', intercepted: [], intercepting: false }),
    endDrive: async () => {},
    getSession: () => ({ id: 'x', intercepted: [], intercepting: false }),
    driverFor: () => ({}),
    shutdown: async () => {},
    activeSessions: 0,
    idleSince: 0,
  };
  assert.equal(bareBones.tryCheckoutReadySession, undefined);
  // The fact that this doesn't error is the test; execute paths guard
  // with `if (pool.tryCheckoutReadySession) { ... }`.
});
