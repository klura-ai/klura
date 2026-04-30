// Unit tests for the WebSocket-specific extensions of strategy-probe.ts:
//   - verifyWsUrlObserved: cross-reference wsUrl against captured frames.
//   - probeStrategySelectors with wsOpen.steps: selector probe against the
//     page DOM after navigating to baseUrl.
//   - Tier demotion from `fetch` → `page-script` for ws strategies (the
//     environment is baked into the tier name now; `transport` is gone).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KLURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-ws-probe-test-'));

const { probeStrategySelectors } = await import('../dist/strategies/probe/index.js');
const { verifyWsUrlObserved } = await import('../dist/strategies/verify-observed.js');

// --- verifyWsUrlObserved ---

test('verifyWsUrlObserved: match accepted (prefix)', () => {
  const data = {
    strategy: 'fetch',
    protocol: 'websocket',
    baseUrl: 'https://example.com',
    wsUrl: 'wss://ws.example.com/chat',
    frame: '{"x":1}',
  };
  const frames = [
    { url: 'wss://ws.example.com/chat?sid=abc&cid=1', direction: 'sent', payload: 'x', timestamp: 0 },
    { url: 'wss://ws.example.com/chat?sid=abc&cid=1', direction: 'received', payload: 'y', timestamp: 1 },
  ];
  assert.doesNotThrow(() => verifyWsUrlObserved(data, frames));
});

test('verifyWsUrlObserved: mismatch rejected', () => {
  const data = {
    strategy: 'fetch',
    protocol: 'websocket',
    baseUrl: 'https://example.com',
    wsUrl: 'wss://ws.other-site.com/chat',
    frame: '{"x":1}',
  };
  const frames = [
    { url: 'wss://ws.example.com/chat?sid=abc', direction: 'sent', payload: 'x', timestamp: 0 },
  ];
  assert.throws(
    () => verifyWsUrlObserved(data, frames),
    /was NOT observed in the discovery session's WebSocket frames/,
  );
});

test('verifyWsUrlObserved: no-op when protocol not websocket', () => {
  const data = {
    strategy: 'fetch',
    protocol: 'http',
    baseUrl: 'https://api.example.com',
    endpoint: '/send',
  };
  // passing frames shouldn't matter
  assert.doesNotThrow(() => verifyWsUrlObserved(data, []));
  assert.doesNotThrow(() =>
    verifyWsUrlObserved(data, [
      { url: 'wss://whatever.example.com/', direction: 'sent', payload: '', timestamp: 0 },
    ]),
  );
});

test('verifyWsUrlObserved: no-op with 0 frames (no discovery data, nothing to compare)', () => {
  const data = {
    strategy: 'fetch',
    protocol: 'websocket',
    baseUrl: 'https://example.com',
    wsUrl: 'wss://ws.example.com/chat',
    frame: 'x',
  };
  assert.doesNotThrow(() => verifyWsUrlObserved(data, []));
});

test('verifyWsUrlObserved: no-op when wsUrl has unresolved template', () => {
  const data = {
    strategy: 'fetch',
    protocol: 'websocket',
    baseUrl: 'https://example.com',
    wsUrl: 'wss://ws.example.com/chat/{{room_id}}',
    frame: 'x',
  };
  const frames = [
    { url: 'wss://different.example.com/', direction: 'sent', payload: '', timestamp: 0 },
  ];
  assert.doesNotThrow(() => verifyWsUrlObserved(data, frames));
});

// --- probeStrategySelectors: default stamping for ws ---

function makeMockPool({ selectorsThatExist = new Set(), evaluateResult = undefined } = {}) {
  const sessionId = 'mock-ws-probe';
  const driver = {
    async navigate() {},
    async waitForSelector(_s, selector) {
      if (!selectorsThatExist.has(selector)) {
        throw new Error(`selector not found: ${selector}`);
      }
    },
    async delay() {},
    async click() {
      throw new Error('probe must not click');
    },
    async type() {
      throw new Error('probe must not type');
    },
    async select() {
      throw new Error('probe must not select');
    },
    async getText() {
      return '';
    },
    async getAttribute() {
      return '';
    },
    async getUrl() {
      return 'about:blank';
    },
    async evaluateExpression() {
      return evaluateResult;
    },
    async fetchInBrowser() {
      return { ok: true, status: 200, body: {} };
    },
  };
  return {
    async createSession() {
      return { id: sessionId };
    },
    async closeSession() {},
    getSession() {
      return { id: sessionId };
    },
    driverFor() {
      return driver;
    },
  };
}

test('probe: leaves http fetch tier untouched (no prereqs → no probe work)', async () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/send',
  };
  await probeStrategySelectors({ data, platform: 'httptest', pool: makeMockPool() });
  assert.strictEqual(data.strategy, 'fetch');
  assert.ok(!('transport' in data), 'transport field must not be stamped (removed)');
});

// --- probeStrategySelectors: wsOpen.steps selector probe ---

test('probe: wsOpen.steps selector resolves → accepted', async () => {
  const data = {
    strategy: 'fetch',
    protocol: 'websocket',
    baseUrl: 'https://example.com',
    wsUrl: 'wss://ws.example.com/chat',
    frame: 'x',
    wsOpen: {
      steps: [
        {
          action: 'click',
          locators: {
            css: 'button.open-chat',
            a11y: { role: 'button', name: 'Open chat' },
          },
        },
      ],
    },
  };
  const pool = makeMockPool({ selectorsThatExist: new Set(['button.open-chat']) });
  await probeStrategySelectors({ data, platform: 'wsopentest', pool });
  // Tier demoted to page-script (ws always needs browser page unless
  // the fetch tier was explicitly kept via Node-capable wsHeaders dial).
  assert.strictEqual(data.strategy, 'page-script');
  // Demote reason lands on runtime_meta, NOT on notes — notes is the
  // LLM-owned input surface and validateNotesAllowlist would reject any
  // unknown key. Regression for the bug where the probe stamped
  // `notes.tier_demote_reason` and the validator immediately rejected it.
  assert.ok(data.runtime_meta?.tier_demote_reason, 'expected runtime_meta.tier_demote_reason');
  assert.ok(
    !data.notes || !('tier_demote_reason' in data.notes),
    'tier_demote_reason must not land on notes',
  );
});

test('probe → validator round-trip: fetch with js-eval prereq demotes cleanly', async () => {
  // Integration check the original `notes.tier_demote_reason` bug slipped
  // past: probe tests asserted tier mutation but never re-ran validation
  // afterwards. With the runtime stamp going to `runtime_meta`, the
  // post-probe data must round-trip through validateStrategyShape — the
  // GitHub create_issue shape that triggered the original failure.
  const data = {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://github.com',
    endpoint: '/_graphql',
    headers: { 'X-Fetch-Nonce': '{{nonce}}' },
    body: { query: 'createIssueMutation' },
    prerequisites: [
      {
        name: 'nonce',
        kind: 'js-eval',
        url: 'https://github.com/owner/repo/issues/new',
        expression: 'document.querySelector("meta[name=fetch-nonce]").content',
        binds: 'nonce',
        return_shape: { kind: 'string' },
      },
    ],
    notes: { params: { title: { kind: 'text', example: 'hello' } } },
  };
  const pool = makeMockPool({ evaluateResult: 'real-nonce-from-page' });
  await probeStrategySelectors({ data, platform: 'github', pool });
  assert.strictEqual(data.strategy, 'page-script', 'fetch with js-eval prereq → page-script');
  assert.ok(
    data.runtime_meta?.tier_demote_reason,
    'demote reason must be stamped on runtime_meta',
  );
  const { validateStrategyShape } = await import('../dist/strategies/validate/shape.js');
  validateStrategyShape(data); // Throws if any field — including the runtime stamp — trips the validator.
});

test('probe: wsOpen.steps selector missing → rejected with pointer', async () => {
  const data = {
    strategy: 'fetch',
    protocol: 'websocket',
    baseUrl: 'https://example.com',
    wsUrl: 'wss://ws.example.com/chat',
    frame: 'x',
    wsOpen: {
      steps: [
        {
          action: 'click',
          locators: {
            css: 'button.does-not-exist',
            a11y: { role: 'button', name: 'Nope' },
          },
        },
      ],
    },
  };
  const pool = makeMockPool({ selectorsThatExist: new Set() });
  await assert.rejects(
    () => probeStrategySelectors({ data, platform: 'wsopentest2', pool }),
    /none of the locator candidates resolved/,
  );
});
