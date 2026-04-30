// Unit tests for the Node-side WebSocket client (sendNodeWebSocketFrame).
// Spins a local `ws` echo server, exercises success, ack-timeout,
// fire-and-forget, and error paths.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const { sendNodeWebSocketFrame } = await import('../dist/drivers/node-ws-client.js');

async function startEchoServer(opts = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const str = data.toString();
      if (opts.delayMs) {
        setTimeout(() => ws.send('echo: ' + str), opts.delayMs);
      } else if (opts.ackMatchPayload) {
        ws.send(opts.ackMatchPayload);
      } else {
        ws.send('echo: ' + str);
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return {
    url: `ws://127.0.0.1:${port}/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test('sendNodeWebSocketFrame: success with ack match', async () => {
  const srv = await startEchoServer();
  try {
    const r = await sendNodeWebSocketFrame(
      srv.url,
      {},
      'klura-node-ws-smoke',
      { ackMatch: 'echo: klura-node-ws-smoke', ackTimeoutMs: 2000 },
    );
    assert.strictEqual(r.ok, true);
    assert.match(r.ackPayload, /echo: klura-node-ws-smoke/);
  } finally {
    await srv.close();
  }
});

test('sendNodeWebSocketFrame: fire-and-forget (no ackMatch) resolves after send', async () => {
  const srv = await startEchoServer();
  try {
    const r = await sendNodeWebSocketFrame(srv.url, {}, 'no-ack-expected');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.ackPayload, undefined);
  } finally {
    await srv.close();
  }
});

test('sendNodeWebSocketFrame: ack-timeout when server never sends matching ack', async () => {
  // Server sends a non-matching echo; our ackMatch looks for something else.
  const srv = await startEchoServer({ ackMatchPayload: 'unrelated-chatter' });
  try {
    const r = await sendNodeWebSocketFrame(
      srv.url,
      {},
      'whatever',
      { ackMatch: 'expected-match-not-here', ackTimeoutMs: 300 },
    );
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /ack_timeout/);
  } finally {
    await srv.close();
  }
});

test('sendNodeWebSocketFrame: open-timeout when server unreachable', async () => {
  // No server listening on 127.0.0.1:1 — the low reserved port is a quick
  // reject. We expect either an error event or an open_timeout; both
  // surface as ok:false with a distinguishable error string.
  const r = await sendNodeWebSocketFrame(
    'ws://127.0.0.1:1/',
    {},
    'x',
    { openTimeoutMs: 500 },
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ws_(error|open_timeout|closed_before_ack)/);
});

test('sendNodeWebSocketFrame: binary payload sends bytes', async () => {
  // Server echoes the raw bytes as a Buffer. We send Uint8Array and
  // verify the echoed data starts with the same bytes.
  const srv = await startEchoServer();
  try {
    const buf = new Uint8Array([0x68, 0x69, 0x21]); // "hi!"
    const r = await sendNodeWebSocketFrame(
      srv.url,
      {},
      buf,
      { ackMatch: 'echo: hi!', ackTimeoutMs: 2000 },
    );
    assert.strictEqual(r.ok, true);
  } finally {
    await srv.close();
  }
});

test('sendNodeWebSocketFrame: forwards upgrade headers to handshake', async () => {
  // Server inspects handshake headers on connection.
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let observedHeader = null;
  server.on('upgrade', (req, socket, head) => {
    observedHeader = req.headers['x-klura-test'];
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (d) => ws.send('echo: ' + d.toString()));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await sendNodeWebSocketFrame(
      `ws://127.0.0.1:${port}/`,
      { 'x-klura-test': 'smoke-value' },
      'ping',
      { ackMatch: 'echo: ping', ackTimeoutMs: 2000 },
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(observedHeader, 'smoke-value');
  } finally {
    await new Promise((r) => server.close(() => r()));
  }
});
