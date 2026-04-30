import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-browser-prereq-test-'));
process.env.KLURA_HOME = TMP;

const { runPrerequisites } = await import('../dist/execution.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('browser prereq steps interpolate url/selector/value before driving the page', async () => {
  const calls = [];
  const driver = {
    async navigate(_session, url) {
      calls.push(['navigate', url]);
    },
    async click(_session, selector) {
      calls.push(['click', selector]);
    },
    async type(_session, selector, value) {
      calls.push(['type', selector, value]);
    },
    async getText(_session, selector) {
      calls.push(['getText', selector]);
      return 'done';
    },
    async delay() {},
  };

  const pool = {
    async createSession() {
      return { id: 'sess-1' };
    },
    driverFor() {
      return driver;
    },
    async closeSession() {},
  };

  const result = await runPrerequisites({
    strategy: {
      baseUrl: 'https://example.com',
      prerequisites: [
        {
          name: 'open_thread',
          kind: 'browser',
          steps: [
            { action: 'navigate', url: 'https://example.com/thread/{{thread_id}}' },
            { action: 'click', selector: '[data-thread="{{thread_id}}"]' },
            { action: 'type', selector: '#composer-{{thread_id}}', value: '{{text}}' },
            { action: 'extract', selector: '#status-{{thread_id}}', as: 'status' },
          ],
        },
      ],
    },
    args: {
      thread_id: '42',
      text: 'hello',
    },
    platform: 'example',
    pool,
    tokenCache: null,
  });

  assert.deepStrictEqual(calls, [
    ['navigate', 'https://example.com/thread/42'],
    ['click', '[data-thread="42"]'],
    ['type', '#composer-42', 'hello'],
    ['getText', '#status-42'],
  ]);
  assert.deepStrictEqual(result.tokens, { status: 'done' });
});

test('cache-hit js-eval prereq returns cached value without driving the page', async () => {
  // Locks in the cache + page-state interaction the warm-execute path relies
  // on: a cached js-eval prereq must NOT navigate or evaluate; it just binds
  // the cached value to the token table. The executor's downstream
  // origin-observation logic then decides whether a navigate is still needed
  // before the main fetch fires.
  const calls = [];
  const driver = {
    async navigate(_session, url) {
      calls.push(['navigate', url]);
    },
    async getUrl() {
      return 'about:blank';
    },
    async evaluate() {
      calls.push(['evaluate']);
      return null;
    },
    async delay() {},
  };

  const jsEvalCache = {
    get(_platform, bindsTo) {
      if (bindsTo === 'auth_token') {
        return { value: 'cached-token-xyz', expiresAt: null };
      }
      return null;
    },
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

  const result = await runPrerequisites({
    strategy: {
      baseUrl: 'https://example.com',
      prerequisites: [
        {
          name: 'auth_token',
          kind: 'js-eval',
          url: 'https://example.com/login',
          expression: 'window.__token',
          return_shape: { type: 'string' },
        },
      ],
    },
    args: {},
    platform: 'example',
    pool,
    tokenCache: null,
  });

  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(result.tokens, { auth_token: 'cached-token-xyz' });
});
