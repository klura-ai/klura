// Unit tests for the WebSocket protocol axis. Covers validateStrategyShape
// across the (tier × protocol) matrix. Transport is implicit in tier:
//   tier=fetch → Node dial (wsHeaders allowed, wsOpen forbidden)
//   tier=page-script → page WebSocket (wsOpen allowed, wsHeaders forbidden)
// Executor tests live in execute-websocket.test.js.

import test from 'node:test';
import assert from 'node:assert';
import { validateStrategyShape } from '../dist/strategies/skills.js';

function expectReject(data, matcher) {
  assert.throws(
    () => validateStrategyShape(data),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      if (matcher instanceof RegExp) assert.match(err.message, matcher);
      else if (typeof matcher === 'string') assert.ok(err.message.includes(matcher));
      return true;
    },
  );
}

const httpBase = (tier = 'fetch', overrides = {}) => ({
  strategy: tier,
  baseUrl: 'https://api.example.com',
  endpoint: '/x',
  ...(tier === 'fetch' ? { prerequisites: [] } : {}),
  ...overrides,
});

const wsBase = (tier = 'fetch', overrides = {}) => ({
  strategy: tier,
  origin: 'https://example.com',
  wsUrl: 'wss://ws.example.com/chat',
  frame: '{"text":"{{message}}"}',
  ...(tier === 'fetch' ? { prerequisites: [] } : {}),
  notes: { params: { message: { description: 'user message', example: 'hello' } } },
  ...overrides,
});

// ---- (tier × protocol) accept matrix ----

test('fetch + http accepted', () => {
  validateStrategyShape(httpBase('fetch'));
});

test('page-script + http accepted', () => {
  validateStrategyShape(httpBase('page-script'));
});

test('fetch + websocket accepted (Node dial, headers allowed)', () => {
  validateStrategyShape(
    wsBase('fetch', {
      protocol: 'websocket',
      wsHeaders: { Cookie: 'sid={{sid}}', Origin: 'https://example.com' },
      notes: {
        params: {
          message: { description: 'user message', example: 'hello' },
          sid: { description: 'session id', example: 'abc' },
        },
      },
    }),
  );
});

test('fetch + websocket accepted (minimal)', () => {
  validateStrategyShape(wsBase('fetch', { protocol: 'websocket' }));
});

test('page-script + websocket accepted', () => {
  validateStrategyShape(wsBase('page-script', { protocol: 'websocket' }));
});

// ---- transport field is not a schema field any more ----

test('transport:"node" on fetch rejected (implicit in tier)', () => {
  expectReject(httpBase('fetch', { transport: 'node' }), /transport is not allowed/);
});

test('transport:"browser" on fetch rejected (implicit in tier)', () => {
  expectReject(httpBase('fetch', { transport: 'browser' }), /transport is not allowed/);
});

test('transport:"node" on page-script rejected', () => {
  expectReject(
    httpBase('page-script', { transport: 'node' }),
    /transport is not allowed/,
  );
});

test('recorded-path.protocol rejected', () => {
  expectReject(
    {
      strategy: 'recorded-path',
      protocol: 'websocket',
      steps: [{ id: 'navigate_x', action: 'navigate', url: 'https://x' }],
    },
    /recorded-path\.protocol is not allowed/,
  );
});

test('recorded-path.transport rejected', () => {
  expectReject(
    {
      strategy: 'recorded-path',
      transport: 'node',
      steps: [{ id: 'navigate_x', action: 'navigate', url: 'https://x' }],
    },
    /transport is not allowed/,
  );
});

test('recorded-path.wsUrl rejected', () => {
  expectReject(
    {
      strategy: 'recorded-path',
      wsUrl: 'wss://x',
      steps: [{ id: 'navigate_x', action: 'navigate', url: 'https://x' }],
    },
    /ws\* fields require protocol:"websocket"/,
  );
});

// ---- cross-field validator: ws fields forbidden on http ----

test('http + wsUrl rejected', () => {
  expectReject(
    httpBase('fetch', { wsUrl: 'wss://x' }),
    /wsUrl is only valid when protocol:"websocket"/,
  );
});

test('http + frame rejected', () => {
  expectReject(
    httpBase('fetch', { frame: '{"text":"x"}' }),
    /frame is only valid when protocol:"websocket"/,
  );
});

test('http + ackMatch rejected', () => {
  expectReject(
    httpBase('fetch', { ackMatch: 'ok' }),
    /ackMatch is only valid when protocol:"websocket"/,
  );
});

// ---- cross-field validator: http fields forbidden on websocket ----

test('websocket + endpoint rejected', () => {
  expectReject(
    wsBase('fetch', { protocol: 'websocket', endpoint: '/x' }),
    /endpoint is not allowed when protocol:"websocket"/,
  );
});

test('websocket + body rejected', () => {
  expectReject(
    wsBase('fetch', { protocol: 'websocket', body: { text: 'x' } }),
    /body is not allowed when protocol:"websocket"/,
  );
});

test('websocket + headers rejected', () => {
  expectReject(
    wsBase('fetch', { protocol: 'websocket', headers: { 'x-test': '1' } }),
    /headers is not allowed when protocol:"websocket"/,
  );
});

test('websocket + contentType rejected', () => {
  expectReject(
    wsBase('fetch', { protocol: 'websocket', contentType: 'json' }),
    /contentType is not allowed when protocol:"websocket"/,
  );
});

// ---- cross-field validator: frame xor generated.frame ----

test('websocket with both frame and generated.frame rejected', () => {
  expectReject(
    wsBase('fetch', {
      protocol: 'websocket',
      frame: '{"x":1}',
      generated: { frame: { code: 'return JSON.stringify({x:1});' } },
    }),
    /exactly one/,
  );
});

test('websocket with neither frame nor generated.frame rejected', () => {
  const data = wsBase('fetch', { protocol: 'websocket' });
  delete data.frame;
  expectReject(data, /requires one of "frame"/);
});

test('websocket with only generated.frame accepted', () => {
  const data = wsBase('fetch', {
    protocol: 'websocket',
    generated: { frame: { code: 'return new Uint8Array([1,2,3]).toString()' } },
  });
  delete data.frame;
  validateStrategyShape(data);
});

// ---- wsUrl required on ws ----

test('websocket without wsUrl rejected', () => {
  const data = wsBase('fetch', { protocol: 'websocket' });
  delete data.wsUrl;
  expectReject(data, /wsUrl/);
});

// ---- tier-specific rejections (transport implicit in tier) ----

test('page-script + websocket + wsHeaders rejected', () => {
  expectReject(
    wsBase('page-script', {
      protocol: 'websocket',
      wsHeaders: { Cookie: 'sid=x' },
    }),
    /wsHeaders is not allowed/,
  );
});

test('fetch + websocket + wsOpen rejected (Node has no page registry)', () => {
  expectReject(
    wsBase('fetch', {
      protocol: 'websocket',
      wsOpen: 'navigate',
    }),
    /wsOpen is not allowed/,
  );
});

test('fetch + websocket + wsOpenTimeoutMs rejected', () => {
  expectReject(
    wsBase('fetch', {
      protocol: 'websocket',
      wsOpenTimeoutMs: 5000,
    }),
    /wsOpenTimeoutMs is not allowed/,
  );
});

// ---- wsOpen shape (page-script tier only) ----

test('wsOpen:"navigate" accepted on page-script', () => {
  validateStrategyShape(wsBase('page-script', { protocol: 'websocket', wsOpen: 'navigate' }));
});

test('wsOpen:"none" accepted on page-script', () => {
  validateStrategyShape(wsBase('page-script', { protocol: 'websocket', wsOpen: 'none' }));
});

test('wsOpen:"invalid-string" rejected', () => {
  expectReject(
    wsBase('page-script', { protocol: 'websocket', wsOpen: 'bogus' }),
    /must be "navigate" .* "none" .* or an object \{steps: \[\.\.\.\]\}/,
  );
});

test('wsOpen object with valid steps accepted', () => {
  validateStrategyShape(
    wsBase('page-script', {
      protocol: 'websocket',
      wsOpen: {
        steps: [
          {
            action: 'click',
            locators: { css: 'button.open-chat', a11y: { role: 'button', name: 'Open chat' } },
          },
        ],
      },
    }),
  );
});

test('wsOpen object with empty steps rejected', () => {
  expectReject(
    wsBase('page-script', { protocol: 'websocket', wsOpen: { steps: [] } }),
    /non-empty "steps" array/,
  );
});

test('wsOpen object with invalid step action rejected', () => {
  expectReject(
    wsBase('page-script', {
      protocol: 'websocket',
      wsOpen: { steps: [{ action: 'keyPress' }] },
    }),
    /not a recognized recorded-path action/,
  );
});

test('wsOpen step validation points at wsOpen.steps, not recorded-path.steps', () => {
  expectReject(
    wsBase('page-script', {
      protocol: 'websocket',
      wsOpen: {
        steps: [{ action: 'click', locators: 'button.open-chat' }],
      },
    }),
    /page-script\.wsOpen\.steps\[0\]\.*/,
  );
});

// ---- numeric shapes ----

test('ackTimeoutMs non-number rejected', () => {
  expectReject(
    wsBase('fetch', { protocol: 'websocket', ackTimeoutMs: '5000' }),
    /ackTimeoutMs must be a non-negative finite number/,
  );
});

test('ackTimeoutMs negative rejected', () => {
  expectReject(
    wsBase('fetch', { protocol: 'websocket', ackTimeoutMs: -1 }),
    /ackTimeoutMs must be a non-negative finite number/,
  );
});

test('ackTimeoutMs 0 accepted', () => {
  validateStrategyShape(wsBase('fetch', { protocol: 'websocket', ackTimeoutMs: 0 }));
});

test('wsOpenTimeoutMs Infinity rejected (on page-script)', () => {
  expectReject(
    wsBase('page-script', { protocol: 'websocket', wsOpenTimeoutMs: Infinity }),
    /wsOpenTimeoutMs must be a non-negative finite number/,
  );
});

// ---- enum fields ----

test('protocol bogus value rejected', () => {
  expectReject(
    { ...httpBase('fetch'), protocol: 'grpc' },
    /protocol.* is not allowed; must be one of: "http", "websocket"/,
  );
});

test('frameEncoding "binary" accepted', () => {
  validateStrategyShape(
    wsBase('fetch', { protocol: 'websocket', frameEncoding: 'binary' }),
  );
});

test('frameEncoding bogus value rejected', () => {
  expectReject(
    wsBase('fetch', { protocol: 'websocket', frameEncoding: 'utf8' }),
    /frameEncoding.* is not allowed; must be one of: "text", "binary"/,
  );
});

// ---- wsHeaders safety (fetch tier — Node dial) ----

test('wsHeaders["Cookie"] accepted on fetch tier', () => {
  validateStrategyShape(
    wsBase('fetch', {
      protocol: 'websocket',
      wsHeaders: { Cookie: 'sid=x', Origin: 'https://example.com', 'User-Agent': 'Mozilla/5.0' },
    }),
  );
});

test('wsHeaders["Host"] rejected', () => {
  expectReject(
    wsBase('fetch', {
      protocol: 'websocket',
      wsHeaders: { Host: 'evil.com' },
    }),
    /wsHeaders\["Host"\] is not allowed/,
  );
});

test('wsHeaders["Sec-Fetch-Site"] rejected', () => {
  expectReject(
    wsBase('fetch', {
      protocol: 'websocket',
      wsHeaders: { 'Sec-Fetch-Site': 'same-origin' },
    }),
    /wsHeaders\["Sec-Fetch-Site"\] is not allowed/,
  );
});

test('wsHeaders["Sec-WebSocket-Key"] rejected (ws library owns it)', () => {
  expectReject(
    wsBase('fetch', {
      protocol: 'websocket',
      wsHeaders: { 'Sec-WebSocket-Key': 'abc' },
    }),
    /wsHeaders\["Sec-WebSocket-Key"\] is not allowed/,
  );
});

test('wsHeaders["Content-Length"] rejected', () => {
  expectReject(
    wsBase('fetch', {
      protocol: 'websocket',
      wsHeaders: { 'Content-Length': '0' },
    }),
    /wsHeaders\["Content-Length"\] is not allowed/,
  );
});

test('websocket strategy does not require endpoint', () => {
  // `endpoint` is forbidden on ws; validating without it must not blow up
  // on the "fetch requires endpoint" check (which is HTTP-only).
  const data = wsBase('fetch', { protocol: 'websocket' });
  assert.ok(!('endpoint' in data));
  validateStrategyShape(data);
});
