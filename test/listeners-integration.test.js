// End-to-end listener integration tests.
//
// Spins up a real HTTP + WebSocket server acting as a mock platform, saves
// listener-strategy JSON files that point at the local server, and drives
// the full ListenerManager transport path (real `ws` client, real `fetch`,
// real SSE stream). Each transport pushes real events through the server
// and asserts they surface in the event queue with filters applied.
//
// Complements `listeners-browser-event.test.js` (which mocks the pool) by
// covering the non-browser transports against a live wire.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-listeners-int-'));
process.env.KLURA_HOME = HOME;

const { ListenerManager } = await import('../dist/listeners/index.js');

// ---- Mock platform server ----

async function startMockServer() {
  const sseClients = new Set();
  const wsClients = new Set();
  const upgradeUrls = [];
  let pollQueue = [];

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.pathname === '/poll') {
      const batch = pollQueue;
      pollQueue = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batch));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws, req) => {
    upgradeUrls.push(req.url);
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    upgradeUrls,
    pushWs: (obj) => {
      const payload = JSON.stringify(obj);
      for (const ws of wsClients) ws.send(payload);
    },
    pushSse: (obj) => {
      const line = `data: ${JSON.stringify(obj)}\n\n`;
      for (const res of sseClients) res.write(line);
    },
    queuePoll: (obj) => {
      pollQueue.push(obj);
    },
    dropAllWs: () => {
      for (const ws of wsClients) ws.terminate();
      wsClients.clear();
    },
    wsConnectionCount: () => wsClients.size,
    close: async () => {
      for (const ws of wsClients) ws.terminate();
      for (const res of sseClients) res.end();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

// Save a listener strategy JSON directly. Bypasses the strategy validator
// (listener shapes aren't its target) — the ListenerManager reads raw JSON.
function saveListener(platform, capability, tier, strategyBody) {
  const subdirMap = { fetch: 'fetch', 'page-script': 'scripts', 'recorded-path': 'paths' };
  const dir = path.join(HOME, 'skills', platform, subdirMap[tier]);
  fs.mkdirSync(dir, { recursive: true });
  const full = { strategy: tier, type: 'listener', ...strategyBody };
  fs.writeFileSync(path.join(dir, `${capability}.json`), JSON.stringify(full));
}

async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---- Tests ----

test('websocket listener receives frames from live server and applies match filter', async () => {
  const server = await startMockServer();
  try {
    saveListener('wsapp1', 'on_msg', 'fetch', {
      transport: 'websocket',
      endpoint: `${server.wsUrl}?room={{room_id}}`,
      events: { match: { type: 'message' } },
    });

    const mgr = new ListenerManager();
    const { listenerId } = await mgr.start('wsapp1', 'on_msg', { room_id: 'general' });

    await waitFor(() => server.wsConnectionCount() === 1, 2000, 'ws connect');

    server.pushWs({ type: 'message', text: 'hello' });
    server.pushWs({ type: 'typing', user: 'a' });
    server.pushWs({ type: 'message', text: 'world' });

    await waitFor(() => mgr.eventQueue.length >= 2, 2000, 'events delivered');

    const events = mgr.getEvents();
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(
      events.map((e) => e.data),
      [
        { type: 'message', text: 'hello' },
        { type: 'message', text: 'world' },
      ],
    );

    await mgr.stop(listenerId);
  } finally {
    await server.close();
  }
});

test('websocket listener reconnects after a server-side drop', async () => {
  const server = await startMockServer();
  try {
    saveListener('wsapp2', 'on_msg', 'fetch', {
      transport: 'websocket',
      endpoint: server.wsUrl,
      reconnect: { initialDelay: 10, maxRetries: 5, maxDelay: 50 },
    });

    const mgr = new ListenerManager();
    const { listenerId } = await mgr.start('wsapp2', 'on_msg');

    await waitFor(() => server.wsConnectionCount() === 1, 2000, 'initial ws connect');
    server.dropAllWs();
    await waitFor(() => server.wsConnectionCount() === 1, 2000, 'reconnect ws connect');

    server.pushWs({ type: 'message', text: 'post-reconnect' });
    await waitFor(() => mgr.eventQueue.length >= 1, 2000, 'event after reconnect');

    const events = mgr.getEvents();
    assert.strictEqual(events[0].data.text, 'post-reconnect');
    assert.strictEqual(server.upgradeUrls.length, 2, 'server saw two upgrades');

    await mgr.stop(listenerId);
  } finally {
    await server.close();
  }
});

test('fetch-stream listener parses SSE frames from a live GET stream', async () => {
  const server = await startMockServer();
  try {
    saveListener('streamapp1', 'on_event', 'fetch', {
      transport: 'fetch-stream',
      method: 'GET',
      endpoint: `${server.baseUrl}/sse`,
      events: { match: { type: 'update' } },
    });

    const mgr = new ListenerManager();
    const { listenerId } = await mgr.start('streamapp1', 'on_event');

    await waitFor(() => mgr.active.get(listenerId)?.sseController, 500, 'fetch-stream controller wired');
    await new Promise((r) => setTimeout(r, 50));

    server.pushSse({ type: 'update', id: 1 });
    server.pushSse({ type: 'noise', id: 2 });
    server.pushSse({ type: 'update', id: 3 });

    await waitFor(() => mgr.eventQueue.length >= 2, 2000, 'fetch-stream events delivered');

    const events = mgr.getEvents();
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(
      events.map((e) => e.data),
      [
        { type: 'update', id: 1 },
        { type: 'update', id: 3 },
      ],
    );

    await mgr.stop(listenerId);
  } finally {
    await server.close();
  }
});

test('poll listener fetches at interval and unpacks array results', async () => {
  const server = await startMockServer();
  try {
    saveListener('pollapp1', 'on_tick', 'fetch', {
      transport: 'poll',
      endpoint: `${server.baseUrl}/poll`,
      pollInterval: 30,
      events: { match: { type: 'tick' } },
    });

    server.queuePoll({ type: 'tick', n: 1 });
    server.queuePoll({ type: 'skip', n: 2 });
    server.queuePoll({ type: 'tick', n: 3 });

    const mgr = new ListenerManager();
    const { listenerId } = await mgr.start('pollapp1', 'on_tick');

    await waitFor(() => mgr.eventQueue.length >= 2, 2000, 'poll events delivered');

    const events = mgr.getEvents();
    const ticks = events.filter((e) => e.data && e.data.type === 'tick');
    assert.strictEqual(ticks.length, 2);
    assert.strictEqual(ticks[0].data.n, 1);
    assert.strictEqual(ticks[1].data.n, 3);

    await mgr.stop(listenerId);
  } finally {
    await server.close();
  }
});

test('websocket listener resolves {{template}} vars + query-param auth into the URL', async () => {
  const server = await startMockServer();
  try {
    saveListener('wsapp3', 'on_msg', 'fetch', {
      transport: 'websocket',
      endpoint: `${server.wsUrl}?room={{room_id}}`,
      auth: { type: 'query-param', param: 'token', value: '{{session_token}}' },
    });

    const mgr = new ListenerManager();
    const { listenerId } = await mgr.start('wsapp3', 'on_msg', {
      room_id: 'r42',
      session_token: 'tok-abc',
    });

    await waitFor(() => server.upgradeUrls.length >= 1, 2000, 'upgrade observed');
    const seen = server.upgradeUrls[0];
    assert.ok(seen.includes('room=r42'), `expected room=r42 in ${seen}`);
    assert.ok(seen.includes('token=tok-abc'), `expected token=tok-abc in ${seen}`);

    server.pushWs({ type: 'message', text: 'ok' });
    await waitFor(() => mgr.eventQueue.length >= 1, 2000, 'message delivered');

    const events = mgr.getEvents();
    assert.strictEqual(events[0].data.text, 'ok');

    await mgr.stop(listenerId);
  } finally {
    await server.close();
  }
});
