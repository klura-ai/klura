// Integration test: a fetch fired from inside `evaluateExpression` (the
// js_eval engine) lands in `session.intercepted` even after navigation.
//
// The mocked CDP unit suite (cdp-network-capture.test.js) covers the
// in-handler filter. This file covers the lifecycle seam — the CDP session
// attached at session-create time must keep firing events for the live
// page, including after same-origin and cross-origin top-level navigations.
// Skips when chromium isn't installed (mirrors driver-eval-args-frame).
//
// Bauhaus repro shape: the agent does start_session → perform_action +
// js_eval probes; a direct `fetch(...)` from js_eval was disappearing from
// `get_network_log` after the page had navigated.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-jsev-net-cap-'));
process.env.KLURA_HOME = TMP;

const klura = await import('../dist/index.js');
const { pool } = await import('../dist/runtime-state/index.js');

test.after(async () => {
  try {
    const p = klura._pool;
    if (p && typeof p.shutdown === 'function') await p.shutdown();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function startFixtureServer() {
  const html = `<!DOCTYPE html>
<html><head><title>fixture</title></head>
<body><div id="here">fixture-page</div></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html' || req.url === '/page2') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else if (req.url?.startsWith('/data')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port, url: `http://127.0.0.1:${port}/` };
}

async function maybeStartSession(url) {
  try {
    return await klura.startSession(url, {});
  } catch (err) {
    return { _startFailed: String(err) };
  }
}

function findEntry(intercepted, urlSubstr) {
  return intercepted.find((e) => typeof e?.url === 'string' && e.url.includes(urlSubstr));
}

test('integration: js_eval fetch on initial page → captured', async (t) => {
  const fixture = await startFixtureServer();
  try {
    const started = await maybeStartSession(fixture.url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const session = pool.getSession(started.sessionId);
    const driver = pool.driverFor(session.id);

    const out = await driver.evaluateExpression(
      session,
      'await fetch("/data?case=initial").then((r) => r.json())',
      { timeoutMs: 5000 },
    );
    assert.deepStrictEqual(out, { ok: true, url: '/data?case=initial' });

    // Tiny tick so loadingFinished's async getResponseBody settles.
    await new Promise((r) => setTimeout(r, 50));
    const entry = findEntry(session.intercepted, '/data?case=initial');
    assert.ok(
      entry,
      `expected /data?case=initial in session.intercepted; got ${JSON.stringify(
        session.intercepted.map((e) => e?.url),
      )}`,
    );
  } finally {
    fixture.server.close();
  }
});

test('integration: js_eval fetch after same-origin navigation → captured', async (t) => {
  const fixture = await startFixtureServer();
  try {
    const started = await maybeStartSession(fixture.url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const session = pool.getSession(started.sessionId);
    const driver = pool.driverFor(session.id);

    // Same-origin nav (same host:port, different path).
    await driver.navigate(session, `${fixture.url}page2`);

    const out = await driver.evaluateExpression(
      session,
      'await fetch("/data?case=same-origin").then((r) => r.json())',
      { timeoutMs: 5000 },
    );
    assert.deepStrictEqual(out, { ok: true, url: '/data?case=same-origin' });

    await new Promise((r) => setTimeout(r, 50));
    const entry = findEntry(session.intercepted, '/data?case=same-origin');
    assert.ok(
      entry,
      `expected /data?case=same-origin in session.intercepted after same-origin nav; got ${JSON.stringify(
        session.intercepted.map((e) => e?.url),
      )}`,
    );
  } finally {
    fixture.server.close();
  }
});

test('integration: js_eval fetch after cross-origin navigation → captured', async (t) => {
  const fixtureA = await startFixtureServer();
  const fixtureB = await startFixtureServer();
  try {
    const started = await maybeStartSession(fixtureA.url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const session = pool.getSession(started.sessionId);
    const driver = pool.driverFor(session.id);

    // Cross-origin nav: different port → different origin per browser
    // policy. Page-target may swap on cross-origin top-level nav (new
    // render process), which is the lifecycle edge this test pins down.
    await driver.navigate(session, fixtureB.url);

    const out = await driver.evaluateExpression(
      session,
      'await fetch("/data?case=cross-origin").then((r) => r.json())',
      { timeoutMs: 5000 },
    );
    assert.deepStrictEqual(out, { ok: true, url: '/data?case=cross-origin' });

    await new Promise((r) => setTimeout(r, 100));
    const entry = findEntry(session.intercepted, '/data?case=cross-origin');
    assert.ok(
      entry,
      `expected /data?case=cross-origin in session.intercepted after cross-origin nav; got ${JSON.stringify(
        session.intercepted.map((e) => e?.url),
      )}`,
    );
  } finally {
    fixtureA.server.close();
    fixtureB.server.close();
  }
});
