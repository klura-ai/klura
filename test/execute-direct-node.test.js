// Unit tests for the Node-transport fetch path (executeDirectNode +
// fireRequestFromNode). These run with no browser, no pool, no daemon —
// just execute() with a seeded skills dir and a mocked global `fetch`.
//
// What they cover:
//   - Default transport is 'node' when saved strategy omits the field
//   - Strategy headers win over device-profile fallbacks
//   - Device-profile userAgent + Accept-Language + synthesized client hints
//     are applied when strategy headers don't supply them
//   - Cookies from ~/.klura/storage-state/<platform>.json are joined into a
//     Cookie header filtered by hostname + path + expiry + scheme
//   - Set-Cookie from the response is merged back into the storage-state jar
//   - transport: 'browser' bypasses the Node path entirely and requires a
//     pool (verified by asserting no pool is needed for the Node path)
//   - Validator rejects invalid transport enum values at save time

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-exec-node-test-'));
process.env.KLURA_HOME = TMP;

const klura = await import('../dist/index.js');
const skillsMod = await import('../dist/strategies/skills.js');
const runtimeState = await import('../dist/runtime-state/index.js');
const { execute, setDeviceProfile } = klura;
// Use the low-level skills.saveStrategy (synchronous) to skip the probe —
// these tests are unit-level and don't want the save-time browser probe
// wandering off to fetch external URLs. We also declare params in notes
// so the placeholder validator passes.
const saveStrategy = skillsMod.saveStrategy;

test.after(async () => {
  restoreFetch();
  await runtimeState.pool.shutdown();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// --- fetch mock plumbing ---
//
// All tests install a mock fetch before calling execute() and read back the
// captured call args. Resets between tests so each test is isolated.

const realFetch = globalThis.fetch;
let fetchCalls = [];
let nextResponse = null;

function installMockFetch() {
  fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: { ...(init.headers ?? {}) },
      body: init.body,
      redirect: init.redirect,
    });
    if (!nextResponse) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const r = nextResponse;
    nextResponse = null;
    return r;
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
  nextResponse = null;
  fetchCalls = [];
}

function seedStrategy(platform, capability, overrides = {}) {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.example.com',
    endpoint: '/search?q={{query}}',
    headers: {},
    notes: {
      params: {
        query: { description: 'search string', kind: 'text', example: 'hello' },
      },
    },
    ...overrides,
  };
  saveStrategy(platform, capability, strategy);
}

test('executeDirectNode fires with default transport=node, no browser, correct URL+method', async () => {
  installMockFetch();
  try {
    seedStrategy('exnode1', 'search', { endpoint: '/search?q={{query}}' });
    const result = await execute('exnode1', 'search', { query: 'hello' });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.transport, 'node');
    assert.strictEqual(result.tier, 'fetch');
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].url, 'https://api.example.com/search?q=hello');
    assert.strictEqual(fetchCalls[0].method, 'GET');
  } finally {
    restoreFetch();
  }
});

test('device-profile User-Agent + Accept-Language applied when strategy headers are empty', async () => {
  setDeviceProfile({
    name: 'test-desktop',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    hasTouch: false,
    isMobile: false,
    acceptLanguage: 'en-US,en;q=0.9',
  });
  installMockFetch();
  try {
    seedStrategy('exnode2', 'search');
    await execute('exnode2', 'search', { query: 'x' });
    assert.strictEqual(fetchCalls.length, 1);
    const h = fetchCalls[0].headers;
    assert.ok(h['User-Agent']?.includes('Chrome/122.0.0.0'));
    assert.strictEqual(h['Accept-Language'], 'en-US,en;q=0.9');
    // Synthesized client hints should appear from the Chrome/122 UA.
    assert.ok(h['sec-ch-ua']?.includes('Chromium";v="122"'));
    assert.strictEqual(h['sec-ch-ua-mobile'], '?0');
    assert.strictEqual(h['sec-ch-ua-platform'], '"macOS"');
  } finally {
    restoreFetch();
  }
});

test('strategy-captured headers win over device-profile fallbacks', async () => {
  setDeviceProfile({
    name: 'test-desktop',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    hasTouch: false,
    isMobile: false,
  });
  installMockFetch();
  try {
    seedStrategy('exnode3', 'search', {
      headers: {
        'User-Agent': 'KluraFieldReportBot/1.0',
        'Accept-Language': 'sv-SE,sv;q=0.9',
        'sec-ch-ua': '"CapturedBrand";v="99"',
        Authorization: 'Bearer testtoken',
      },
    });
    await execute('exnode3', 'search', { query: 'x' });
    const h = fetchCalls[0].headers;
    assert.strictEqual(h['User-Agent'], 'KluraFieldReportBot/1.0');
    assert.strictEqual(h['Accept-Language'], 'sv-SE,sv;q=0.9');
    assert.strictEqual(h['sec-ch-ua'], '"CapturedBrand";v="99"');
    assert.strictEqual(h['Authorization'], 'Bearer testtoken');
  } finally {
    restoreFetch();
  }
});

test('cookies from storage-state are joined into a Cookie header filtered by host/path', async () => {
  const platform = 'exnode4';
  // Manually seed a storage-state file.
  const storageDir = path.join(TMP, 'skills', platform, 'storage-state');
  // The helper writes into ~/.klura/storage-state/<platform>.json — not per
  // skill. Let's confirm the actual path by reading through the module.
  const skills = await import('../dist/strategies/skills.js');
  const stateFile = skills.storageStatePath(platform);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      cookies: [
        // matches: same domain, root path, not expired
        {
          name: 'session',
          value: 'abc123',
          domain: 'api.example.com',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3600,
          secure: true,
        },
        // matches: suffix-domain match, secure OK on https
        {
          name: 'brand',
          value: 'klura',
          domain: '.example.com',
          path: '/',
          secure: true,
        },
        // filtered: different domain
        {
          name: 'other',
          value: 'nope',
          domain: 'other.com',
          path: '/',
        },
        // filtered: expired
        {
          name: 'stale',
          value: 'gone',
          domain: 'api.example.com',
          path: '/',
          expires: Math.floor(Date.now() / 1000) - 3600,
        },
      ],
      origins: [],
    }),
  );

  installMockFetch();
  try {
    seedStrategy(platform, 'search');
    await execute(platform, 'search', { query: 'x' });
    const h = fetchCalls[0].headers;
    assert.ok(h['Cookie'], 'Cookie header must be set');
    assert.ok(h['Cookie'].includes('session=abc123'));
    assert.ok(h['Cookie'].includes('brand=klura'));
    assert.ok(!h['Cookie'].includes('other=nope'));
    assert.ok(!h['Cookie'].includes('stale=gone'));
  } finally {
    restoreFetch();
  }
});

test('Set-Cookie from response is merged back into storage state', async () => {
  const platform = 'exnode5';
  const skills = await import('../dist/strategies/skills.js');
  const stateFile = skills.storageStatePath(platform);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }));

  installMockFetch();
  nextResponse = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: [
      ['Content-Type', 'application/json'],
      ['Set-Cookie', 'rotated=v2; Path=/; Secure'],
    ],
  });
  try {
    seedStrategy(platform, 'search');
    await execute(platform, 'search', { query: 'x' });
  } finally {
    restoreFetch();
  }

  const merged = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  assert.ok(Array.isArray(merged.cookies));
  const found = merged.cookies.find((c) => c.name === 'rotated');
  assert.ok(found, 'rotated cookie must be merged into storage-state');
  assert.strictEqual(found.value, 'v2');
  assert.strictEqual(found.domain, 'api.example.com');
  assert.strictEqual(found.path, '/');
  assert.strictEqual(found.secure, true);
});

test('non-GET serialized body Content-Type defaults to JSON unless strategy overrides', async () => {
  installMockFetch();
  try {
    saveStrategy('exnode6', 'post_thing', {
      strategy: 'fetch',
      method: 'POST',
      baseUrl: 'https://api.example.com',
      endpoint: '/things',
      headers: {},
      body: { title: '{{title}}' },
      notes: {
        params: { title: { description: 'title', kind: 'text', example: 'hi' } },
      },
    });
    await execute('exnode6', 'post_thing', { title: 'hi' });
    const call = fetchCalls[0];
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.headers['Content-Type'], 'application/json');
    assert.strictEqual(call.body, JSON.stringify({ title: 'hi' }));
  } finally {
    restoreFetch();
  }
});

test('form body serializes as urlencoded with matching Content-Type', async () => {
  installMockFetch();
  try {
    saveStrategy('exnode7', 'post_form', {
      strategy: 'fetch',
      method: 'POST',
      baseUrl: 'https://api.example.com',
      endpoint: '/submit',
      contentType: 'form',
      headers: {},
      body: { username: '{{u}}', password: '{{p}}' },
      notes: {
        params: {
          u: { description: 'user', kind: 'text', example: 'alice' },
          p: { description: 'pass', kind: 'text', example: 'pw' },
        },
      },
    });
    await execute('exnode7', 'post_form', { u: 'alice', p: 'pw' });
    const call = fetchCalls[0];
    assert.strictEqual(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const parsed = new URLSearchParams(String(call.body));
    assert.strictEqual(parsed.get('username'), 'alice');
    assert.strictEqual(parsed.get('password'), 'pw');
  } finally {
    restoreFetch();
  }
});

test('validator rejects any transport field at save time (implicit in tier)', () => {
  assert.throws(
    () =>
      saveStrategy('exnode8', 'bad', {
        strategy: 'fetch',
        baseUrl: 'https://api.example.com',
        endpoint: '/search',
        transport: 'curl',
      }),
    (err) => {
      assert.match(err.message, /transport is not allowed/);
      return true;
    },
  );
});

test('executing the page-script tier without a pool fails cleanly (Node fetch mock untouched)', async () => {
  installMockFetch();
  try {
    saveStrategy('exnode11', 'browseronly', {
      strategy: 'page-script',
      baseUrl: 'https://api.example.com',
      endpoint: '/search',
    });
    // execute() uses the daemon's pool; in this in-process test there IS
    // no real pool attached to the module-level singleton, so the
    // page-script tier should surface as an error cascade. We don't
    // assert on the exact message — only that the call doesn't
    // accidentally route through the Node path (no fetch call captured).
    await execute('exnode11', 'browseronly', {}).catch(() => {});
    assert.strictEqual(
      fetchCalls.length,
      0,
      'page-script tier must not touch the Node fetch mock',
    );
  } finally {
    restoreFetch();
  }
});
