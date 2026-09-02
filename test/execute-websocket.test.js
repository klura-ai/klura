// Unit tests for the WebSocket execution path (protocol:"websocket").
// Covers Node transport (no browser) against a local ws echo server, the
// fire-and-forget path, ack-timeout diagnostics, binary encoding, and the
// TransportFailureError → no-pool surfacing.
//
// Browser-transport coverage is deferred — it needs a live Playwright pool,
// and the two primitives it calls (hasOpenWebSocket, sendWebSocketFrame)
// are exercised in the local echo-server smoke from the previous session
// already.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-exec-ws-test-'));
process.env.KLURA_HOME = TMP;

const klura = await import('../dist/index.js');
const skillsMod = await import('../dist/strategies/skills.js');
const { execute: executeCore } = await import('../dist/execution/index.js');
const { execute } = klura;
const saveStrategy = skillsMod.saveStrategy;
const { localTrafficPolicyForUrl } = await import('../dist/execution/local-traffic.js');
const { getHealth } = await import('../dist/strategies/health.js');

test.after(async () => {
  // Dispose the daemon pool that index.js spins up on module load — without
  // this the idle timer keeps the node --test process alive for minutes
  // after the WS tests themselves finish.
  try {
    const pool = klura._pool;
    if (pool && typeof pool.shutdown === 'function') await pool.shutdown();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function startEchoServer(opts = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const received = [];
  wss.on('connection', (ws, req) => {
    ws.on('message', (data, isBinary) => {
      received.push({
        isBinary,
        payload: isBinary ? Buffer.from(data) : data.toString(),
        headers: req.headers,
      });
      if (opts.reply === 'none') return;
      if (opts.reply === 'ack') {
        ws.send('upsertMessage {"ok":1}');
        return;
      }
      if (opts.reply === 'unrelated') {
        ws.send('unrelated-chatter');
        return;
      }
      // Default: echo
      ws.send('echo: ' + (isBinary ? Buffer.from(data).toString('hex') : data.toString()));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return {
    url: `ws://127.0.0.1:${port}/`,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function startLookupServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const name = url.searchParams.get('name') ?? 'unknown';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ thread_id: `thread-for-${name}` }));
  });
  await new Promise((r) => server.listen(0, r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test('fetch + ws + node: success with ackMatch', async () => {
  const srv = await startEchoServer({ reply: 'ack' });
  try {
    saveStrategy('test-ws', 'send_message', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: srv.url,
      frame: '{"text":"{{message}}"}',
      ackMatch: 'upsertMessage',
      ackTimeoutMs: 2000,
      notes: { params: { message: { description: 'text', example: 'hi' } } },
    });
    const result = await execute(
      'test-ws',
      'send_message',
      { message: 'hello' },
      { _collectDiagnosticEvidence: true },
    );
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.ok, true);
    assert.strictEqual(result.body.sent, true);
    assert.strictEqual(result.tier, 'fetch');
    assert.strictEqual(result.transport, 'node');
    assert.strictEqual(result.protocol, 'websocket');
    assert.deepEqual(result.diagnosticEvidence.urls, [
      { kind: 'request', url: srv.url },
    ]);
    assert.strictEqual(srv.received.length, 1);
    assert.strictEqual(srv.received[0].payload, '{"text":"hello"}');
  } finally {
    await srv.close();
  }
});

test('trusted local wss handshakes share the matching HTTPS scheduler origin', () => {
  assert.equal(
    localTrafficPolicyForUrl('wss://realtime.example.test/socket').origin,
    'https://realtime.example.test',
  );
});

test('fetch + ws + node: fire-and-forget (no ackMatch)', async () => {
  const srv = await startEchoServer({ reply: 'none' });
  try {
    saveStrategy('test-ws', 'fire_forget', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: srv.url,
      frame: 'ping',
    });
    const result = await execute('test-ws', 'fire_forget', {});
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.ok, true);
    assert.strictEqual(result.body.sent, true);
  } finally {
    await srv.close();
  }
});

test('fetch + ws + node: ack_timeout is sent_unconfirmed and leaves health neutral', async () => {
  const srv = await startEchoServer({ reply: 'unrelated' });
  try {
    saveStrategy('test-ws', 'ack_timeout_case', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: srv.url,
      frame: 'send',
      ackMatch: 'never-in-reply',
      ackTimeoutMs: 300,
    });
    const result = await execute('test-ws', 'ack_timeout_case', {});
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.executionState, 'sent_unconfirmed');
    assert.strictEqual(result.body.error, 'ack_timeout');
    assert.strictEqual(result.body.sent, true);
    assert.strictEqual(result.body.ackMatch, 'never-in-reply');
    const health = getHealth('test-ws', 'ack_timeout_case', 'fetch');
    assert.strictEqual(health.failureCount, 0);
    assert.strictEqual(health.recent, undefined);
  } finally {
    await srv.close();
  }
});

test('sent_unconfirmed stops before a sibling tier can duplicate the frame', async () => {
  const srv = await startEchoServer({ reply: 'unrelated' });
  let browserAttempts = 0;
  const neverBrowserPool = {
    async createSession() {
      browserAttempts += 1;
      throw new Error('page-script sibling must not run');
    },
  };
  try {
    const common = {
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: srv.url,
      frame: 'send-once',
      ackMatch: 'never-in-reply',
      ackTimeoutMs: 100,
    };
    saveStrategy('test-ws', 'sent_once', { strategy: 'fetch', ...common });
    saveStrategy('test-ws', 'sent_once', { strategy: 'page-script', ...common });

    const result = await execute('test-ws', 'sent_once', {}, neverBrowserPool);

    assert.strictEqual(result.executionState, 'sent_unconfirmed');
    assert.strictEqual(result.tier, 'fetch');
    assert.strictEqual(browserAttempts, 0);
    assert.strictEqual(srv.received.length, 1);
    assert.strictEqual(srv.received[0].payload, 'send-once');
  } finally {
    await srv.close();
  }
});

test('WebSocket URLs share exact optional-query omission semantics', async () => {
  const srv = await startEchoServer({ reply: 'ack' });
  try {
    saveStrategy('test-ws', 'optional_ws_query', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: `${srv.url}?cursor={{cursor}}`,
      frame: 'ping',
      ackMatch: 'upsertMessage',
      notes: { params: { cursor: { kind: 'id', optional: true } } },
    });

    const result = await execute('test-ws', 'optional_ws_query', {});

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.ok, true);
    assert.strictEqual(srv.received.length, 1);
  } finally {
    await srv.close();
  }
});

test('embedded missing WebSocket URL refs are not sent and leave health neutral', async () => {
  const srv = await startEchoServer({ reply: 'ack' });
  try {
    saveStrategy('test-ws', 'embedded_ws_query', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: `${srv.url}?cursor=after:{{cursor}}`,
      frame: 'ping',
      notes: { params: { cursor: { kind: 'id', optional: true } } },
    });

    const result = await execute('test-ws', 'embedded_ws_query', {});

    assert.strictEqual(result.executionState, 'not_run');
    assert.strictEqual(result.body.error, 'unresolved_placeholders');
    assert.deepStrictEqual(result.body.unresolved, ['cursor']);
    assert.strictEqual(srv.received.length, 0);
    const health = getHealth('test-ws', 'embedded_ws_query', 'fetch');
    assert.strictEqual(health.failureCount, 0);
    assert.strictEqual(health.recent, undefined);
  } finally {
    await srv.close();
  }
});

test('generated WebSocket frames close placeholders before send', async () => {
  const srv = await startEchoServer({ reply: 'ack' });
  try {
    saveStrategy('test-ws', 'generated_frame_unresolved', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: srv.url,
      generated: { frame: { code: 'return "{{missing}}";' } },
    });

    const result = await execute('test-ws', 'generated_frame_unresolved', {});

    assert.strictEqual(result.executionState, 'not_run');
    assert.strictEqual(result.body.error, 'unresolved_placeholders');
    assert.strictEqual(srv.received.length, 0);
  } finally {
    await srv.close();
  }
});

test('browser WebSocket defers prereq-bound URL validation until after prerequisites', async () => {
  const navigations = [];
  const sent = [];
  let readyProbeCalls = 0;
  let resolvedWsUrl = '';
  const session = { id: 'ws-prereq-session', platform: 'test-ws-prereq' };
  const driver = {
    async navigate(_session, url) {
      navigations.push(url);
    },
    async getText() {
      return 'bound-token';
    },
    async getAttribute() {
      return 'bound-token';
    },
    async delay() {},
    async hasOpenWebSocket(_session, url) {
      resolvedWsUrl = url;
      return true;
    },
    async sendWebSocketFrame(_session, url, frame) {
      sent.push({ url, frame });
      return { ok: true };
    },
    async saveStorageState() {},
  };
  const browserPool = {
    async tryCheckoutReadySession() {
      readyProbeCalls += 1;
      throw new Error('ready probe must be skipped while ws_token is unresolved');
    },
    async createSession() {
      return session;
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  };

  saveStrategy('test-ws-prereq', 'send_bound', {
    strategy: 'page-script',
    protocol: 'websocket',
    origin: 'https://example.test',
    wsUrl: 'wss://example.test/ws?token={{ws_token}}',
    frame: 'send',
    prerequisites: [
      {
        name: 'read_ws_token',
        kind: 'page-extract',
        url: 'https://example.test/bootstrap?cursor={{cursor}}',
        vars: { ws_token: { selector: '#token' } },
      },
    ],
    notes: { params: { cursor: { kind: 'id', optional: true } } },
  });

  const result = await executeCore('test-ws-prereq', 'send_bound', {}, browserPool, null);

  assert.strictEqual(result.status, 200, JSON.stringify(result));
  assert.strictEqual(result.body.ok, true);
  assert.strictEqual(readyProbeCalls, 0);
  assert.strictEqual(resolvedWsUrl, 'wss://example.test/ws?token=bound-token');
  assert.deepStrictEqual(sent, [{ url: 'wss://example.test/ws?token=bound-token', frame: 'send' }]);
  assert.ok(navigations.includes('https://example.test/bootstrap'));
});

test('wsOpen.steps preserves unresolved placeholders as not_run', async () => {
  const session = { id: 'ws-open-step-session', platform: 'test-ws-open-step' };
  let clicks = 0;
  let sends = 0;
  const driver = {
    async navigate() {},
    async hasOpenWebSocket() {
      return false;
    },
    async click() {
      clicks += 1;
    },
    async delay() {},
    async sendWebSocketFrame() {
      sends += 1;
      return { ok: true };
    },
    async saveStorageState() {},
  };
  const browserPool = {
    async createSession() {
      return session;
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
  };

  saveStrategy('test-ws-open-step', 'send_bound', {
    strategy: 'page-script',
    protocol: 'websocket',
    origin: 'https://example.test',
    wsUrl: 'wss://example.test/ws',
    frame: 'send',
    wsOpenTimeoutMs: 1,
    wsOpen: {
      steps: [{ action: 'click', locators: { css: '{{selector}}' } }],
    },
    notes: { params: { selector: { kind: 'text', optional: true } } },
  });

  const result = await executeCore('test-ws-open-step', 'send_bound', {}, browserPool, null);

  assert.equal(result.executionState, 'not_run');
  assert.equal(result.body.error, 'unresolved_placeholders');
  assert.equal(clicks, 0);
  assert.equal(sends, 0);
  const health = getHealth('test-ws-open-step', 'send_bound', 'page-script');
  assert.equal(health.failureCount, 0);
  assert.equal(health.recent, undefined);
});

test('fetch + ws + node: binary encoding — base64 frame decoded to bytes', async () => {
  const srv = await startEchoServer({ reply: 'none' });
  try {
    const bytes = Buffer.from([0xaa, 0xbb, 0xcc, 0x01, 0x02]);
    saveStrategy('test-ws', 'binary_send', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: srv.url,
      frame: bytes.toString('base64'),
      frameEncoding: 'binary',
    });
    const result = await execute('test-ws', 'binary_send', {});
    assert.strictEqual(result.status, 200);
    // fire-and-forget resolves as soon as the local ws socket's send
    // buffer accepts the payload — the server's 'message' event fires on
    // the next tick. Give it a beat before asserting.
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(srv.received.length, 1);
    assert.strictEqual(srv.received[0].isBinary, true);
    assert.ok(srv.received[0].payload.equals(bytes), 'received bytes match sent bytes');
  } finally {
    await srv.close();
  }
});

test('fetch + ws + node: wsHeaders forwarded on handshake', async () => {
  const srv = await startEchoServer({ reply: 'ack' });
  try {
    saveStrategy('test-ws', 'hdr_send', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: srv.url,
      wsHeaders: { Cookie: 'sid={{sid}}', Origin: 'https://example.com' },
      frame: 'm',
      ackMatch: 'upsertMessage',
      ackTimeoutMs: 1000,
      notes: { params: { sid: { description: 'session id', example: 'abc' } } },
    });
    const result = await execute('test-ws', 'hdr_send', { sid: 'real-sid' });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(srv.received[0].headers.cookie, 'sid=real-sid');
    assert.strictEqual(srv.received[0].headers.origin, 'https://example.com');
  } finally {
    await srv.close();
  }
});

test('fetch + ws + node: capability prereq vars bind values before dialing', async () => {
  const srv = await startEchoServer({ reply: 'ack' });
  const lookup = await startLookupServer();
  try {
    saveStrategy('test-ws', 'lookup_thread', {
      strategy: 'fetch',
      baseUrl: lookup.baseUrl,
      method: 'GET',
      endpoint: '/lookup?name={{name}}',
      notes: { params: { name: { description: 'recipient name', example: 'bob' } } },
    });
    saveStrategy('test-ws', 'send_with_lookup', {
      strategy: 'fetch',
      protocol: 'websocket',
      origin: 'http://127.0.0.1',
      wsUrl: srv.url,
      frame: '{"thread":"{{thread_id}}","text":"{{message}}"}',
      ackMatch: 'upsertMessage',
      ackTimeoutMs: 1000,
      prerequisites: [
        {
          name: 'lookup_thread',
          kind: 'capability',
          capability: 'lookup_thread',
          args: { name: '{{recipient}}' },
          vars: { thread_id: 'thread_id' },
        },
      ],
      notes: {
        params: {
          recipient: { description: 'recipient', example: 'bob' },
          message: { description: 'message', example: 'hi' },
        },
      },
    });
    const result = await execute('test-ws', 'send_with_lookup', {
      recipient: 'bob',
      message: 'hello',
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(srv.received.length, 1);
    assert.strictEqual(srv.received[0].payload, '{"thread":"thread-for-bob","text":"hello"}');
  } finally {
    await lookup.close();
    await srv.close();
  }
});

test('fetch + ws + node: unreachable server → TransportFailureError → no pool → error surfaced', async () => {
  saveStrategy('test-ws', 'unreachable', {
    strategy: 'fetch',
    protocol: 'websocket',
    origin: 'http://127.0.0.1',
    // ws://127.0.0.1:1 — low reserved port should refuse connection quickly.
    wsUrl: 'ws://127.0.0.1:1/',
    frame: 'never-sends',
  });
  // execute() with pool=null sees the TransportFailureError and can't
  // retry in browser — surfaces the error in the cascade errors list and
  // finalizeCascadeFailure returns all_strategies_failed.
  const result = await execute('test-ws', 'unreachable', {});
  assert.strictEqual(result.status, 0);
  const body = result.body;
  // Either all_strategies_failed (cascade exhaustion) or a direct ws error
  // depending on whether finalizeCascadeFailure is involved.
  // Node transport fails with ws_handshake_failed, the dispatcher then
  // retries in browser (a daemon pool exists in this test) which navigates
  // to baseUrl and fails there with ws_navigate_failed — either surfaced
  // shape means "the unreachable endpoint was detected, not silently
  // swallowed".
  assert.match(
    JSON.stringify(body),
    /all_strategies_failed|ws_handshake_failed|ws_open_timeout|ws_error|ws_navigate_failed|no pool/,
  );
});
