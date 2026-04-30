// Tests for batched prereq-probe failure aggregation.
//
// When multiple prerequisites fail the save-time probe, the runtime collects
// every failure into one rejection (canonical "N issues — fix all before
// retrying" shape) instead of throwing on the first one. Otherwise the agent
// is forced into a fix-one-retry-probe-again loop that burns save_strategy
// attempts when several prereqs are broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KLURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-probe-batch-test-'));

const { probeStrategySelectors } = await import('../dist/strategies/probe/index.js');

// Minimal mock driver whose fetchInBrowser returns whatever the test sets up,
// keyed by URL substring. Everything else is a no-op or throws to ensure the
// probe only exercises fetch-extract paths.
function mockDriver(urlToResult) {
  return {
    async navigate() {},
    async fetchInBrowser(_s, url) {
      for (const [needle, result] of urlToResult) {
        if (url.includes(needle)) return result;
      }
      return { ok: true, status: 200, body: {}, finalUrl: url };
    },
    async getText() { throw new Error('n/a'); },
    async getAttribute() { throw new Error('n/a'); },
    async waitForSelector() { throw new Error('n/a'); },
  };
}

function mockPool(driver) {
  return {
    async createSession() { return { id: 's1' }; },
    async closeSession() {},
    driverFor() { return driver; },
  };
}

function baseStrategy(prereqs) {
  return {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://example.com',
    endpoint: '/api/do',
    headers: {},
    body: { ok: 1 },
    prerequisites: prereqs,
  };
}

function fetchExtract(name, urlSuffix, varKey = 'v') {
  return {
    name,
    kind: 'fetch-extract',
    url: `https://example.com${urlSuffix}`,
    method: 'GET',
    vars: { [varKey]: 'data.id' },
    binds: varKey,
  };
}

test('batched: 3 prereqs with 2 failing — rejection lists both failures', async () => {
  const driver = mockDriver([
    ['/a', { ok: true, status: 404, body: {}, finalUrl: 'x' }],
    ['/b', { ok: true, status: 200, body: { data: { id: 'ok' } }, finalUrl: 'x' }],
    ['/c', { ok: false, error: 'network down' }],
  ]);
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({
      data: baseStrategy([
        fetchExtract('p_a', '/a'),
        fetchExtract('p_b', '/b'),
        fetchExtract('p_c', '/c'),
      ]),
      platform: 'testplat-batch-2',
      pool,
    }),
    (err) => {
      const msg = err.message;
      assert.match(msg, /2 prereq probe failures/);
      assert.match(msg, /p_a/);
      assert.match(msg, /p_c/);
      assert.ok(!/p_b/.test(msg), `p_b (passing) must not appear in rejection: ${msg}`);
      return true;
    },
  );
});

test('batched: 1 passing + 1 failing — single-failure message (no N-issues header)', async () => {
  const driver = mockDriver([
    ['/ok', { ok: true, status: 200, body: { data: { id: 'ok' } }, finalUrl: 'x' }],
    ['/bad', { ok: true, status: 500, body: {}, finalUrl: 'x' }],
  ]);
  const pool = mockPool(driver);

  await assert.rejects(
    probeStrategySelectors({
      data: baseStrategy([fetchExtract('p_ok', '/ok'), fetchExtract('p_bad', '/bad')]),
      platform: 'testplat-batch-1',
      pool,
    }),
    (err) => {
      const msg = err.message;
      assert.match(msg, /p_bad/);
      assert.ok(!/p_ok/.test(msg), `passing prereq must not appear: ${msg}`);
      // Single-failure path uses the original message directly, no batch header.
      assert.ok(!/\d+ prereq probe failures/.test(msg), `no batch header for single failure: ${msg}`);
      return true;
    },
  );
});

test('batched: all passing — probe does not throw', async () => {
  const driver = mockDriver([
    ['/x', { ok: true, status: 200, body: { data: { id: 'x' } }, finalUrl: 'x' }],
    ['/y', { ok: true, status: 200, body: { data: { id: 'y' } }, finalUrl: 'y' }],
  ]);
  const pool = mockPool(driver);
  await probeStrategySelectors({
    data: baseStrategy([fetchExtract('p_x', '/x'), fetchExtract('p_y', '/y')]),
    platform: 'testplat-batch-ok',
    pool,
  });
});
