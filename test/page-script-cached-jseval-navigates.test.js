// Regression: a page-script strategy whose only prereq is a cache-hit js-eval
// must still navigate to the strategy's origin before firing. The cache-hit
// returns without touching the page, so without an explicit origin observation
// the warm session sits on `about:blank` and the in-page fetch fails with a
// CORS-shaped `TypeError: Failed to fetch`.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-pscj-test-'));
process.env.KLURA_HOME = TMP;

const { executeFetchInBrowser } = await import('../dist/execution.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makePool({ driver, jsEvalCacheValue }) {
  const jsEvalCache = {
    get(_platform, bindsTo) {
      if (bindsTo === 'auth_token' && jsEvalCacheValue) {
        return { value: jsEvalCacheValue, expiresAt: null };
      }
      return null;
    },
    set() {},
    schedule() {},
    cancel() {},
  };
  return {
    jsEvalCache,
    async createSession() {
      return { id: 'sess-1' };
    },
    driverFor() {
      return driver;
    },
    async closeSession() {},
  };
}

function makeDriver({ initialUrl }) {
  let url = initialUrl;
  const calls = [];
  return {
    calls,
    async navigate(_session, target) {
      calls.push(['navigate', target]);
      url = target;
    },
    async getUrl() {
      return url;
    },
    async fetchInBrowser(_session, fetchUrl) {
      calls.push(['fetch', fetchUrl]);
      return { ok: true, status: 200, body: { ok: true }, finalUrl: fetchUrl };
    },
    async saveStorageState() {},
  };
}

test('page-script + cached js-eval prereq: navigates to baseUrl before fetching', async () => {
  const driver = makeDriver({ initialUrl: 'about:blank' });
  const pool = makePool({ driver, jsEvalCacheValue: 'cached-token-abc' });

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
  const fetches = driver.calls.filter((c) => c[0] === 'fetch');

  assert.equal(navigates.length, 1, 'expected exactly one navigate before fetch');
  assert.equal(navigates[0][1], 'https://api.example.com');
  assert.equal(fetches.length, 1);

  // The navigate must precede the fetch in the call order.
  const navIdx = driver.calls.findIndex((c) => c[0] === 'navigate');
  const fetchIdx = driver.calls.findIndex((c) => c[0] === 'fetch');
  assert.ok(navIdx < fetchIdx, 'navigate must happen before fetch');
});
