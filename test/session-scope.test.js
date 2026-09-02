// SessionScope — the single owner of per-session teardown.
//
// Three layers of coverage:
//   1. Unit: hook registration semantics (idempotent by name, LIFO order,
//      per-hook exception isolation, idempotent + reentrancy-guarded
//      dispose) and parent/child topology (children dispose first, release
//      + self-unlink).
//   2. Pool integration: `Pool.endDrive` disposes the scope on the id-death
//      paths (cold destroy, borrowed-shared owner-gone) and does NOT dispose
//      on the borrowed-shared keep-alive path; write-site disposers
//      (pending checkpoint/interruption, starter cache, session
//      observations, logbook dedupe) all die with the session.
//   3. Recorded-path pause topology: an auto-execute pause adopts the inner
//      session under the outer id, so closing the outer session closes the
//      paused inner context and clears the pause + alias; a pause after a
//      resume re-registers the alias (outer-id resume keeps resolving).
//
// Also covers the pool's edge-armed idle-hibernation timer + unified
// `busy()` predicate (sessions OR warm slots block hibernation).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-session-scope-'));
process.env.KLURA_HOME = TMP;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ pool: { driver: 'playwright' } }));
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const {
  onSessionDispose,
  removeSessionDisposeHook,
  adoptChildSession,
  releaseChildSession,
  parentSessionOf,
  childSessionsOf,
  hasSessionScope,
  disposeSessionScope,
  _resetSessionScopesForTests,
} = await import('../dist/pool/session-scope.js');
const { Pool } = await import('../dist/pool/pool.js');

let seq = 0;
const sid = () => `sess_scope_${++seq}`;

// ---------------------------------------------------------------------------
// Unit: hook semantics
// ---------------------------------------------------------------------------

test('dispose runs own hooks LIFO and clears the scope', async () => {
  _resetSessionScopesForTests();
  const id = sid();
  const order = [];
  onSessionDispose(id, 'first', () => order.push('first'));
  onSessionDispose(id, 'second', () => order.push('second'));
  onSessionDispose(id, 'third', () => order.push('third'));
  assert.equal(hasSessionScope(id), true);
  const failures = await disposeSessionScope(id);
  assert.deepEqual(order, ['third', 'second', 'first']);
  assert.deepEqual(failures, []);
  assert.equal(hasSessionScope(id), false);
});

test('re-registering the same hook name keeps a single hook (latest body)', async () => {
  _resetSessionScopesForTests();
  const id = sid();
  let calls = 0;
  onSessionDispose(id, 'same', () => {
    calls += 100; // replaced — must not run
  });
  onSessionDispose(id, 'same', () => {
    calls += 1;
  });
  await disposeSessionScope(id);
  assert.equal(calls, 1);
});

test('removeSessionDisposeHook prevents the hook from running', async () => {
  _resetSessionScopesForTests();
  const id = sid();
  let ran = false;
  onSessionDispose(id, 'gone', () => {
    ran = true;
  });
  removeSessionDisposeHook(id, 'gone');
  assert.equal(hasSessionScope(id), false);
  await disposeSessionScope(id);
  assert.equal(ran, false);
});

test('a throwing hook never skips the rest; failures are aggregated', async () => {
  _resetSessionScopesForTests();
  const id = sid();
  const order = [];
  onSessionDispose(id, 'survivor-a', () => order.push('a'));
  onSessionDispose(id, 'boom', () => {
    throw new Error('hook exploded');
  });
  onSessionDispose(id, 'survivor-b', async () => {
    order.push('b');
  });
  const failures = await disposeSessionScope(id);
  assert.deepEqual(order, ['b', 'a'], 'both survivors ran despite the failure between them');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].hook, 'boom');
  assert.match(String(failures[0].error), /hook exploded/);
});

test('dispose is idempotent — a second call runs nothing', async () => {
  _resetSessionScopesForTests();
  const id = sid();
  let calls = 0;
  onSessionDispose(id, 'once', () => {
    calls += 1;
  });
  await disposeSessionScope(id);
  await disposeSessionScope(id);
  assert.equal(calls, 1);
});

test('reentrancy guard: a hook re-entering dispose for the same id is a no-op', async () => {
  _resetSessionScopesForTests();
  const id = sid();
  const order = [];
  onSessionDispose(id, 'outer-hook', async () => {
    order.push('outer');
    const nested = await disposeSessionScope(id);
    assert.deepEqual(nested, []);
  });
  await disposeSessionScope(id);
  assert.deepEqual(order, ['outer']);
});

// ---------------------------------------------------------------------------
// Unit: parent/child topology
// ---------------------------------------------------------------------------

test('adopted children dispose before the parent’s own hooks', async () => {
  _resetSessionScopesForTests();
  const parent = sid();
  const child = sid();
  const order = [];
  onSessionDispose(parent, 'parent-own', () => order.push('parent-own'));
  onSessionDispose(child, 'child-own', () => order.push('child-own'));
  adoptChildSession(parent, child, async () => {
    order.push('child-closer');
    // The closer stands in for pool.endDrive(child), which re-enters the
    // scope for the child's own hooks.
    await disposeSessionScope(child);
  });
  assert.equal(parentSessionOf(child), parent);
  assert.deepEqual(childSessionsOf(parent), [child]);

  await disposeSessionScope(parent);
  assert.deepEqual(order, ['child-closer', 'child-own', 'parent-own']);
  assert.equal(parentSessionOf(child), undefined);
  assert.deepEqual(childSessionsOf(parent), []);
});

test('releaseChildSession unlinks without closing', async () => {
  _resetSessionScopesForTests();
  const parent = sid();
  const child = sid();
  let closed = false;
  adoptChildSession(parent, child, () => {
    closed = true;
  });
  releaseChildSession(parent, child);
  assert.equal(parentSessionOf(child), undefined);
  await disposeSessionScope(parent);
  assert.equal(closed, false);
});

test('a child that dies on its own unlinks from a still-live parent', async () => {
  _resetSessionScopesForTests();
  const parent = sid();
  const child = sid();
  let closerCalls = 0;
  adoptChildSession(parent, child, () => {
    closerCalls += 1;
  });
  await disposeSessionScope(child);
  assert.equal(parentSessionOf(child), undefined);
  await disposeSessionScope(parent);
  assert.equal(closerCalls, 0, 'stale closer must not fire after the child self-disposed');
});

// ---------------------------------------------------------------------------
// Pool integration
// ---------------------------------------------------------------------------

class StubDriver {
  constructor() {
    this.closeBrowserCalls = 0;
    this.destroyed = [];
    /** css selector → remaining failures before the click succeeds */
    this.failCounts = new Map();
  }
  async createSession(opts = {}) {
    return {
      id: 'sess_stub_' + Math.random().toString(16).slice(2, 10),
      intercepted: [],
      intercepting: false,
      wsFrames: [],
      subPages: [],
      ...(opts.platform ? { platform: opts.platform } : {}),
      ...(opts.identity ? { identity: opts.identity } : {}),
    };
  }
  async destroySession(session) {
    this.destroyed.push(session.id);
  }
  async closeBrowser() {
    this.closeBrowserCalls += 1;
  }
  async delay() {}
  async navigate() {}
  async click(_s, selector) {
    const left = this.failCounts.get(selector) ?? 0;
    if (left > 0) {
      this.failCounts.set(selector, left - 1);
      throw new Error(`selector not found: ${selector}`);
    }
  }
  async type() {}
  async fillEditor() {}
  async select() {}
  async keyPress() {}
  async waitForSelector() {}
  async getAccessibilityTree() {
    return '- button "Send"';
  }
  async getUrl() {
    return 'https://example.test/page';
  }
  async screenshotJpeg() {
    return Buffer.from('');
  }
  async getInterceptedRequests() {
    return [];
  }
  async getInterceptedWebSocketFrames() {
    return [];
  }
  async saveStorageState() {}
  async cleanupDebuggerState() {}
}

test('Pool.endDrive (cold path) disposes the session scope', async () => {
  _resetSessionScopesForTests();
  const driver = new StubDriver();
  const pool = new Pool(class { constructor() { return driver; } });
  const session = await pool.createSession({ platform: 'scope-cold' });
  let ran = false;
  onSessionDispose(session.id, 'probe', () => {
    ran = true;
  });
  await pool.endDrive(session.id);
  assert.equal(ran, true);
  assert.equal(pool.activeSessions, 0);
  assert.deepEqual(driver.destroyed, [session.id]);
  await pool.shutdown();
});

test('Pool.endDrive keeps the scope alive on the borrowed-shared keep-alive path', async () => {
  _resetSessionScopesForTests();
  const driver = new StubDriver();
  const pool = new Pool(class { constructor() { return driver; } });
  const session = await pool.createSession({ platform: 'scope-shared' });
  const unregister = pool.registerSharedSession(session, 'scope-shared');
  session.borrowed = true;

  let ran = false;
  onSessionDispose(session.id, 'probe', () => {
    ran = true;
  });

  // Borrow release: owner (listener) still holds the registration — the id
  // survives and the scope must NOT be disposed.
  await pool.endDrive(session.id);
  assert.equal(ran, false, 'keep-alive release must not run disposers');
  assert.equal(pool.getSession(session.id), session, 'id stays valid for the owner');

  // Owner teardown: unregister, then endDrive for real — scope disposes.
  unregister();
  await pool.endDrive(session.id);
  assert.equal(ran, true);
  assert.equal(pool.activeSessions, 0);
  await pool.shutdown();
});

test('pending checkpoint + interruption state dies with the session', async () => {
  _resetSessionScopesForTests();
  const { mintCheckpointToken, assertNoPendingCheckpoint } = await import(
    '../dist/checkpoints/gate-glue.js'
  );
  const { mintInterruptionToken, assertNoPendingInterruption } = await import(
    '../dist/tools/helpers.js'
  );
  const driver = new StubDriver();
  const pool = new Pool(class { constructor() { return driver; } });
  const session = await pool.createSession({ platform: 'scope-pending' });

  mintCheckpointToken({ kind: 'recorded_step_failed', session_id: session.id, context: {} });
  mintInterruptionToken(session.id, { reason: 'captcha_challenge' });
  assert.throws(() => assertNoPendingCheckpoint(session.id, {}), /pending_checkpoint/);
  assert.throws(() => assertNoPendingInterruption(session.id, {}), /pending_interruption/);

  await pool.endDrive(session.id);
  // Unacked entries were dropped by scope disposal — the dead id no longer
  // trips the guards (and no longer leaks map entries).
  assert.doesNotThrow(() => assertNoPendingCheckpoint(session.id, {}));
  assert.doesNotThrow(() => assertNoPendingInterruption(session.id, {}));
  await pool.shutdown();
});

test('starter cache, session observations, and logbook dedupe die with the session', async () => {
  _resetSessionScopesForTests();
  const { recordStarterIssued, findIssuedStarter } = await import(
    '../dist/response/starter-cache.js'
  );
  const { recordParamObservation, findParamObservations } = await import(
    '../dist/response/session-observations.js'
  );
  const { recordObservedCapability, getObservedNamesForSession } = await import(
    '../dist/working-dir/logbook.js'
  );
  const driver = new StubDriver();
  const pool = new Pool(class { constructor() { return driver; } });
  const session = await pool.createSession({ platform: 'scope-caches' });

  recordStarterIssued(session.id, 3, 'msg', {
    code: "const captured = Buffer.from('QUJDREVGR0hJSktMTU5PUFFSUw==', 'base64');",
  });
  recordParamObservation(session.id, {
    param_name: 'cuisine',
    value: 'italian',
    source: { kind: 'ui_click', label: 'Italian' },
    observed_at: Date.now(),
  });
  recordObservedCapability('scope-caches', {
    name: 'view_orders',
    evidence: { source: 'nav' },
    why_not_lifted: 'other',
    session_id: session.id,
  });

  assert.ok(findIssuedStarter(session.id, 3));
  assert.equal(findParamObservations(session.id, 'cuisine').length, 1);
  assert.deepEqual(getObservedNamesForSession(session.id), ['view_orders']);

  await pool.endDrive(session.id);

  assert.equal(findIssuedStarter(session.id, 3), null);
  assert.equal(findParamObservations(session.id, 'cuisine').length, 0);
  assert.deepEqual(getObservedNamesForSession(session.id), []);
  await pool.shutdown();
});

// ---------------------------------------------------------------------------
// Recorded-path pause topology
// ---------------------------------------------------------------------------

const RECORDED_STRATEGY = {
  strategy: 'recorded-path',
  steps: [
    { id: 'nav_home', action: 'navigate', url: 'https://example.test/' },
    { id: 'click_send', action: 'click', locators: { css: 'button.send' } },
    { id: 'click_confirm', action: 'click', locators: { css: 'button.confirm' } },
  ],
};

test('closing the outer session closes a paused auto-execute inner session (no leaks)', async () => {
  _resetSessionScopesForTests();
  const { executeRecordedPath, resumeRecordedPath } = await import(
    '../dist/execution/recorded-path.js'
  );
  const { resolveAutoExecuteAlias } = await import('../dist/execution/auto-execute-alias.js');
  const driver = new StubDriver();
  const pool = new Pool(class { constructor() { return driver; } });

  const outer = pool.createNodeOnlySession({ platform: 'scope-pause' });
  driver.failCounts.set('button.send', Infinity);

  const result = await executeRecordedPath(
    RECORDED_STRATEGY,
    {},
    'scope-pause',
    'send_message',
    pool,
    null,
    undefined,
    outer.id,
  );
  assert.equal(result.body.failed_step_id, 'click_send');
  const innerId = result.body.session_id;
  assert.notEqual(innerId, outer.id);
  assert.equal(pool.activeSessions, 2, 'outer + paused inner both live');
  assert.equal(resolveAutoExecuteAlias(outer.id), innerId);
  assert.equal(parentSessionOf(innerId), outer.id);

  // The single teardown call both abort_session and end_drive converge on.
  await pool.endDrive(outer.id);

  assert.equal(pool.activeSessions, 0, 'paused inner context died with the outer session');
  assert.equal(resolveAutoExecuteAlias(outer.id), undefined, 'alias cleared by scope disposal');
  await assert.rejects(
    () => resumeRecordedPath(outer.id, pool),
    /No paused execution/,
    'paused entry cleared with the inner session',
  );
  await assert.rejects(() => resumeRecordedPath(innerId, pool), /No paused execution/);
  await pool.shutdown();
});

test('a pause after a resume re-registers the alias — outer-id resume keeps resolving', async () => {
  _resetSessionScopesForTests();
  const { executeRecordedPath, resumeRecordedPath } = await import(
    '../dist/execution/recorded-path.js'
  );
  const { resolveAutoExecuteAlias } = await import('../dist/execution/auto-execute-alias.js');
  const driver = new StubDriver();
  const pool = new Pool(class { constructor() { return driver; } });

  const outer = pool.createNodeOnlySession({ platform: 'scope-repause' });
  // First replay: click_send fails once (pause #1). First resume: click_send
  // passes, click_confirm fails once (pause #2). Second resume: everything
  // passes.
  driver.failCounts.set('button.send', 1);
  driver.failCounts.set('button.confirm', 1);

  const first = await executeRecordedPath(
    RECORDED_STRATEGY,
    {},
    'scope-repause',
    'send_message',
    pool,
    null,
    undefined,
    outer.id,
  );
  assert.equal(first.body.failed_step_id, 'click_send');
  const innerId = first.body.session_id;

  const second = await resumeRecordedPath(outer.id, pool);
  assert.equal(second.body.failed_step_id, 'click_confirm', 'tail paused again downstream');
  assert.equal(
    resolveAutoExecuteAlias(outer.id),
    innerId,
    'second pause re-registered the outer→inner alias',
  );

  const third = await resumeRecordedPath(outer.id, pool);
  assert.equal(third.status, 200, 'outer-id resume resolved the second pause');
  assert.equal(third.body.ok, true);

  // Successful completion closed the inner session; only the outer remains.
  assert.equal(pool.activeSessions, 1);
  await pool.endDrive(outer.id);
  assert.equal(pool.activeSessions, 0);
  await pool.shutdown();
});

// ---------------------------------------------------------------------------
// Idle hibernation: edge-armed timer + unified busy() predicate
// ---------------------------------------------------------------------------

test('idle timer hibernates after the last session ends, never while busy', async () => {
  _resetSessionScopesForTests();
  const driver = new StubDriver();
  // idleTimeout is in seconds.
  const pool = new Pool(class { constructor() { return driver; } }, { idleTimeout: 0.1 });
  const session = await pool.createSession({ platform: 'scope-idle' });
  assert.equal(pool.busy(), true);

  // Timer fires while a session is live → busy() blocks hibernation.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(driver.closeBrowserCalls, 0, 'must not hibernate while a session is live');

  // endDrive is the lifecycle edge that re-arms the timer.
  await pool.endDrive(session.id);
  assert.equal(pool.busy(), false);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(driver.closeBrowserCalls, 1, 'hibernated after the idle window elapsed');
  await pool.shutdown();
});

test('busy() counts warm slots — a warm lease blocks hibernation', async () => {
  _resetSessionScopesForTests();
  const driver = new StubDriver();
  driver.detachLease = () => ({ kind: 'stub-lease' });
  driver.attachLease = () => {};
  driver.destroyLease = async () => {};
  const pool = new Pool(class { constructor() { return driver; } }, {
    idleTimeout: 0.1,
    warm: { enabled: true, maxContexts: 2, idleTtlSeconds: 600 },
  });
  const session = await pool.createSession({ platform: 'scope-warm' });
  await pool.endDrive(session.id);
  // Session id is dead but its browser resources are stashed warm.
  assert.equal(pool.activeSessions, 0);
  assert.equal(pool.busy(), true, 'warm slot counts as busy');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(driver.closeBrowserCalls, 0, 'warm lease must survive idleness');
  await pool.shutdown();
});
