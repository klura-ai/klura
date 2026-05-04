// dom_navigation + dom_form_observed emit tests for the platform surface map.
//
// Three guarantees, all without spinning a real browser:
//   (a) perform_action(navigate) twice in one session lands two
//       dom_navigations on session state, which fold into 2 url_graph
//       nodes + 1 edge after end_drive flushes.
//   (b) A click that triggers a SPA route change (simulated via a fake
//       driver buffering a pending nav) lands a dom_navigation tagged
//       `via:'click'`.
//   (c) captureFormSummary results pushed by perform_action land in
//       session.domFormsObserved and reach forms_seen at flush time.
//
// Browser-driven coverage lives in llm-tests/scenarios/platform-map.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-dom-nav-emit-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const { performAction } = await import('../dist/index.js');
const { endDrive } = await import('../dist/end-drive/orchestrator.js');
const { pool } = await import('../dist/runtime-state.js');
const { readUrlGraph, readFormsSeen } = await import('../dist/working-dir/logbook.js');

function makeFakeDriver() {
  let currentUrl = 'https://site.example/';
  let pendingNavs = [];
  let formsToReturn = [];
  return {
    state: {
      get currentUrl() { return currentUrl; },
      set currentUrl(v) { currentUrl = v; },
      pushPendingNav(url) { pendingNavs.push({ at: Date.now(), url }); },
      setForms(forms) { formsToReturn = forms; },
    },
    getDebuggerPauseState: () => null,
    cleanupDebuggerState: async () => {},
    getInterceptedRequests: async () => [],
    getInterceptedWebSocketFrames: async () => [],
    saveStorageState: async () => {},
    delay: async () => {},
    getUrl: async () => currentUrl,
    getAccessibilityTree: async () => '<root />',
    navigate: async (_session, url) => { currentUrl = url; },
    click: async () => ({ name: 'link' }),
    type: async () => {},
    keyPress: async () => {},
    consumePendingNavs: async () => {
      const drained = pendingNavs.slice();
      pendingNavs = [];
      return drained;
    },
    captureFormSummary: async () => formsToReturn.map((f) => ({
      at: Date.now(),
      url: currentUrl,
      action: f.action ?? `${currentUrl}submit`,
      method: f.method ?? 'POST',
      fields: f.fields ?? [],
    })),
  };
}

function patchPool(session, driver) {
  const origGet = pool.getSession;
  const origDriver = pool.driverFor;
  const origClose = pool.endDrive;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.driverFor = (id) => (id === session.id ? driver : origDriver.call(pool, id));
  pool.endDrive = async (id) => {
    if (id === session.id) return;
    return origClose.call(pool, id);
  };
  return () => {
    pool.getSession = origGet;
    pool.driverFor = origDriver;
    pool.endDrive = origClose;
  };
}

function makeSession({ id, graph = 'discover' } = {}) {
  return {
    id: id ?? ('sess-dn-' + Math.random().toString(36).slice(2, 8)),
    graph,
    platform: 'pm-emit-test',
    // One declared capability to sidestep the declaration-required detector at
    // close — these tests target dom_navigation flushing, not the close-audit.
    declaredCapabilities: [
      { capability: 'noop', args: {}, declared_at: Date.now() },
    ],
    savedCapabilities: [],
    performActionHistory: [],
    artifactAccumulator: undefined,
    endDriveAttempts: 0,
    domNavigations: [],
    domFormsObserved: [],
    extractedContentBytes: 0,
    intercepted: [],
  };
}

test('two perform_action(navigate) calls → 2 url_graph nodes + 1 edge', async () => {
  const driver = makeFakeDriver();
  // Map graph here: this test closes after navigation and asserts on
  // url_graph flushing — map's skipDeclarationGuard + skipAutoSynth keep
  // end-drive from tripping on the missing strategy save.
  const session = makeSession({ graph: 'map' });
  // Map-graph end-drive reads observed-capability inference; ensure the
  // helper works against this fake session.
  session.declaredCapabilities = [];
  const restore = patchPool(session, driver);
  try {
    await performAction(session.id, 'navigate', 'https://site.example/orders');
    await performAction(session.id, 'navigate', 'https://site.example/restaurants/r1');

    assert.equal(session.domNavigations.length, 2,
      `expected 2 dom_navigations, got ${session.domNavigations.length}: ${JSON.stringify(session.domNavigations)}`);

    const result = await endDrive(session.id, { platform: session.platform });
    assert.equal(result.ok, true);

    const graph = readUrlGraph(session.platform);
    assert.equal(graph.nodes.length, 2,
      `expected 2 url_graph nodes, got ${graph.nodes.length}`);
    assert.equal(graph.edges.length, 1,
      `expected 1 edge, got ${graph.edges.length}`);
    assert.equal(graph.edges[0].via, 'nav');
  } finally {
    restore();
  }
});

test('click that triggers SPA nav → dom_navigation tagged via:click', async () => {
  const driver = makeFakeDriver();
  const session = makeSession({ id: 'sess-click-spa' });
  const restore = patchPool(session, driver);
  try {
    // Simulate the SPA: clicking the link queues a framenavigated commit
    // that the driver's listener buffered before consumePendingNavs is called.
    driver.state.pushPendingNav('https://site.example/restaurants/r1');
    await performAction(session.id, 'click', 'a[href="/restaurants/r1"]');

    assert.equal(session.domNavigations.length, 1, 'one click-driven nav landed');
    assert.equal(session.domNavigations[0].via, 'click');
    assert.equal(session.domNavigations[0].url, 'https://site.example/restaurants/r1');
  } finally {
    restore();
  }
});

test('key_press(Enter) that triggers form-submit nav → dom_navigation tagged via:submit', async () => {
  const driver = makeFakeDriver();
  const session = makeSession({ id: 'sess-submit-spa' });
  const restore = patchPool(session, driver);
  try {
    driver.state.pushPendingNav('https://site.example/search?q=thai');
    await performAction(session.id, 'key_press', 'Enter');

    assert.equal(session.domNavigations.length, 1);
    assert.equal(session.domNavigations[0].via, 'submit');
  } finally {
    restore();
  }
});

test('captureFormSummary results land on session.domFormsObserved and flush to forms_seen', async () => {
  const driver = makeFakeDriver();
  // Map graph: closes after navigate without LIFT handoff or auto-synth.
  const session = makeSession({ id: 'sess-forms', graph: 'map' });
  session.declaredCapabilities = [];
  driver.state.setForms([
    {
      action: 'https://site.example/api/login',
      method: 'POST',
      fields: [
        { name: 'email', type: 'email', required: true },
        { name: 'password', type: 'password', required: true },
      ],
    },
  ]);
  const restore = patchPool(session, driver);
  try {
    await performAction(session.id, 'navigate', 'https://site.example/login');
    assert.ok(session.domFormsObserved.length >= 1, 'forms captured into session');

    const result = await endDrive(session.id, { platform: session.platform });
    assert.equal(result.ok, true);

    const forms = readFormsSeen(session.platform);
    assert.ok(forms.length >= 1, 'login form reached the platform logbook');
    const login = forms.find((f) => /login/.test(f.action));
    assert.ok(login, 'login form present in forms_seen');
    assert.equal(login.method, 'POST');
    const emailField = login.fields.find((x) => x.name === 'email');
    assert.ok(emailField, 'email field captured');
    assert.equal(emailField.required, true);
  } finally {
    restore();
  }
});
