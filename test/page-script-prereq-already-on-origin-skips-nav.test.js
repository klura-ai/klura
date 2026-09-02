// When the session is already on the strategy's target origin (a fresh-mint
// js-eval prereq just navigated there, or a warm-pool ready-page checkout
// landed us there), the executor must NOT navigate again — re-navigating would
// invalidate any one-time nonce the page just produced.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-already-on-origin-test-'));
process.env.KLURA_HOME = TMP;

const { executeFetchInBrowser } = await import('../dist/execution/index.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('page-script: session already on target origin → zero navigates before fetch', async () => {
  const driver = (() => {
    const calls = [];
    return {
      calls,
      async navigate(_s, url) {
        calls.push(['navigate', url]);
      },
      async getUrl() {
        return 'https://api.example.com/somewhere';
      },
      async fetchInBrowser(_s, url) {
        calls.push(['fetch', url]);
        return { ok: true, status: 200, body: { ok: true }, finalUrl: url };
      },
      async saveStorageState() {},
    };
  })();

  const jsEvalCache = {
    // Cache keys are `${bindsTo} ${expression-hash}` — match by binding prefix
    // so the stub hits regardless of the expression-hash suffix.
    get: (_p, name) =>
      name.startsWith('auth_token') ? { value: 'cached', expiresAt: null } : null,
    set() {},
    schedule() {},
    cancel() {},
  };

  const pool = {
    jsEvalCache,
    async createSession() {
      return { id: 'sess-1' };
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  };

  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://api.example.com',
    endpoint: '/v1/me',
    method: 'GET',
    headers: { Authorization: 'Bearer {{auth_token}}' },
    prerequisites: [
      {
        name: 'auth_token',
        kind: 'js-eval',
        url: 'https://api.example.com/login',
        expression: 'window.__token',
        return_shape: { type: 'string' },
      },
    ],
  };

  await executeFetchInBrowser(strategy, {}, 'example', 'me', pool, null, 0);

  const navigates = driver.calls.filter((c) => c[0] === 'navigate');
  assert.equal(navigates.length, 0, 'must not navigate when already on target origin');
  const fetches = driver.calls.filter((c) => c[0] === 'fetch');
  assert.equal(fetches.length, 1);
});

test('browser fetches share the configured local origin admission queue', async () => {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ traffic: { max_concurrency: 1, burst: 1 } }),
  );
  let started;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  const firstDriver = {
    async getUrl() {
      return 'https://api.example.com/ready';
    },
    async fetchInBrowser(_session, url) {
      started();
      return await new Promise((resolve) => {
        releaseFirst = () => resolve({ ok: true, status: 200, body: { first: true }, finalUrl: url });
      });
    },
    async saveStorageState() {},
  };
  let secondFetches = 0;
  const secondDriver = {
    async getUrl() {
      return 'https://api.example.com/ready';
    },
    async fetchInBrowser(_session, url) {
      secondFetches += 1;
      return { ok: true, status: 200, body: { second: true }, finalUrl: url };
    },
    async saveStorageState() {},
  };
  const poolFor = (driver) => ({
    async createSession() {
      return { id: 'session' };
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  });
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://api.example.com',
    endpoint: '/v1/me',
    method: 'GET',
    headers: {},
  };

  const first = executeFetchInBrowser(
    strategy,
    {},
    'shared-browser-origin',
    'first',
    poolFor(firstDriver),
    null,
    0,
  );
  await firstStarted;
  const second = executeFetchInBrowser(
    strategy,
    {},
    'shared-browser-origin',
    'second',
    poolFor(secondDriver),
    null,
    0,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondFetches, 0, 'second browser fetch must remain queued');
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, 200);
  assert.equal(secondResult.status, 200);
  assert.equal(secondFetches, 1);
});

test('browser fetch surfaces a configured in-page request deadline', async () => {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ traffic: { request_timeout_ms: 1_000 } }),
  );
  let receivedTimeout = null;
  const driver = {
    async getUrl() {
      return 'https://api.example.com/ready';
    },
    async fetchInBrowser(_session, _url, options) {
      receivedTimeout = options.timeout_ms;
      return { ok: false, error: 'AbortError: aborted', timed_out: true };
    },
    async saveStorageState() {},
  };
  const pool = {
    async createSession() {
      return { id: 'timeout-session' };
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  };
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://api.example.com',
    endpoint: '/v1/me',
    method: 'GET',
    headers: {},
  };

  await assert.rejects(
    () => executeFetchInBrowser(strategy, {}, 'browser-timeout', 'me', pool, null, 0),
    /timed out after 1000ms/,
  );
  assert.equal(receivedTimeout, 1_000);
});

test('browser navigation receives the configured driver deadline', async () => {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ traffic: { request_timeout_ms: 1_000 } }),
  );
  let receivedTimeout = null;
  const driver = {
    async getUrl() {
      return 'about:blank';
    },
    async navigate(_session, _url, options) {
      receivedTimeout = options.timeout_ms;
      throw new Error('navigation stopped by driver deadline');
    },
    async fetchInBrowser() {
      throw new Error('fetch must not start after the navigation deadline');
    },
    async saveStorageState() {},
  };
  const pool = {
    async createSession() {
      return { id: 'navigation-timeout-session' };
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  };
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://api.example.com',
    endpoint: '/v1/me',
    method: 'GET',
    headers: {},
    prerequisites: [
      {
        name: 'page_token',
        kind: 'page-extract',
        url: 'https://api.example.com/token',
        vars: { page_token: { selector: '#token' } },
      },
    ],
  };

  await assert.rejects(
    () => executeFetchInBrowser(strategy, {}, 'browser-navigation-timeout', 'me', pool, null, 0),
    /navigation stopped by driver deadline/,
  );
  assert.equal(receivedTimeout, 1_000);
});
