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
const { execute } = klura;
const saveStrategy = skillsMod.saveStrategy;

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
    const result = await execute('test-ws', 'send_message', { message: 'hello' });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.ok, true);
    assert.strictEqual(result.body.sent, true);
    assert.strictEqual(result.tier, 'fetch');
    assert.strictEqual(result.transport, 'node');
    assert.strictEqual(result.protocol, 'websocket');
    assert.strictEqual(srv.received.length, 1);
    assert.strictEqual(srv.received[0].payload, '{"text":"hello"}');
  } finally {
    await srv.close();
  }
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

test('fetch + ws + node: ack_timeout surfaced when no matching frame', async () => {
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
    assert.strictEqual(result.body.error, 'ack_timeout');
    assert.strictEqual(result.body.sent, true);
    assert.strictEqual(result.body.ackMatch, 'never-in-reply');
  } finally {
    await srv.close();
  }
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

