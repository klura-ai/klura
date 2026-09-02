// Save-time js-eval probes must exercise caller-dependent read expressions
// with the same grounded inputs the discovery session used. Missing values get
// a benign stand-in, and credential-shaped values never enter the probe page.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-js-eval-probe-args-'));
process.env.KLURA_HOME = TMP;
test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const { probeStrategySelectors } = await import('../dist/strategies/probe/index.js');

function makeHarness() {
  const calls = [];
  const driver = {
    async getUrl() {
      return 'about:blank';
    },
    async navigate(_session, url) {
      calls.push({ kind: 'navigate', url });
    },
    async evaluateExpression(_session, expression, options) {
      calls.push({ kind: 'evaluateExpression', expression, options });
      if (options.args?.query !== 'coffee+shops') {
        throw new Error('search_feed_missing');
      }
      return { items: [{ place_id: 'place-1' }], page: 1, next_page: 2 };
    },
  };
  const pool = {
    async createSession() {
      return { id: 'probe-session' };
    },
    async endDrive() {},
    driverFor() {
      return driver;
    },
  };
  return { calls, pool };
}

function strategy() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.test',
    endpoint: '/unused',
    method: 'GET',
    prerequisites: [
      {
        name: 'search_result',
        kind: 'js-eval',
        url: 'https://example.test/maps/search/{{query}}',
        expression: 'window.readSearchFeed(args)',
        binds: 'search_result',
        args_template: {
          query: '{{query}}',
          location: '{{location}}',
          page_size: '{{page_size}}',
          request_url: 'https://example.test/search?q={{query}}&near={{location}}',
          password: '{{password}}',
          nested: { api_key: '{{api_key}}' },
          static_mode: 'places',
        },
        return_shape: {
          kind: 'object',
          required_keys: ['items', 'page', 'next_page'],
        },
      },
    ],
    response: { from: 'search_result', format: 'json' },
    notes: {
      params: {
        query: { kind: 'text', example: 'stale-notes-query' },
        location: { kind: 'text', example: 'Stockholm' },
      },
    },
  };
}

test('js-eval probe uses declared args, notes examples, and safe stand-ins per field', async () => {
  const { calls, pool } = makeHarness();
  const password = 'user-password-must-not-leak';
  const apiKey = 'user-api-key-must-not-leak';

  await probeStrategySelectors({
    data: strategy(),
    platform: 'probe-grounded-args',
    pool,
    declaredArgs: {
      query: 'coffee+shops',
      password,
      api_key: apiKey,
    },
  });

  const navigation = calls.find((call) => call.kind === 'navigate');
  assert.equal(navigation?.url, 'https://example.test/maps/search/coffee+shops');

  const evaluation = calls.find(
    (call) =>
      call.kind === 'evaluateExpression' && call.expression === 'window.readSearchFeed(args)',
  );
  assert.deepEqual(evaluation?.options.args, {
    query: 'coffee+shops',
    location: 'Stockholm',
    page_size: '__klura_probe_stub__',
    request_url: 'https://example.test/search?q=coffee+shops&near=Stockholm',
    password: '__klura_probe_stub__',
    nested: { api_key: '__klura_probe_stub__' },
    static_mode: 'places',
  });

  const trace = JSON.stringify(calls);
  assert.ok(!trace.includes(password), 'raw password must never enter the probe driver');
  assert.ok(!trace.includes(apiKey), 'raw API key must never enter the probe driver');
  assert.ok(!trace.includes('stale-notes-query'), 'live declared args must win over notes examples');
});
