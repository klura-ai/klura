// Unit tests for probeStrategySelectors with fetch strategies that
// declare `response.format = 'html'` and an `extract` spec. Uses a mock
// pool + mock driver that returns canned HTML bodies. No docker, no
// playwright, no real network.
//
// What this catches:
//   - A saved fetch HTML strategy whose selectors don't resolve on
//     the real page (all-empty rejection — auth wall case)
//   - A strategy where ONE selector doesn't resolve (targeted rejection)
//   - Successful probe returning without throwing when selectors match
//   - Session lifecycle: exactly one createSession/endDrive pair
//   - The probe uses the origin-first navigate pattern (not about:blank)

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.KLURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-probe-html-test-'));

const { probeStrategySelectors } = await import('../dist/strategies/probe/index.js');

function mockDriver({
  fetchStatus = 200,
  fetchBody = '<html><h1>Orders</h1><ul><li>A</li><li>B</li></ul></html>',
  fetchOk = true,
  failNavigate = false,
} = {}) {
  const calls = [];
  return {
    calls,
    async navigate(_s, url) {
      calls.push({ kind: 'navigate', url });
      if (failNavigate) throw new Error('navigate failed');
    },
    async fetchInBrowser(_s, url, opts) {
      calls.push({ kind: 'fetchInBrowser', url, opts });
      if (!fetchOk) return { ok: false, error: 'network down' };
      return { ok: true, status: fetchStatus, body: fetchBody, finalUrl: url };
    },
    // Stubs so the probe's other branches don't blow up if called.
    async getText() { throw new Error('n/a'); },
    async getAttribute() { throw new Error('n/a'); },
    async waitForSelector() { throw new Error('n/a'); },
    async click() { throw new Error('probe should NEVER call click'); },
    async type() { throw new Error('probe should NEVER call type'); },
  };
}

function mockPool(driver) {
  const sessions = new Map();
  return {
    driver,
    sessionsCreated: 0,
    sessionsClosed: 0,
    async createSession() {
      this.sessionsCreated++;
      const session = { id: `s${this.sessionsCreated}` };
      sessions.set(session.id, session);
      return session;
    },
    async endDrive(id) {
      this.sessionsClosed++;
      sessions.delete(id);
    },
    driverFor() {
      return driver;
    },
  };
}

const baseHtmlStrategy = () => ({
  strategy: 'fetch',
  method: 'GET',
  baseUrl: 'https://example.com',
  endpoint: '/orders',
  response: {
    format: 'html',
    extract: {
      title: { selector: 'h1' },
      items: { selector: 'li', multiple: true },
    },
  },
});

// ---- happy path ----

test('probe fires a GET and verifies extractors resolve', async () => {
  // Default fetchBody has <h1>Orders</h1> + two <li> items — cheerio resolves
  // title and items; probe passes.
  const driver = mockDriver();
  const pool = mockPool(driver);

  await probeStrategySelectors({ data: baseHtmlStrategy(), platform: 'testplat', pool });

  assert.strictEqual(pool.sessionsCreated, 1);
  assert.strictEqual(pool.sessionsClosed, 1);

  // Must navigate to the origin (https://example.com) before the fetch so
  // credentialed fetches have a non-opaque origin — NOT about:blank.
  const nav = driver.calls.find((c) => c.kind === 'navigate');
  assert.ok(nav, 'probe must navigate before fetching');
  assert.strictEqual(nav.url, 'https://example.com');

  const fetched = driver.calls.find((c) => c.kind === 'fetchInBrowser');
  assert.ok(fetched);
  assert.strictEqual(fetched.url, 'https://example.com/orders');
  assert.strictEqual(fetched.opts.method, 'GET');
  assert.strictEqual(fetched.opts.credentials, 'include');
});

// ---- rejection cases ----

test('probe rejects when every extractor returns empty (auth-wall case)', async () => {
  // HTML contains no <h1> and no <li> — cheerio resolves both to empty,
  // probe rejects with the all-empty signal.
  const driver = mockDriver({
    fetchBody: '<html><body><div>Please log in</div></body></html>',
  });
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({ data: baseHtmlStrategy(), platform: 'testplat', pool }),
    (err) => {
      assert.match(err.message, /every extract selector resolved to empty/);
      return true;
    },
  );
  // Session must still be cleaned up on error.
  assert.strictEqual(pool.sessionsClosed, 1);
});

test('probe rejects when a single extractor is empty and names the failing var', async () => {
  // HTML has <h1>Orders</h1> but no <li>. title resolves, items doesn't.
  const driver = mockDriver({
    fetchBody: '<html><h1>Orders</h1><p>No orders yet.</p></html>',
  });
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({ data: baseHtmlStrategy(), platform: 'testplat', pool }),
    (err) => {
      assert.match(err.message, /response\.extract\.items/);
      return true;
    },
  );
});

test('probe rejects on non-2xx status with a targeted message', async () => {
  const driver = mockDriver({ fetchStatus: 404 });
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({ data: baseHtmlStrategy(), platform: 'testplat', pool }),
    (err) => {
      assert.match(err.message, /HTTP 404/);
      return true;
    },
  );
});

test('probe rejects when fetch itself fails (network error)', async () => {
  const driver = mockDriver({ fetchOk: false });
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({ data: baseHtmlStrategy(), platform: 'testplat', pool }),
    (err) => {
      assert.match(err.message, /the GET to .* failed: network down/);
      return true;
    },
  );
});

test('probe rejects with 401 hint about auth', async () => {
  const driver = mockDriver({ fetchStatus: 401 });
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({ data: baseHtmlStrategy(), platform: 'testplat', pool }),
    (err) => {
      assert.match(err.message, /unauthenticated/);
      return true;
    },
  );
});

test('probe rejects when body is not a string (e.g. server returned a parsed JSON object)', async () => {
  const driver = mockDriver({ fetchBody: { error: 'not html' } });
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({ data: baseHtmlStrategy(), platform: 'testplat', pool }),
    (err) => {
      assert.match(err.message, /returned a body of type object/);
      return true;
    },
  );
});

// ---- short-circuit: no probe cost for JSON strategies ----

test('fetch without response field skips the HTML probe entirely', async () => {
  const driver = mockDriver();
  const pool = mockPool(driver);

  await probeStrategySelectors({
    data: {
      strategy: 'fetch',
      method: 'POST',
      baseUrl: 'https://example.com',
      endpoint: '/api/create',
    },
    platform: 'testplat',
    pool,
  });

  assert.strictEqual(pool.sessionsCreated, 0, 'no session should be created for JSON fetch');
  assert.strictEqual(driver.calls.length, 0);
});

test('fetch with response.format=json skips the HTML probe', async () => {
  const driver = mockDriver();
  const pool = mockPool(driver);

  await probeStrategySelectors({
    data: {
      strategy: 'fetch',
      method: 'GET',
      baseUrl: 'https://example.com',
      endpoint: '/orders.json',
      response: { format: 'json' },
    },
    platform: 'testplat',
    pool,
  });

  assert.strictEqual(pool.sessionsCreated, 0);
});

// ---- URL template resolution ----

test('probe resolves {{template}} placeholders from notes.params.example', async () => {
  const driver = mockDriver({
    fetchBody: '<html><h1>User Orders</h1><ul><li>X</li></ul></html>',
  });
  const pool = mockPool(driver);

  await probeStrategySelectors({
    data: {
      strategy: 'fetch',
      method: 'GET',
      baseUrl: 'https://example.com',
      endpoint: '/users/{{userId}}/orders',
      notes: { params: { userId: { description: 'user id', example: 'alice' } } },
      response: {
        format: 'html',
        extract: {
          title: { selector: 'h1' },
          items: { selector: 'li', multiple: true },
        },
      },
    },
    platform: 'testplat',
    pool,
  });

  const fetched = driver.calls.find((c) => c.kind === 'fetchInBrowser');
  assert.strictEqual(fetched.url, 'https://example.com/users/alice/orders');
});

test('probe rejects when a template placeholder has no example', async () => {
  const driver = mockDriver();
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({
      data: {
        strategy: 'fetch',
        method: 'GET',
        baseUrl: 'https://example.com',
        endpoint: '/users/{{userId}}/orders',
        response: {
          format: 'html',
          extract: { title: { selector: 'h1' } },
        },
      },
      platform: 'testplat',
      pool,
    }),
    (err) => {
      assert.match(err.message, /\{\{userId\}\}/);
      assert.match(err.message, /notes\.params\.userId\.example/);
      return true;
    },
  );
});
