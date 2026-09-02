import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-response-from-fresh-test-'));
process.env.KLURA_HOME = TMP;
fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    traffic: {
      max_concurrency: 1,
      requests_per_second: 5,
      burst: 4,
      min_delay_ms: 0,
    },
  }),
);

const { executeFetchInBrowser } = await import('../dist/execution/index.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('response.from evaluates its js-eval binding fresh for every caller URL', async () => {
  const pageUrls = new Map();
  const navigations = [];
  const evaluations = [];
  const cacheCalls = [];
  const warmSession = { id: 'warm-session' };
  pageUrls.set(warmSession.id, 'https://example.com/entities/view?id=stale');

  const driver = {
    async getUrl(session) {
      return pageUrls.get(session.id) ?? 'about:blank';
    },
    async navigate(session, url) {
      pageUrls.set(session.id, url);
      navigations.push(url);
    },
    async evaluateExpression(session, expression, options) {
      evaluations.push({ url: pageUrls.get(session.id), expression, options });
      return JSON.stringify({ entity_url: pageUrls.get(session.id) });
    },
    async probePageReady() {
      return { page_on_url: true };
    },
    async saveStorageState() {},
  };
  const pool = {
    jsEvalCache: {
      get() {
        cacheCalls.push('get');
        return {
          value: JSON.stringify({ entity_url: 'https://example.com/entities/stale' }),
          expiresAt: null,
        };
      },
      set() {
        cacheCalls.push('set');
      },
      schedule() {
        cacheCalls.push('schedule');
      },
      cancel() {},
    },
    async tryCheckoutReadySession(_platform, probe) {
      assert.equal(await probe(warmSession, driver), true);
      return warmSession;
    },
    async createSession() {
      throw new Error('the warm session should be reused');
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  };
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://example.com',
    prerequisites: [
      {
        name: 'entity_result',
        kind: 'js-eval',
        url: '{{entity_url}}',
        expression: 'JSON.stringify({ entity_url: location.href })',
        binds: 'entity_result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'entity_result', format: 'json' },
  };

  const firstUrl = 'https://example.com/entities/view?id=first';
  const secondUrl = 'https://example.com/entities/view?id=second';
  const first = await executeFetchInBrowser(
    strategy,
    { entity_url: firstUrl },
    'example',
    'get_entity',
    pool,
    null,
  );
  const second = await executeFetchInBrowser(
    strategy,
    { entity_url: secondUrl },
    'example',
    'get_entity',
    pool,
    null,
  );

  assert.deepEqual(first.body, { entity_url: firstUrl });
  assert.deepEqual(second.body, { entity_url: secondUrl });
  assert.deepEqual(navigations, [firstUrl, secondUrl]);
  assert.deepEqual(
    evaluations.map((call) => call.url),
    [firstUrl, secondUrl],
  );
  assert.deepEqual(cacheCalls, []);
});

test('response.from reuses an already-settled page at the exact caller URL', async () => {
  const entityUrl = 'https://example.com/entities/view?id=ready';
  const session = { id: 'exact-session' };
  let navigations = 0;
  const driver = {
    async getUrl() {
      return entityUrl;
    },
    async navigate() {
      navigations += 1;
    },
    async evaluateExpression(_session, expression) {
      if (expression === 'document.readyState') return 'complete';
      return JSON.stringify({ entity_url: entityUrl });
    },
    async probePageReady() {
      return { page_on_url: true };
    },
    async saveStorageState() {},
  };
  const pool = {
    jsEvalCache: {
      get() {
        throw new Error('direct results must not read the cache');
      },
      set() {
        throw new Error('direct results must not write the cache');
      },
      schedule() {
        throw new Error('direct results must not schedule refresh');
      },
      cancel() {},
    },
    async tryCheckoutReadySession(_platform, probe) {
      assert.equal(await probe(session, driver), true);
      return session;
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  };
  const result = await executeFetchInBrowser(
    {
      strategy: 'page-script',
      baseUrl: 'https://example.com',
      prerequisites: [
        {
          name: 'entity_result',
          kind: 'js-eval',
          url: '{{entity_url}}',
          expression: 'JSON.stringify({ entity_url: location.href })',
          binds: 'entity_result',
          return_shape: { kind: 'string' },
        },
      ],
      response: { from: 'entity_result', format: 'json' },
    },
    { entity_url: entityUrl },
    'example',
    'get_entity',
    pool,
    null,
  );

  assert.deepEqual(result.body, { entity_url: entityUrl });
  assert.equal(navigations, 0);
});

test('response.from js-eval navigations share the local origin scheduler', async () => {
  let signalFirstStarted;
  let releaseFirstNavigation;
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstDriver = {
    async getUrl() {
      return 'about:blank';
    },
    async navigate() {
      signalFirstStarted();
      await new Promise((resolve) => {
        releaseFirstNavigation = resolve;
      });
    },
    async evaluateExpression() {
      return JSON.stringify({ ok: true, source: 'first' });
    },
    async saveStorageState() {},
  };
  let secondNavigations = 0;
  const secondDriver = {
    async getUrl() {
      return 'about:blank';
    },
    async navigate() {
      secondNavigations += 1;
    },
    async evaluateExpression() {
      return JSON.stringify({ ok: true, source: 'second' });
    },
    async saveStorageState() {},
  };
  const poolFor = (driver, id) => ({
    async createSession() {
      return { id };
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  });
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://scheduler.example',
    prerequisites: [
      {
        name: 'result',
        kind: 'js-eval',
        url: '{{entity_url}}',
        expression: 'JSON.stringify({ ok: true })',
        binds: 'result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'result', format: 'json' },
  };

  const first = executeFetchInBrowser(
    strategy,
    { entity_url: 'https://scheduler.example/entities/first' },
    'scheduler-example',
    'first',
    poolFor(firstDriver, 'first'),
    null,
  );
  await firstStarted;
  const second = executeFetchInBrowser(
    strategy,
    { entity_url: 'https://scheduler.example/entities/second' },
    'scheduler-example',
    'second',
    poolFor(secondDriver, 'second'),
    null,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondNavigations, 0);

  releaseFirstNavigation();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult.body, { ok: true, source: 'first' });
  assert.deepEqual(secondResult.body, { ok: true, source: 'second' });
  assert.equal(secondNavigations, 1);
});
