// Mutating-action consent gate. perform_action(click) on a destructive
// selector must emit a consent checkpoint (and refuse to dispatch the
// action) when the active graph sets `gateMutatingActions: true` (today,
// the map graph). Discover/execute graphs are unchanged — no gate, action
// dispatches normally.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-mm-consent-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const { performAction } = await import('../dist/index.js');
const { pool } = await import('../dist/runtime-state.js');

function fakeSession({ graph, clickTarget }) {
  let clicks = 0;
  const fakeDriver = {
    getDebuggerPauseState: () => null,
    click: async () => { clicks += 1; return { name: 'btn' }; },
    delay: async () => {},
    getUrl: async () => 'https://x.example/',
    getAccessibilityTree: async () => '<root />',
    inspectActionTarget: async () => clickTarget ?? null,
    consumePendingNavs: async () => [],
    captureFormSummary: async () => [],
  };
  const session = {
    id: 'sess-mm-' + Math.random().toString(36).slice(2, 8),
    graph,
    performActionHistory: [],
    extractedContentBytes: 0,
    domNavigations: [],
  };
  const origGet = pool.getSession;
  const origDriver = pool.driverFor;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.driverFor = (id) => (id === session.id ? fakeDriver : origDriver.call(pool, id));
  return {
    session,
    getClickCount: () => clicks,
    restore: () => {
      pool.getSession = origGet;
      pool.driverFor = origDriver;
    },
  };
}

test('map graph: click on "Buy now" emits consent gate, action does NOT dispatch', async () => {
  const { session, getClickCount, restore } = fakeSession({ graph: 'map' });
  try {
    let err;
    try {
      await performAction(session.id, 'click', 'button:has-text("Buy now")');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected consent rejection');
    assert.match(err.message, /action_consent_required/);
    assert.match(err.message, /checkpoint_token: "?\w+/);
    assert.equal(getClickCount(), 0, 'driver.click must not have been called');
  } finally {
    restore();
  }
});

test('map graph: typing into a safe text input → no gate (structurally safe)', async () => {
  const { session, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'input',
      inputType: 'search',
      href: null,
      onclick: null,
      formaction: null,
      inWriteForm: false,
      submitLike: false,
    },
  });
  pool.driverFor(session.id).type = async () => {};
  try {
    const r = await performAction(session.id, 'type', '#search', 'delete account');
    assert.ok(r);
  } finally {
    restore();
  }
});

test('discover graph: click on "Buy now" passes through, driver.click fires', async () => {
  const { session, getClickCount, restore } = fakeSession({ graph: 'discover' });
  try {
    const r = await performAction(session.id, 'click', 'button:has-text("Buy now")');
    assert.ok(r);
    assert.equal(getClickCount(), 1, 'driver.click should fire on discover graph');
  } finally {
    restore();
  }
});

test('map graph: click on <a href="/orders"> → no consent (GET navigation exempt)', async () => {
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'a',
      href: '/orders',
      onclick: null,
      formaction: null,
      inWriteForm: false,
      submitLike: false,
    },
  });
  try {
    const r = await performAction(session.id, 'click', 'a[href="/orders"]');
    assert.ok(r);
    assert.equal(getClickCount(), 1, 'driver.click should fire — anchor GET click is exempt');
  } finally {
    restore();
  }
});

test('map graph: click on <button>Buy</button> → consent required', async () => {
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'button',
      href: null,
      onclick: null,
      formaction: null,
      inWriteForm: false,
      submitLike: true,
    },
  });
  try {
    let err;
    try {
      await performAction(session.id, 'click', 'button:has-text("Buy")');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected consent rejection');
    assert.match(err.message, /action_consent_required/);
    assert.equal(getClickCount(), 0);
  } finally {
    restore();
  }
});

test('map graph: <input type="submit"> inside form[method=POST] → consent required', async () => {
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'input',
      href: null,
      onclick: null,
      formaction: null,
      inWriteForm: true,
      submitLike: true,
    },
  });
  try {
    let err;
    try {
      await performAction(session.id, 'click', 'input[value="Place order"]');
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.match(err.message, /action_consent_required/);
    assert.equal(getClickCount(), 0);
  } finally {
    restore();
  }
});

test('map graph: <a href="/cart/delete"> → no consent (GET-shaped link)', async () => {
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'a',
      href: '/cart/delete',
      onclick: null,
      formaction: null,
      inWriteForm: false,
      submitLike: false,
    },
  });
  try {
    const r = await performAction(session.id, 'click', 'a[href="/cart/delete"]');
    assert.ok(r);
    assert.equal(getClickCount(), 1);
  } finally {
    restore();
  }
});

test('map graph: <a> with mutating onclick → consent required', async () => {
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'a',
      href: '/foo',
      onclick: 'fetch("/api/delete", {method: "POST"})',
      formaction: null,
      inWriteForm: false,
      submitLike: false,
    },
  });
  try {
    let err;
    try {
      await performAction(session.id, 'click', 'a[onclick]:has-text("delete")');
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.match(err.message, /action_consent_required/);
    assert.equal(getClickCount(), 0);
  } finally {
    restore();
  }
});

test('map graph: session-wide ack (mapGateAcked=true) admits any subsequent mutating click', async () => {
  // Once the session has acked once, no further per-action prompts —
  // session-wide consent. The bauhaus loop bug was the prior per-(action,
  // selector) sticky-cache: each new selector re-prompted, even after the
  // user had already opted into mapping.
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'button',
      href: null,
      onclick: null,
      formaction: null,
      inWriteForm: false,
      submitLike: true,
    },
  });
  try {
    // Prior ack flips the session bool — short-circuit the prompt path.
    session.mapGateAcked = true;
    const r1 = await performAction(session.id, 'click', 'button:has-text("Buy")');
    assert.ok(r1);
    assert.equal(getClickCount(), 1, 'first click after ack fires');
    // A different selector, still mutating, still admits — no re-prompt.
    const r2 = await performAction(session.id, 'click', 'button.confirm-delete');
    assert.ok(r2);
    assert.equal(getClickCount(), 2, 'second different selector also fires session-wide');
  } finally {
    restore();
  }
});

test('map graph: cancellation does NOT flip the session bool', async () => {
  // Consenting flips mapGateAcked; cancelling clears the pending nonce
  // but leaves mapGateAcked false so the next mutating action prompts
  // again — preserves the user's right to decline.
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'button',
      href: null,
      onclick: null,
      formaction: null,
      inWriteForm: false,
      submitLike: true,
    },
  });
  try {
    let err;
    try {
      await performAction(session.id, 'click', 'button:has-text("Buy")');
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.match(err.message, /action_consent_required/);
    assert.equal(session.mapGateAcked, undefined, 'mapGateAcked unset before ack');
    // Simulating cancellation: the nonce is consumed but the flag stays unset.
    session.pendingActionConsents?.clear();
    assert.notEqual(session.mapGateAcked, true);
    // Next action still prompts (no flip happened).
    let err2;
    try {
      await performAction(session.id, 'click', 'button.different');
    } catch (e) {
      err2 = e;
    }
    assert.ok(err2);
    assert.match(err2.message, /action_consent_required/);
    assert.equal(getClickCount(), 0, 'no driver.click ever fired');
  } finally {
    restore();
  }
});
