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

const { executeFetchInBrowser } = await import('../dist/execution.js');

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
    get: (_p, name) => (name === 'auth_token' ? { value: 'cached', expiresAt: null } : null),
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
    async closeSession() {},
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
