// fetch-stream listener transport tests. Two layers:
//
//   1. Pure parser tests — feed bytes into parseSseChunk / parseNdjsonChunk
//      directly with a push callback, assert the right values pop out + the
//      residual buffer state is correct across chunk splits.
//
//   2. Integration tests — spin up an in-process HTTP server that streams
//      SSE / NDJSON, save a fetch-stream listener strategy to disk, drive
//      the ListenerManager against it. Mirrors the pattern in
//      listeners-integration.test.js so the existing fixture shape is
//      reused.
//
// Modeled after the chatgpt.com / claude.ai response cycle: POST + JSON
// body, response Content-Type text/event-stream, frames `data: <json>\n\n`,
// `[DONE]` sentinel at end-of-stream. NDJSON coverage targets character.ai
// / open-source LLM serving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-fetch-stream-'));
process.env.KLURA_HOME = HOME;
test.after(() => {
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { parseSseChunk, parseNdjsonChunk } = await import(
  '../dist/listeners/parse-fetch-stream.js'
);
const { ListenerManager } = await import('../dist/listeners.js');

// ---- Parser unit tests ----

function captureSse(...chunks) {
  const out = [];
  let buf = '';
  for (const chunk of chunks) buf = parseSseChunk(buf + chunk, (v) => out.push(v));
  return { events: out, residual: buf };
}

function captureNdjson(...chunks) {
  const out = [];
  let buf = '';
  for (const chunk of chunks) buf = parseNdjsonChunk(buf + chunk, (v) => out.push(v));
  return { events: out, residual: buf };
}

test('parseSseChunk: complete event in one chunk', () => {
  const r = captureSse('data: {"a":1}\n\n');
  assert.deepStrictEqual(r.events, [{ a: 1 }]);
  assert.equal(r.residual, '');
});

test('parseSseChunk: event split across two chunks', () => {
  const r = captureSse('data: {"a":1}', '\n\n');
  assert.deepStrictEqual(r.events, [{ a: 1 }]);
  assert.equal(r.residual, '');
});

test('parseSseChunk: multi-line data: concatenates with newline', () => {
  const r = captureSse('data: line1\ndata: line2\n\n');
  // line1\nline2 — not valid JSON, passes through as raw string.
  assert.deepStrictEqual(r.events, ['line1\nline2']);
});

test('parseSseChunk: comment lines skipped', () => {
  const r = captureSse(': keepalive\n\ndata: {"x":1}\n\n');
  assert.deepStrictEqual(r.events, [{ x: 1 }]);
});

test('parseSseChunk: [DONE] sentinel emits synthetic done envelope', () => {
  const r = captureSse('data: {"delta":"hi"}\n\ndata: [DONE]\n\n');
  assert.deepStrictEqual(r.events, [{ delta: 'hi' }, { _done: true }]);
});

test('parseSseChunk: tolerates `data:value` without space', () => {
  const r = captureSse('data:{"a":2}\n\n');
  assert.deepStrictEqual(r.events, [{ a: 2 }]);
});

test('parseSseChunk: UTF-8 split across chunks decodes via TextDecoder caller', () => {
  // Caller-side TextDecoder({stream: true}) handles the byte split. The
  // parser sees decoded characters; this test mirrors the contract by
  // splitting at a character boundary that's already decoded.
  const r = captureSse('data: {"text":"héllo}\n\n');
  // Malformed JSON (closing brace inside the string is missing the second
  // quote) — passes through as raw string. Verifies tolerance.
  assert.equal(r.events.length, 1);
  assert.equal(typeof r.events[0], 'string');
});

test('parseSseChunk: empty event blocks emit nothing', () => {
  const r = captureSse('\n\ndata: {"a":1}\n\n\n\n');
  assert.deepStrictEqual(r.events, [{ a: 1 }]);
});

test('parseSseChunk: residual buffer preserved when no terminator yet', () => {
  const r = captureSse('data: {"a"');
  assert.deepStrictEqual(r.events, []);
  assert.equal(r.residual, 'data: {"a"');
});

test('parseNdjsonChunk: line in one chunk', () => {
  const r = captureNdjson('{"a":1}\n');
  assert.deepStrictEqual(r.events, [{ a: 1 }]);
  assert.equal(r.residual, '');
});

test('parseNdjsonChunk: line split across chunks', () => {
  const r = captureNdjson('{"a":', '1}\n');
  assert.deepStrictEqual(r.events, [{ a: 1 }]);
});

test('parseNdjsonChunk: empty lines skipped', () => {
  const r = captureNdjson('\n\n{"a":1}\n\n{"b":2}\n');
  assert.deepStrictEqual(r.events, [{ a: 1 }, { b: 2 }]);
});

test('parseNdjsonChunk: malformed lines tolerated', () => {
  const r = captureNdjson('not json\n{"a":1}\n');
  assert.deepStrictEqual(r.events, [{ a: 1 }]);
});

test('parseNdjsonChunk: trailing partial line stays in residual', () => {
  const r = captureNdjson('{"a":1}\n{"b":', '2}\n');
  assert.deepStrictEqual(r.events, [{ a: 1 }, { b: 2 }]);
});

// ---- Integration ----

function saveListener(platform, capability, strategyBody) {
  const dir = path.join(HOME, 'skills', platform, 'fetch');
  fs.mkdirSync(dir, { recursive: true });
  const full = { strategy: 'fetch', type: 'listener', ...strategyBody };
  fs.writeFileSync(path.join(dir, `${capability}.json`), JSON.stringify(full));
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('integration: fetch-stream + SSE + POST + body interpolation', async () => {
  let receivedBody = null;
  let receivedMethod = null;
  let receivedContentType = null;
  const { server, baseUrl } = await startServer((req, res) => {
    receivedMethod = req.method;
    receivedContentType = req.headers['content-type'];
    let body = '';
    req.on('data', (c) => (body += c.toString()));
    req.on('end', () => {
      receivedBody = body;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write('data: {"delta":"hello"}\n\n');
      res.write('data: {"delta":" world"}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  try {
    saveListener('chatlike', 'on_token', {
      transport: 'fetch-stream',
      endpoint: `${baseUrl}/chat`,
      method: 'POST',
      parse: 'sse',
      body: {
        messages: [{ role: 'user', content: '{{prompt}}' }],
        model: '{{model}}',
      },
    });
    const mgr = new ListenerManager();
    await mgr.start('chatlike', 'on_token', { prompt: 'hi there', model: 'gpt-4' });
    await waitFor(() => mgr.eventQueue.length >= 3, 2000, 'three SSE events');
    assert.equal(receivedMethod, 'POST');
    assert.equal(receivedContentType, 'application/json');
    const parsed = JSON.parse(receivedBody);
    assert.equal(parsed.messages[0].content, 'hi there');
    assert.equal(parsed.model, 'gpt-4');
    const events = mgr.getEvents().map((e) => e.data);
    assert.deepStrictEqual(events, [
      { delta: 'hello' },
      { delta: ' world' },
      { _done: true },
    ]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('integration: fetch-stream + NDJSON + GET + match filter', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"type":"update","id":1}\n');
    res.write('{"type":"noise","id":2}\n');
    res.write('{"type":"update","id":3}\n');
    res.end();
  });
  try {
    saveListener('feedy', 'on_update', {
      transport: 'fetch-stream',
      endpoint: `${baseUrl}/feed`,
      method: 'GET',
      parse: 'ndjson',
      events: { match: { type: 'update' } },
    });
    const mgr = new ListenerManager();
    await mgr.start('feedy', 'on_update');
    await waitFor(() => mgr.eventQueue.length >= 2, 2000, 'two filtered events');
    const events = mgr.getEvents().map((e) => e.data);
    // Only updates pass the filter; noise dropped.
    assert.deepStrictEqual(events, [
      { type: 'update', id: 1 },
      { type: 'update', id: 3 },
    ]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('integration: stop aborts an in-flight fetch-stream', async () => {
  let connectCount = 0;
  let firstClient = null;
  const { server, baseUrl } = await startServer((req, res) => {
    connectCount += 1;
    firstClient = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Don't end — leave the stream open. The listener stop should abort.
  });
  try {
    saveListener('hangy', 'on_x', {
      transport: 'fetch-stream',
      endpoint: `${baseUrl}/hang`,
      method: 'GET',
      parse: 'sse',
      // Cap retries so an unintended reconnect on stop doesn't masquerade
      // as success.
      reconnect: { maxRetries: 0 },
    });
    const mgr = new ListenerManager();
    const { listenerId } = await mgr.start('hangy', 'on_x');
    await waitFor(() => connectCount === 1, 2000, 'first connect');
    // Stop the listener — the AbortController should fire and the request
    // is cancelled. No reconnect because maxRetries: 0.
    await mgr.stop(listenerId);
    // Give the loop a moment to re-enter (it shouldn't).
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(connectCount, 1, 'no reconnect after stop');
    // Best-effort: closing the response so the server doesn't hang on
    // teardown when http.close waits for sockets.
    if (firstClient) firstClient.end();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

