// Runtime dispatch tests for js-eval prereqs in per-call mode (args_template)
// and frame mode. Drives runPrerequisites with a stub driver/pool and asserts
// on the args/frame that flow through driver.evaluateExpression.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-js-eval-per-call-test-'));
process.env.KLURA_HOME = TMP;

const { runPrerequisites } = await import('../dist/execution.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeDriver(returnValue = 'minted-value-of-sufficient-length-for-defaults') {
  const calls = [];
  const driver = {
    async navigate(_session, url) {
      calls.push({ kind: 'navigate', url });
    },
    async getUrl() {
      return 'about:blank';
    },
    async evaluateExpression(_session, expression, options) {
      calls.push({ kind: 'evaluateExpression', expression, options });
      return returnValue;
    },
    async delay() {},
  };
  return { driver, calls };
}

function makePool(driver, jsEvalCache = null) {
  return {
    jsEvalCache,
    async createSession() {
      return { id: 'sess-1' };
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  };
}

test('js-eval per-call mode interpolates args_template and forwards as `args`', async () => {
  // The signer expression depends on the request body, so the runtime must
  // resolve args_template against the caller scope and hand the resulting
  // object to the driver under `options.args` — never cache the result.
  const { driver, calls } = makeDriver('signed-payload-token-12345678');
  const pool = makePool(driver);

  const result = await runPrerequisites({
    strategy: {
      baseUrl: 'https://example.com',
      prerequisites: [
        {
          name: 'sig',
          kind: 'js-eval',
          url: 'https://example.com/app',
          expression: 'await window.__sign({path: args.path, body: args.body})',
          binds: 'request_signature',
          return_shape: { kind: 'string', min_length: 16 },
          args_template: { path: '/api/{{thread_id}}', body: '{{text}}' },
        },
      ],
    },
    args: { thread_id: '42', text: 'hello' },
    platform: 'example',
    pool,
    tokenCache: null,
  });

  const eval_ = calls.find((c) => c.kind === 'evaluateExpression');
  assert.ok(eval_, 'driver.evaluateExpression should have been called');
  assert.deepStrictEqual(eval_.options.args, { path: '/api/42', body: 'hello' });
  // No frame was declared, so options.frame must be absent (not just falsy) —
  // setting it inadvertently would hand the iframe-resolution path a stray
  // selector and surface a confusing rejection at runtime.
  assert.ok(!('frame' in eval_.options), 'options.frame should be absent when not declared');
  assert.deepStrictEqual(result.tokens, { request_signature: 'signed-payload-token-12345678' });
});

test('js-eval per-call mode skips cache reads and writes', async () => {
  // The cache is keyed on (platform, bindsTo) with no awareness of
  // args_template, so a hit would bind a signature minted for a different
  // body. Per-call dispatch must bypass both the read and the write.
  const cacheCalls = [];
  const jsEvalCache = {
    get(platform, bindsTo) {
      cacheCalls.push({ kind: 'get', platform, bindsTo });
      return { value: 'STALE-CACHED-SIGNATURE', expiresAt: null };
    },
    set(platform, bindsTo, value, expiresAt) {
      cacheCalls.push({ kind: 'set', platform, bindsTo, value, expiresAt });
    },
    schedule(opts) {
      cacheCalls.push({ kind: 'schedule', ...opts });
    },
    cancel() {},
  };
  const { driver } = makeDriver('fresh-signature-from-driver-eval');
  const pool = makePool(driver, jsEvalCache);

  const result = await runPrerequisites({
    strategy: {
      baseUrl: 'https://example.com',
      prerequisites: [
        {
          name: 'sig',
          kind: 'js-eval',
          url: 'https://example.com/app',
          expression: 'await window.__sign(args)',
          binds: 'sig',
          return_shape: { kind: 'string', min_length: 16 },
          args_template: { body: '{{text}}' },
        },
      ],
    },
    args: { text: 'hello' },
    platform: 'example',
    pool,
    tokenCache: null,
  });

  assert.deepStrictEqual(cacheCalls, [], 'cache must not be touched in per-call mode');
  assert.strictEqual(result.tokens.sig, 'fresh-signature-from-driver-eval');
});

test('js-eval per-call mode mints fresh on every dispatch (no cache reuse)', async () => {
  // Two consecutive runs — different args, both should hit the driver.
  let mintCount = 0;
  const driver = {
    async navigate() {},
    async getUrl() {
      return 'about:blank';
    },
    async evaluateExpression(_s, _expr, options) {
      mintCount += 1;
      return `sig-for-${options.args.body}`;
    },
    async delay() {},
  };
  const cacheCalls = [];
  const jsEvalCache = {
    get() {
      cacheCalls.push('get');
      return null;
    },
    set() {
      cacheCalls.push('set');
    },
    schedule() {
      cacheCalls.push('schedule');
    },
    cancel() {},
  };
  const pool = makePool(driver, jsEvalCache);

  const strategy = {
    baseUrl: 'https://example.com',
    prerequisites: [
      {
        name: 'sig',
        kind: 'js-eval',
        url: 'https://example.com/app',
        expression: 'await window.__sign(args)',
        binds: 'sig',
        return_shape: { kind: 'string', min_length: 1 },
        args_template: { body: '{{text}}' },
      },
    ],
  };

  const r1 = await runPrerequisites({
    strategy,
    args: { text: 'first' },
    platform: 'example',
    pool,
    tokenCache: null,
  });
  const r2 = await runPrerequisites({
    strategy,
    args: { text: 'second' },
    platform: 'example',
    pool,
    tokenCache: null,
  });

  assert.strictEqual(mintCount, 2, 'driver should be invoked once per call');
  assert.strictEqual(r1.tokens.sig, 'sig-for-first');
  assert.strictEqual(r2.tokens.sig, 'sig-for-second');
  assert.deepStrictEqual(cacheCalls, [], 'per-call mode should not consult the cache at all');
});

test('js-eval frame field is forwarded to driver.evaluateExpression', async () => {
  // The frame selector is opaque to the runtime — it routes straight through
  // to the driver, which resolves it to a Frame and dispatches the eval there.
  const { driver, calls } = makeDriver('frame-bound-token-abcdef1234567890');
  const pool = makePool(driver);

  await runPrerequisites({
    strategy: {
      baseUrl: 'https://example.com',
      prerequisites: [
        {
          name: 'cf',
          kind: 'js-eval',
          url: 'https://example.com/checkout',
          frame: 'iframe[src*="cloudflare"]',
          expression: 'await window.turnstile.execute()',
          binds: 'cf_token',
          return_shape: { kind: 'string', min_length: 16 },
        },
      ],
    },
    args: {},
    platform: 'example',
    pool,
    tokenCache: null,
  });

  const eval_ = calls.find((c) => c.kind === 'evaluateExpression');
  assert.ok(eval_);
  assert.strictEqual(eval_.options.frame, 'iframe[src*="cloudflare"]');
});

test('js-eval frame + args_template forward together for per-call iframe signers', async () => {
  // Combined per-call + iframe scenario — should plumb both fields straight
  // through. Real-world: an iframe-hosted widget whose mint function needs
  // the caller's payload as a binding.
  const { driver, calls } = makeDriver('iframe-signed-token-1234567890');
  const pool = makePool(driver);

  await runPrerequisites({
    strategy: {
      baseUrl: 'https://example.com',
      prerequisites: [
        {
          name: 'sig',
          kind: 'js-eval',
          url: 'https://example.com/app',
          frame: '#challenge-iframe',
          expression: 'await window.__signInsideFrame(args)',
          binds: 'frame_sig',
          return_shape: { kind: 'string', min_length: 16 },
          args_template: { body: '{{text}}' },
        },
      ],
    },
    args: { text: 'hello' },
    platform: 'example',
    pool,
    tokenCache: null,
  });

  const eval_ = calls.find((c) => c.kind === 'evaluateExpression');
  assert.ok(eval_);
  assert.strictEqual(eval_.options.frame, '#challenge-iframe');
  assert.deepStrictEqual(eval_.options.args, { body: 'hello' });
});

test('js-eval cacheable mode (no args_template) still uses cache + omits args/frame from driver call', async () => {
  // Backwards-compatibility check: a vanilla js-eval prereq with neither
  // args_template nor frame still hits the cache and never sets either option
  // on driver.evaluateExpression. Guards against accidental "always pass
  // {args: undefined, frame: undefined}" regression.
  const cacheStore = new Map();
  const jsEvalCache = {
    get(platform, bindsTo) {
      const e = cacheStore.get(`${platform}:${bindsTo}`);
      return e ?? null;
    },
    set(platform, bindsTo, value, expiresAt) {
      cacheStore.set(`${platform}:${bindsTo}`, { value, expiresAt });
    },
    schedule() {},
    cancel() {},
  };
  const { driver, calls } = makeDriver('cacheable-mint-of-good-length');
  const pool = makePool(driver, jsEvalCache);

  await runPrerequisites({
    strategy: {
      baseUrl: 'https://example.com',
      prerequisites: [
        {
          name: 'tok',
          kind: 'js-eval',
          url: 'https://example.com/app',
          expression: 'await window.mint()',
          binds: 'tok',
          return_shape: { kind: 'string', min_length: 16 },
        },
      ],
    },
    args: {},
    platform: 'example',
    pool,
    tokenCache: null,
  });

  const eval_ = calls.find((c) => c.kind === 'evaluateExpression');
  assert.ok(eval_);
  assert.ok(!('args' in eval_.options), 'options.args should be absent for cacheable prereqs');
  assert.ok(!('frame' in eval_.options), 'options.frame should be absent when not declared');
  // Cache should now hold the minted value.
  assert.strictEqual(cacheStore.get('example:tok')?.value, 'cacheable-mint-of-good-length');
});
