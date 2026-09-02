import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-post-save-fresh-context-'));
process.env.KLURA_HOME = TMP;

const skills = await import('../dist/strategies/skills.js');
const { verifySavedStrategy, verifyStrategyCandidate } =
  await import('../dist/strategies/verify-saved-strategy.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function pageScriptStrategy() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.test',
    prerequisites: [
      {
        name: 'result',
        kind: 'js-eval',
        url: 'https://example.test/fresh-target',
        expression: 'JSON.stringify({ ok: true, source: location.href })',
        binds: 'result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'result', format: 'json' },
  };
}

function makeContaminatedPool() {
  const discoverySession = {
    id: 'discovery-session',
    intercepted: [],
    intercepting: false,
  };
  const urls = new Map([[discoverySession.id, 'https://example.test/discovery-result']]);
  const createdOptions = [];
  const navigations = [];
  const ended = [];
  let readyCheckouts = 0;
  let cacheReads = 0;
  let nextSession = 0;

  const discoveryDriver = {
    async probePageReady() {
      return { page_on_url: true };
    },
    async getUrl(session) {
      return urls.get(session.id);
    },
    async evaluateExpression() {
      return JSON.stringify({ ok: true, source: 'discovery-state' });
    },
  };
  const freshDriver = {
    async getUrl(session) {
      return urls.get(session.id) ?? 'about:blank';
    },
    async navigate(session, url) {
      urls.set(session.id, url);
      navigations.push(url);
    },
    async evaluateExpression(session) {
      return JSON.stringify({ ok: true, source: urls.get(session.id) });
    },
  };

  const pool = {
    jsEvalCache: {
      get() {
        cacheReads += 1;
        return {
          value: JSON.stringify({ ok: true, source: 'cached-discovery-state' }),
          expiresAt: null,
        };
      },
      set() {},
      schedule() {},
      cancel() {},
    },
    async tryCheckoutReadySession(_platform, probe) {
      readyCheckouts += 1;
      assert.equal(await probe(discoverySession, discoveryDriver), true);
      return discoverySession;
    },
    async createSession(opts = {}) {
      createdOptions.push({ ...opts });
      const session = {
        id: `fresh-session-${++nextSession}`,
        intercepted: [],
        intercepting: false,
      };
      urls.set(session.id, 'about:blank');
      return session;
    },
    createNodeOnlySession() {
      throw new Error('browser verification must not create a node-only session');
    },
    async endDrive(sessionId) {
      ended.push(sessionId);
    },
    getSession(sessionId) {
      if (sessionId === discoverySession.id) return discoverySession;
      return { id: sessionId, intercepted: [], intercepting: false };
    },
    driverFor(sessionId) {
      return sessionId === discoverySession.id ? discoveryDriver : freshDriver;
    },
    async shutdown() {},
    get activeSessions() {
      return 1;
    },
    get activeSessionIds() {
      return [discoverySession.id];
    },
    get idleSince() {
      return 0;
    },
    get connectEnabled() {
      return false;
    },
  };

  return {
    pool,
    createdOptions,
    navigations,
    ended,
    get readyCheckouts() {
      return readyCheckouts;
    },
    get cacheReads() {
      return cacheReads;
    },
  };
}

function assertFreshAnonymousVerification(state, result) {
  assert.equal(result.classification, 'explicit_success');
  assert.match(result.body_preview, /"source":"https:\/\/example\.test\/fresh-target"/);
  assert.equal(state.readyCheckouts, 0, 'discovery/ready sessions must be invisible');
  assert.equal(state.cacheReads, 0, 'shared js-eval cache must be invisible');
  assert.deepEqual(state.navigations, ['https://example.test/fresh-target']);
  assert.equal(state.createdOptions.length, 1);
  assert.equal(state.createdOptions[0].freshContext, true);
  assert.equal(state.createdOptions[0].internal, true);
  assert.equal(
    Object.hasOwn(state.createdOptions[0], 'storageState'),
    false,
    'persisted discovery storage must not seed verification',
  );
  assert.deepEqual(state.ended, ['fresh-session-1']);
}

test('active page-script post-save verification uses a fresh anonymous context', async () => {
  const platform = 'fresh-active';
  const capability = 'read_entity';
  skills.commitValidatedStrategy(platform, capability, pageScriptStrategy());
  skills.saveStorageState(platform, {
    cookies: [
      {
        name: 'consent',
        value: 'accepted-during-discovery',
        domain: 'example.test',
        path: '/',
      },
    ],
    origins: [],
  });
  const state = makeContaminatedPool();

  const result = await verifySavedStrategy(platform, capability, {}, state.pool);

  assertFreshAnonymousVerification(state, result);
  assert.equal(result.ok, true);
});

test('inactive page-script candidate verification cannot inherit discovery browser state', async () => {
  const platform = 'fresh-candidate';
  const capability = 'read_entity';
  skills.saveStorageState(platform, {
    cookies: [
      {
        name: 'consent',
        value: 'accepted-during-discovery',
        domain: 'example.test',
        path: '/',
      },
    ],
    origins: [],
  });
  const candidate = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    pageScriptStrategy(),
  );
  const state = makeContaminatedPool();

  const result = await verifyStrategyCandidate(candidate, {}, state.pool);

  assertFreshAnonymousVerification(state, result);
  assert.equal(result.ok, true);
  assert.equal(result.active, true);
});
