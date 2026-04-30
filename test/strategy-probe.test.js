// Unit tests for probeStrategySelectors with recorded-path strategies,
// using a mock pool + mock driver. Verifies the probe walks steps in order,
// executes navigate/wait, verifies the first click/type/select selector
// without performing the action, and stops after the first mutating step.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.KLURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-probe-test-'));

const { probeStrategySelectors } = await import('../dist/strategies/probe/index.js');

function mockDriver({
  selectorsThatExist = new Set(),
  failNavigate = false,
  evaluateExpressionResult = undefined,
  evaluateExpressionThrows = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async navigate(_s, url) {
      calls.push({ kind: 'navigate', url });
      if (failNavigate) throw new Error('navigate failed');
    },
    async waitForSelector(_s, selector) {
      calls.push({ kind: 'waitForSelector', selector });
      if (!selectorsThatExist.has(selector)) {
        throw new Error(`selector not found: ${selector}`);
      }
    },
    async delay(_s, ms) {
      calls.push({ kind: 'delay', ms });
    },
    async click(_s, sel) {
      calls.push({ kind: 'click', sel });
      throw new Error('probe should NEVER call click');
    },
    async type(_s, sel, v) {
      calls.push({ kind: 'type', sel, v });
      throw new Error('probe should NEVER call type');
    },
    async select(_s, sel, v) {
      calls.push({ kind: 'select', sel, v });
      throw new Error('probe should NEVER call select');
    },
    async getText() {
      throw new Error('n/a');
    },
    async getAttribute() {
      throw new Error('n/a');
    },
    async getUrl() {
      return 'about:blank';
    },
    async evaluateExpression(_s, expression, options) {
      calls.push({ kind: 'evaluateExpression', expression, options });
      if (evaluateExpressionThrows) throw new Error(evaluateExpressionThrows);
      return evaluateExpressionResult;
    },
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
    async closeSession(id) {
      this.sessionsClosed++;
      sessions.delete(id);
    },
    driverFor() {
      return driver;
    },
  };
}

// ---- happy path ----

// Recorded-path save-time probe was removed — hydrated SPAs rendered loading
// stubs during the probe's 3s timeout and the sidebar selectors didn't
// resolve, yielding false-positive "hallucinated" rejections. Recorded-path
// now relies on warm-time multi-locator healing + agent patch_step on
// escalation. These tests assert the new contract: probe is a no-op for
// recorded-path saves.

test('probe is a no-op for recorded-path strategies (no driver selector calls)', async () => {
  const driver = mockDriver({ selectorsThatExist: new Set() });
  const pool = mockPool(driver);

  const data = {
    strategy: 'recorded-path',
    steps: [
      { action: 'navigate', url: 'https://example.com/login' },
      { action: 'click', selector: '#imaginary-selector' },
    ],
  };

  await probeStrategySelectors({ data, platform: 'testplat', pool });
  // No selector probing (no navigate, no waitForSelector, no click/type)
  // happens against the recorded-path steps themselves. A session may be
  // created by the outer scaffolding — what matters is the probe never
  // drove the driver through those steps.
  const kinds = driver.calls.map((c) => c.kind);
  assert.ok(!kinds.includes('navigate'));
  assert.ok(!kinds.includes('waitForSelector'));
  assert.ok(!kinds.includes('click'));
});

test('probe accepts recorded-path with structurally valid but non-resolving selectors', async () => {
  const driver = mockDriver({ selectorsThatExist: new Set() });
  const pool = mockPool(driver);

  const data = {
    strategy: 'recorded-path',
    steps: [
      { action: 'navigate', url: 'https://example.com' },
      { action: 'click', selector: '.this-resolver-is-handled-at-warm-time' },
    ],
  };

  // Does NOT reject — warm-time healing takes over.
  await probeStrategySelectors({ data, platform: 'testplat', pool });
});

test('probe is a no-op for non-recorded-path strategies without page-extract prereqs', async () => {
  const driver = mockDriver();
  const pool = mockPool(driver);

  const data = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
  };

  await probeStrategySelectors({ data, platform: 'testplat', pool });
  // No session should have been created
  assert.strictEqual(pool.sessionsCreated, 0);
});

// ---- js-eval prereq probes ----

test('probe runs a js-eval prereq and validates the declared return_shape', async () => {
  const driver = mockDriver({ evaluateExpressionResult: 'tok-of-length-24-chars-ok' });
  const pool = mockPool(driver);

  const data = {
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/submit',
    headers: { 'X-Page-Token': '{{pageToken}}' },
    body: { input: '{{text}}' },
    prerequisites: [
      {
        name: 'mintPageToken',
        kind: 'js-eval',
        url: 'https://www.example.com/new',
        expression: 'await window.__pageGuard.mintSubmitToken()',
        binds: 'pageToken',
        return_shape: { kind: 'string', min_length: 20, max_length: 4000 },
      },
    ],
  };

  await probeStrategySelectors({ data, platform: 'testplat', pool });

  const kinds = driver.calls.map((c) => c.kind);
  assert.ok(kinds.includes('navigate'), 'probe should navigate to the prereq url');
  assert.ok(kinds.includes('evaluateExpression'), 'probe should evaluate the expression');
  // (The old `data.transport = 'browser'` stamp was removed in the tier
  //  refactor — tier encodes execution environment now, no transport field.)
});

test('probe rejects js-eval when the expression throws', async () => {
  const driver = mockDriver({ evaluateExpressionThrows: 'window.__pageGuard is undefined' });
  const pool = mockPool(driver);

  const data = {
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/submit',
    prerequisites: [
      {
        name: 'mintPageToken',
        kind: 'js-eval',
        url: 'https://www.example.com/new',
        expression: 'await window.__pageGuard.mintSubmitToken()',
        binds: 'pageToken',
        return_shape: { kind: 'string', min_length: 20 },
      },
    ],
  };

  await assert.rejects(
    probeStrategySelectors({ data, platform: 'testplat', pool }),
    /js-eval.*window\.__pageGuard is undefined/s,
  );
});

test('probe rejects js-eval when the return shape does not match', async () => {
  const driver = mockDriver({ evaluateExpressionResult: 'short' });
  const pool = mockPool(driver);

  const data = {
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/submit',
    prerequisites: [
      {
        name: 'mintPageToken',
        kind: 'js-eval',
        url: 'https://www.example.com/new',
        expression: 'await window.__pageGuard.mintSubmitToken()',
        binds: 'pageToken',
        return_shape: { kind: 'string', min_length: 20 },
      },
    ],
  };

  await assert.rejects(
    probeStrategySelectors({ data, platform: 'testplat', pool }),
    /shorter than declared min_length/,
  );
});

test('probe without any selector on mutating step stops silently (locator fallback handles it)', async () => {
  const driver = mockDriver();
  const pool = mockPool(driver);

  const data = {
    strategy: 'recorded-path',
    steps: [
      { action: 'navigate', url: 'https://example.com' },
      // No selector/locators.css — only a11y/visual locators which we can't
      // probe. Should stop, not throw.
      { action: 'click' },
    ],
  };

  await probeStrategySelectors({ data, platform: 'testplat', pool });
  assert.strictEqual(pool.sessionsClosed, 1);
});
