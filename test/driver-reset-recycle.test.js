// resetSession must leave no logical per-session state in the extras bundle
// a warm lease carries between klura sessions: armed debugger state (an
// inherited pause would freeze the recycled page at a stop no consumer is
// waiting on), pending dom-navigation entries (they would pollute the next
// session's url_graph), and the js-source cache.
//
// The unit leg pins the ordering contract without a browser; the integration
// leg (skipped when chromium is unavailable) drives the real reset against a
// live context.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

const { PlaywrightDriver } = await import('../dist/drivers/playwright.js');

class Probe extends PlaywrightDriver {
  cleanupDebuggerCalls = 0;
  async cleanupDebuggerState(session) {
    this.cleanupDebuggerCalls += 1;
    return super.cleanupDebuggerState(session);
  }
}

test('resetSession runs debugger cleanup before touching browser state', async () => {
  const driver = new Probe({});
  // A session with no attached browser bindings: the debugger teardown must
  // run first (idempotent no-op here) — resetting a lease that arrives
  // paused cannot depend on a responsive page, so the cleanup precedes any
  // context/page access (which throws for this unbound shell).
  const shell = { id: 'sess_shell', intercepted: [], intercepting: false };
  await assert.rejects(driver.resetSession(shell));
  assert.strictEqual(driver.cleanupDebuggerCalls, 1, 'debugger cleanup ran before the throw');
});

async function startFixtureServer() {
  const html = `<!doctype html><html><body><h1>reset fixture</h1><script src="/app.js"></script></body></html>`;
  const js = `window.__k = () => 1;\n`;
  const server = http.createServer((req, res) => {
    if (req.url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(js);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/`, jsUrl: `http://127.0.0.1:${port}/app.js` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('integration: resetSession clears armed debugger state and pending navs', async (t) => {
  const { server, url, jsUrl } = await startFixtureServer();
  const driver = new Probe({});
  let session;
  try {
    session = await driver.createSession({});
  } catch (err) {
    await new Promise((resolve) => server.close(resolve));
    t.skip(`browser unavailable: ${err}`);
    return;
  }
  try {
    await driver.navigate(session, url);

    // Arm the debugger surface (enables the Debugger domain + registers a
    // breakpoint the reset must tear down).
    await driver.setBreakpoint(session, { file: jsUrl, line: 0 });
    const armed = await driver.listBreakpoints(session);
    assert.strictEqual(armed.length, 1, 'breakpoint armed');

    // Same-document navigation → pendingNavs entry via the nav capture.
    await driver.evaluateExpression(session, 'history.pushState({}, "", "/pushed")', {
      timeoutMs: 5000,
    });
    await sleep(300);
    const before = await driver.consumePendingNavs(session);
    assert.ok(
      before.some((n) => n.url.endsWith('/pushed')),
      `expected a pending nav for /pushed, got ${JSON.stringify(before)}`,
    );

    // Re-seed a pending nav, then recycle.
    await driver.evaluateExpression(session, 'history.pushState({}, "", "/pushed2")', {
      timeoutMs: 5000,
    });
    await sleep(300);
    const preCleanup = driver.cleanupDebuggerCalls;
    await driver.resetSession(session);

    assert.ok(driver.cleanupDebuggerCalls > preCleanup, 'reset ran the debugger cleanup');
    const bpsAfter = await driver.listBreakpoints(session);
    assert.deepStrictEqual(bpsAfter, [], 'no breakpoints survive a recycle');
    const navsAfter = await driver.consumePendingNavs(session);
    assert.deepStrictEqual(navsAfter, [], 'no pending navs survive a recycle');
  } finally {
    try {
      await driver.destroySession(session);
    } catch {}
    try {
      await driver.closeBrowser();
    } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
});
