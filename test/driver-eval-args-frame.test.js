// Integration tests for driver.evaluateExpression's `args` and `frame` options.
// Exercises the real Playwright driver against a fixture page so the IIFE
// wrapping, parameter passing, and contentFrame resolution are end-to-end
// covered. Skips when chromium isn't installed (mirrors driver-popups).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-driver-eval-args-frame-'));
process.env.KLURA_HOME = TMP;

const klura = await import('../dist/index.js');
const { pool } = await import('../dist/runtime-state.js');

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
  // Parent page exposes `window.signMain` (just echoes its args). It also
  // embeds an iframe at /child.html that exposes `window.signFrame` returning
  // a marker plus the args — letting the test prove the eval ran inside the
  // iframe context, not the parent.
  const main = `<!DOCTYPE html>
<html><head><title>main</title></head>
<body>
<iframe id="kid" src="/child.html"></iframe>
<script>
window.signMain = (args) => 'main:' + JSON.stringify(args);
</script>
</body></html>`;
  const child = `<!DOCTYPE html>
<html><head><title>child</title></head>
<body>
<div id="here">in-iframe</div>
<script>
window.signFrame = (args) => 'frame:' + JSON.stringify(args);
</script>
</body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(main);
    } else if (req.url === '/child.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(child);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function maybeStartSession(url) {
  try {
    return await klura.startSession(url, {});
  } catch (err) {
    return { _startFailed: String(err) };
  }
}

test('integration: evaluateExpression exposes `args` to the expression', async (t) => {
  const { server, url } = await startFixtureServer();
  try {
    const started = await maybeStartSession(url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const session = pool.getSession(started.sessionId);
    const driver = pool.driverFor(session.id);

    // Expression-body form: agent calls a page-side function with args.body.
    const out = await driver.evaluateExpression(
      session,
      'window.signMain({body: args.body, ts: args.ts})',
      { timeoutMs: 3000, args: { body: 'hello', ts: 1700000000 } },
    );
    assert.strictEqual(out, 'main:{"body":"hello","ts":1700000000}');
  } finally {
    server.close();
  }
});

test('integration: evaluateExpression with omitted args leaves `args` undefined', async (t) => {
  const { server, url } = await startFixtureServer();
  try {
    const started = await maybeStartSession(url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const session = pool.getSession(started.sessionId);
    const driver = pool.driverFor(session.id);

    const out = await driver.evaluateExpression(session, 'typeof args', { timeoutMs: 3000 });
    assert.strictEqual(out, 'undefined');
  } finally {
    server.close();
  }
});

test('integration: evaluateExpression with frame: <selector> evaluates inside the iframe', async (t) => {
  const { server, url } = await startFixtureServer();
  try {
    const started = await maybeStartSession(url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const session = pool.getSession(started.sessionId);
    const driver = pool.driverFor(session.id);

    // window.signFrame only exists in the child iframe; if the eval ran in
    // the main frame this would throw with `signFrame is not defined`.
    const out = await driver.evaluateExpression(
      session,
      'window.signFrame({tok: args.tok})',
      { timeoutMs: 3000, frame: '#kid', args: { tok: 'cf-123' } },
    );
    assert.strictEqual(out, 'frame:{"tok":"cf-123"}');

    // Cross-check: window.signMain exists in the parent only — calling it
    // through the frame target must throw, proving we really evaluated
    // inside the iframe and not in the main frame as a fallback.
    await assert.rejects(
      () =>
        driver.evaluateExpression(session, 'window.signMain({})', {
          timeoutMs: 3000,
          frame: '#kid',
        }),
      /signMain/,
    );
  } finally {
    server.close();
  }
});

test('integration: evaluateExpression with bogus frame selector errors with the selector text', async (t) => {
  const { server, url } = await startFixtureServer();
  try {
    const started = await maybeStartSession(url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const session = pool.getSession(started.sessionId);
    const driver = pool.driverFor(session.id);

    await assert.rejects(
      () =>
        driver.evaluateExpression(session, 'window.signMain({})', {
          timeoutMs: 1500,
          frame: 'iframe[src*="not-a-real-frame"]',
        }),
      /not-a-real-frame|did not resolve/,
    );
  } finally {
    server.close();
  }
});
