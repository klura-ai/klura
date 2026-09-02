import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-dynamic-enum-suppressed-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // Best-effort test cleanup.
  }
});

const { execute } = await import('../dist/index.js');
const { defaultCapabilityCache } = await import('../dist/cache/capability-cache.js');
const { getHealth } = await import('../dist/strategies/health.js');
const { saveStrategy } = await import('../dist/strategies/skills.js');

test('suppressed dynamic-enum providers preserve cache, health, and active strategies', async () => {
  const platform = 'suppressed-dynamic-enum-provider';
  const cacheCapability = 'bootstrap_provider';
  const enumProvider = 'list_categories';
  const parentCapability = 'list_items';

  saveStrategy(platform, cacheCapability, {
    strategy: 'fetch',
    baseUrl: 'https://dynamic-enum.example',
    endpoint: '/bootstrap',
    method: 'GET',
    cache: { ttl: '1h' },
  });
  saveStrategy(platform, enumProvider, {
    strategy: 'fetch',
    baseUrl: 'https://dynamic-enum.example',
    endpoint: '/categories',
    method: 'GET',
    prerequisites: [
      {
        name: 'bootstrap',
        kind: 'capability',
        capability: cacheCapability,
        vars: {},
      },
    ],
  });
  saveStrategy(platform, parentCapability, {
    strategy: 'fetch',
    baseUrl: 'https://dynamic-enum.example',
    endpoint: '/items?category={{category}}',
    method: 'GET',
    notes: {
      params: {
        category: {
          kind: 'enum',
          source: `capability:${enumProvider}`,
        },
      },
    },
  });

  defaultCapabilityCache.clearAll();
  assert.equal(
    defaultCapabilityCache.set(
      platform,
      undefined,
      cacheCapability,
      {},
      200,
      { ok: true, source: 'ordinary-cache' },
      3_600_000,
    ),
    true,
  );
  const cacheBefore = structuredClone(
    defaultCapabilityCache.get(platform, undefined, cacheCapability, {}),
  );
  const strategyFiles = [cacheCapability, enumProvider, parentCapability].map((capability) =>
    path.join(TMP, 'skills', platform, 'fetch', `${capability}.json`),
  );
  const brokenStrategyFiles = [cacheCapability, enumProvider, parentCapability].map((capability) =>
    path.join(TMP, 'skills', platform, 'fetch', `${capability}.broken.json`),
  );
  const strategyBytesBefore = strategyFiles.map((file) => fs.readFileSync(file));

  const originalCacheGet = defaultCapabilityCache.get;
  const originalCacheSet = defaultCapabilityCache.set;
  let cacheReads = 0;
  let cacheWrites = 0;
  defaultCapabilityCache.get = function (...args) {
    cacheReads += 1;
    return originalCacheGet.apply(this, args);
  };
  defaultCapabilityCache.set = function (...args) {
    cacheWrites += 1;
    return originalCacheSet.apply(this, args);
  };

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    calls.push(requestedUrl);
    if (requestedUrl.endsWith('/bootstrap')) {
      return new Response(JSON.stringify({ ok: true, source: 'live' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestedUrl.endsWith('/categories')) {
      return new Response(JSON.stringify({ error: 'provider_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    for (let i = 0; i < 6; i += 1) {
      const result = await execute(
        platform,
        parentCapability,
        { category: 'cached-only' },
        { _suppressStrategyState: true },
      );
      assert.equal(result.status, 0, JSON.stringify(result));
    }

    assert.equal(cacheReads, 0);
    assert.equal(cacheWrites, 0);
    const suppressedBootstrapCalls = calls.filter((url) => url.endsWith('/bootstrap')).length;
    const suppressedProviderCalls = calls.filter((url) => url.endsWith('/categories')).length;
    assert.equal(suppressedBootstrapCalls, suppressedProviderCalls, JSON.stringify(calls));
    assert.ok(suppressedProviderCalls > 0, JSON.stringify(calls));
    assert.equal(calls.filter((url) => url.includes('/items?')).length, 0);
    assert.deepEqual(getHealth(platform, enumProvider, 'fetch'), {
      status: 'healthy',
      failureCount: 0,
    });
    assert.deepEqual(getHealth(platform, cacheCapability, 'fetch'), {
      status: 'healthy',
      failureCount: 0,
    });
    for (const [index, file] of strategyFiles.entries()) {
      assert.equal(fs.existsSync(file), true);
      assert.deepEqual(fs.readFileSync(file), strategyBytesBefore[index]);
      assert.equal(fs.existsSync(brokenStrategyFiles[index]), false);
    }
    assert.equal(
      fs.existsSync(path.join(TMP, 'skills', platform, 'scripts', `${enumProvider}.json`)),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(TMP, 'skills', platform, 'fetch', `${enumProvider}.broken.json`)),
      false,
    );
    assert.equal(defaultCapabilityCache.size, 1);

    const ordinaryPlatform = 'ordinary-dynamic-enum-provider';
    const ordinaryOrigin = 'https://ordinary-dynamic-enum.example';
    saveStrategy(ordinaryPlatform, cacheCapability, {
      strategy: 'fetch',
      baseUrl: ordinaryOrigin,
      endpoint: '/bootstrap',
      method: 'GET',
      cache: { ttl: '1h' },
    });
    saveStrategy(ordinaryPlatform, enumProvider, {
      strategy: 'fetch',
      baseUrl: ordinaryOrigin,
      endpoint: '/categories',
      method: 'GET',
      prerequisites: [
        {
          name: 'bootstrap',
          kind: 'capability',
          capability: cacheCapability,
          vars: {},
        },
      ],
    });
    saveStrategy(ordinaryPlatform, parentCapability, {
      strategy: 'fetch',
      baseUrl: ordinaryOrigin,
      endpoint: '/items?category={{category}}',
      method: 'GET',
      notes: {
        params: {
          category: {
            kind: 'enum',
            source: `capability:${enumProvider}`,
          },
        },
      },
    });
    assert.equal(
      originalCacheSet.call(
        defaultCapabilityCache,
        ordinaryPlatform,
        undefined,
        cacheCapability,
        {},
        200,
        { ok: true, source: 'ordinary-cache' },
        3_600_000,
      ),
      true,
    );

    cacheReads = 0;
    cacheWrites = 0;
    calls.length = 0;
    for (let i = 0; i < 5; i += 1) {
      const result = await execute(ordinaryPlatform, parentCapability, {
        category: 'cached-only',
      });
      assert.equal(result.status, 0, JSON.stringify(result));
    }
    assert.equal(cacheReads, 5);
    assert.equal(cacheWrites, 0);
    assert.equal(calls.filter((url) => url.endsWith('/bootstrap')).length, 0);
    assert.equal(calls.filter((url) => url.endsWith('/categories')).length, 5);
    const ordinaryHealth = getHealth(ordinaryPlatform, enumProvider, 'fetch');
    assert.equal(ordinaryHealth.status, 'broken');
    assert.equal(ordinaryHealth.failureCount, 5);
    assert.equal(ordinaryHealth.lastError, 'HTTP 503');
    assert.deepEqual(ordinaryHealth.recent, [false, false, false, false, false]);
    const ordinaryActive = path.join(
      TMP,
      'skills',
      ordinaryPlatform,
      'fetch',
      `${enumProvider}.json`,
    );
    const ordinaryBroken = path.join(
      TMP,
      'skills',
      ordinaryPlatform,
      'fetch',
      `${enumProvider}.broken.json`,
    );
    assert.equal(fs.existsSync(ordinaryActive), false);
    assert.equal(fs.existsSync(ordinaryBroken), true);
  } finally {
    globalThis.fetch = originalFetch;
    defaultCapabilityCache.get = originalCacheGet;
    defaultCapabilityCache.set = originalCacheSet;
    assert.deepEqual(
      defaultCapabilityCache.get(platform, undefined, cacheCapability, {}),
      cacheBefore,
    );
    defaultCapabilityCache.clearAll();
  }
});

test('suppressed dynamic-enum auth recovery does not evict provider prerequisite cache', async () => {
  const platform = 'suppressed-dynamic-enum-auth-cache';
  const cacheCapability = 'bootstrap_auth';
  const enumProvider = 'list_categories';

  saveStrategy(platform, cacheCapability, {
    strategy: 'fetch',
    baseUrl: 'https://dynamic-enum-auth.example',
    endpoint: '/bootstrap',
    method: 'GET',
    cache: { ttl: '1h' },
    provides: ['auth'],
  });
  saveStrategy(platform, enumProvider, {
    strategy: 'fetch',
    baseUrl: 'https://dynamic-enum-auth.example',
    endpoint: '/categories',
    method: 'GET',
    prerequisites: [
      {
        name: 'auth',
        kind: 'capability',
        capability: cacheCapability,
        vars: {},
      },
    ],
  });
  saveStrategy(platform, 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://dynamic-enum-auth.example',
    endpoint: '/items?category={{category}}',
    method: 'GET',
    notes: {
      params: {
        category: {
          kind: 'enum',
          source: `capability:${enumProvider}`,
        },
      },
    },
  });

  defaultCapabilityCache.clearAll();
  assert.equal(
    defaultCapabilityCache.set(
      platform,
      undefined,
      cacheCapability,
      {},
      200,
      { ok: true, source: 'cached-auth' },
      3_600_000,
    ),
    true,
  );
  const cacheBefore = structuredClone(
    defaultCapabilityCache.get(platform, undefined, cacheCapability, {}),
  );
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    calls.push(requestedUrl);
    if (requestedUrl.endsWith('/bootstrap')) {
      return new Response(JSON.stringify({ ok: true, source: 'live-auth' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await execute(
      platform,
      'list_items',
      { category: 'cached-only' },
      { _suppressStrategyState: true },
    );
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.ok(
      calls.some((url) => url.endsWith('/bootstrap')),
      JSON.stringify(calls),
    );
    assert.ok(
      calls.some((url) => url.endsWith('/categories')),
      JSON.stringify(calls),
    );
    assert.deepEqual(
      defaultCapabilityCache.get(platform, undefined, cacheCapability, {}),
      cacheBefore,
    );
    assert.deepEqual(getHealth(platform, enumProvider, 'fetch'), {
      status: 'healthy',
      failureCount: 0,
    });
    assert.equal(
      fs.existsSync(path.join(TMP, 'skills', platform, 'fetch', `${enumProvider}.json`)),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(TMP, 'skills', platform, 'fetch', `${enumProvider}.broken.json`)),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    defaultCapabilityCache.clearAll();
  }
});
