// xhr-noise.collectUnsavedHotXhrEndpoints — sub-bug coverage for the iter-3
// cross-session-saved-strategy-blindness pattern: (1) load platform-wide
// strategies, not just session, (2) strip query string before regex match,
// (3) inspect prerequisites[*].url + js-eval expressions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-xhr-noise-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { collectUnsavedHotXhrEndpoints } = await import('../dist/audit/drive/xhr-noise.js');
const skills = await import('../dist/strategies/skills.js');
const { appendAckedNoiseEndpoints } = await import('../dist/working-dir/logbook.js');

function writeStrategy(platform, capability, subdir, body) {
  const dir = path.join(TMP, 'skills', platform, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${capability}.json`), JSON.stringify(body, null, 2));
}

test('sub-bug 1: prior-session strategies on disk subtract from unsaved list', () => {
  const platform = 'test-xhr-prior-session';
  // Strategy lives in skills/<platform>/fetch/, simulating a save from
  // a previous session. Current session.savedCapabilities is empty.
  writeStrategy(platform, 'list_items', 'fetch', {
    strategy: 'fetch',
    endpoint: '/api/v2/items',
    method: 'GET',
  });
  skills.invalidatePlatformCache?.(platform);
  const intercepted = [
    {
      method: 'GET',
      url: `https://example.com/api/v2/items`,
      status: 200,
    },
  ];
  const result = collectUnsavedHotXhrEndpoints(intercepted, [], platform);
  assert.equal(result.length, 0, `prior-session strategy must subtract; got: ${JSON.stringify(result)}`);
});

test('sub-bug 2: endpoint with query string still matches pathname-only XHR', () => {
  const platform = 'test-xhr-query-strip';
  writeStrategy(platform, 'get_experiments', 'fetch', {
    strategy: 'fetch',
    endpoint: '/baymax/v2/experiments?content=true&appId=lowes',
    method: 'GET',
  });
  skills.invalidatePlatformCache?.(platform);
  // Captured request has the same path; browser may send different query
  // params or none at all.
  const intercepted = [
    {
      method: 'GET',
      url: 'https://example.com/baymax/v2/experiments',
      status: 200,
    },
  ];
  const result = collectUnsavedHotXhrEndpoints(intercepted, [], platform);
  assert.equal(result.length, 0, `query-bearing template must match path-only XHR; got: ${JSON.stringify(result)}`);
});

test('sub-bug 3a: prerequisite URLs are subtracted', () => {
  const platform = 'test-xhr-prereq';
  writeStrategy(platform, 'list_orders', 'fetch', {
    strategy: 'fetch',
    endpoint: '/api/orders',
    method: 'GET',
    prerequisites: [
      { kind: 'fetch', url: '/api/session/refresh', method: 'POST' },
    ],
  });
  skills.invalidatePlatformCache?.(platform);
  const intercepted = [
    { method: 'POST', url: 'https://example.com/api/session/refresh', status: 200 },
    { method: 'GET', url: 'https://example.com/api/orders', status: 200 },
  ];
  const result = collectUnsavedHotXhrEndpoints(intercepted, [], platform);
  assert.equal(result.length, 0, `prereq URL must subtract; got: ${JSON.stringify(result)}`);
});

test('sub-bug 3b: quoted URLs inside js-eval expressions are subtracted', () => {
  const platform = 'test-xhr-jseval';
  writeStrategy(platform, 'get_navigation', 'scripts', {
    strategy: 'page-script',
    frameFromPage: {
      expression: 'return fetch("/content/navigation.html").then(r => r.text())',
    },
  });
  skills.invalidatePlatformCache?.(platform);
  const intercepted = [
    {
      method: 'GET',
      url: 'https://example.com/content/navigation.html',
      status: 200,
    },
  ];
  const result = collectUnsavedHotXhrEndpoints(intercepted, [], platform);
  assert.equal(result.length, 0, `URL inside fetch() expression must subtract; got: ${JSON.stringify(result)}`);
});

test('sub-bug 3c: quoted URLs inside a js-eval PREREQ expression are subtracted', () => {
  const platform = 'test-xhr-jseval-prereq';
  writeStrategy(platform, 'send_message', 'scripts', {
    strategy: 'page-script',
    endpoint: '/api/send',
    method: 'POST',
    prerequisites: [
      {
        name: 'prime',
        kind: 'js-eval',
        url: 'https://example.com/',
        expression: 'await fetch("/sch/i.html"); return window.__nonce',
        binds: 'nonce',
      },
    ],
  });
  skills.invalidatePlatformCache?.(platform);
  const intercepted = [
    { method: 'GET', url: 'https://example.com/sch/i.html', status: 200 },
    { method: 'POST', url: 'https://example.com/api/send', status: 200 },
  ];
  const result = collectUnsavedHotXhrEndpoints(intercepted, [], platform);
  assert.equal(
    result.length,
    0,
    `URL inside a js-eval prereq expression must subtract; got: ${JSON.stringify(result)}`,
  );
});

test('#5A: acked noise endpoints persist per platform and subtract next session', () => {
  const platform = 'test-xhr-acked-noise';
  writeStrategy(platform, 'list_orders', 'fetch', {
    strategy: 'fetch',
    endpoint: '/api/orders',
    method: 'GET',
  });
  skills.invalidatePlatformCache?.(platform);
  const intercepted = [
    { method: 'GET', url: 'https://example.com/vendor/sensor-collect.json', status: 200 },
    { method: 'GET', url: 'https://example.com/api/orders', status: 200 },
  ];
  // Session 1: the sensor path is not a saved strategy and slips the tracking
  // filter, so it surfaces as unsaved.
  const before = collectUnsavedHotXhrEndpoints(intercepted, [], platform);
  assert.deepEqual(before.map((r) => r.urlPath), ['/vendor/sensor-collect.json']);

  // Agent acks it as noise → persisted.
  appendAckedNoiseEndpoints(platform, ['/vendor/sensor-collect.json']);

  // Session 2: same noise no longer surfaces.
  const after = collectUnsavedHotXhrEndpoints(intercepted, [], platform);
  assert.equal(after.length, 0, `acked noise must not re-surface; got: ${JSON.stringify(after)}`);

  // A genuinely-new path still surfaces despite the persisted ack.
  const withNew = collectUnsavedHotXhrEndpoints(
    [...intercepted, { method: 'GET', url: 'https://example.com/api/refunds', status: 200 }],
    [],
    platform,
  );
  assert.deepEqual(withNew.map((r) => r.urlPath), ['/api/refunds']);
});

test('genuinely-unsaved XHR still surfaces', () => {
  const platform = 'test-xhr-surfacer';
  writeStrategy(platform, 'list_orders', 'fetch', {
    strategy: 'fetch',
    endpoint: '/api/orders',
    method: 'GET',
  });
  skills.invalidatePlatformCache?.(platform);
  const intercepted = [
    { method: 'GET', url: 'https://example.com/api/products/search', status: 200 },
    { method: 'GET', url: 'https://example.com/api/orders', status: 200 },
  ];
  const result = collectUnsavedHotXhrEndpoints(intercepted, [], platform);
  const paths = result.map((r) => r.urlPath);
  assert.deepEqual(paths, ['/api/products/search']);
});
