// Integration tests for popup / multi-tab tracking. Hits a real Playwright
// browser through klura's tool surface so the full path is exercised:
// `context.on('page')` → driver-private map → `session.subPages` → the
// `page` opt on `perform_action`.
//
// The fixture server serves a main page that opens a popup via window.open()
// and a popup page that mutates a DOM marker. The test asserts:
//   - opening a popup grows session.subPages with id "popup-1"
//   - `perform_action(page: 'popup-1')` lands inside the popup
//   - closing the popup stamps closedAt and rejects subsequent actions
//   - a second popup uses id "popup-2" — handles never reuse
//
// Skips when chromium isn't installed (mirrors debugger-surface.test.js).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-popups-'));
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
  const main = `<!DOCTYPE html>
<html><head><title>main</title></head>
<body>
<button id="open">Open popup</button>
<button id="open2">Open another</button>
<script>
document.getElementById('open').addEventListener('click', () => {
  window.open('/popup.html', 'popup', 'width=400,height=400');
});
document.getElementById('open2').addEventListener('click', () => {
  window.open('/popup2.html', 'popup2', 'width=400,height=400');
});
</script>
</body></html>`;
  const popup = `<!DOCTYPE html>
<html><head><title>popup-page</title></head>
<body>
<button id="confirm">Confirm</button>
<div id="status">idle</div>
<script>
document.getElementById('confirm').addEventListener('click', () => {
  document.getElementById('status').textContent = 'confirmed';
});
</script>
</body></html>`;
  const popup2 = `<!DOCTYPE html>
<html><head><title>popup-page-2</title></head>
<body>
<div id="marker">second</div>
</body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(main);
    } else if (req.url === '/popup.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(popup);
    } else if (req.url === '/popup2.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(popup2);
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

// Wait until `predicate(session)` returns truthy or `timeoutMs` elapses.
// Polls the in-memory session object — the runtime mutates `session.subPages`
// synchronously from the popup-capture listener, but `context.on('page')`
// itself fires asynchronously after the click triggers window.open.
async function waitFor(session, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(session)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate(session);
}

test('integration: popup tracking — open, address, close, re-open', async (t) => {
  const { server, url } = await startFixtureServer();
  try {
    const started = await maybeStartSession(url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const sessionId = started.sessionId;
    const session = pool.getSession(sessionId);

    // Pre-condition: no popups, just main.
    assert.deepStrictEqual(session.subPages ?? [], [], 'expected empty subPages at session start');

    // Click the main page's "Open popup" button. The window.open fires
    // asynchronously from the click handler, so wait for the listener to
    // populate subPages.
    const r1 = await klura.performAction(sessionId, 'click', '#open', undefined, {
      returnTree: false,
    });
    await waitFor(session, (s) => (s.subPages ?? []).length >= 1);

    assert.ok(session.subPages, 'expected session.subPages populated');
    assert.strictEqual(session.subPages.length, 1, 'expected one tracked popup');
    const popup1 = session.subPages[0];
    assert.strictEqual(popup1.id, 'popup-1', 'expected first popup to be popup-1');
    assert.strictEqual(popup1.openerId, 'main', 'expected main to be the opener');
    assert.ok(popup1.openedAt > 0, 'expected openedAt timestamp');
    assert.strictEqual(popup1.closedAt, undefined, 'expected popup1 to be open');

    // The action response should echo subPages so the agent sees the popup
    // appear without a separate list call.
    assert.ok(Array.isArray(r1.subPages), 'expected ActionResult.subPages on the click response');
    assert.strictEqual(r1.subPages.length, 1);
    assert.strictEqual(r1.subPages[0].id, 'popup-1');

    // Address the popup: click "Confirm" inside it. The handler mutates
    // #status to "confirmed". Read it back via get_attribute to prove the
    // click landed in the popup, not the main page.
    await klura.performAction(sessionId, 'click', '#confirm', undefined, {
      returnTree: false,
      page: 'popup-1',
    });
    const driver = pool.driverFor(sessionId);
    const popupStatus = await driver.getText(session, '#status', { page: 'popup-1' });
    assert.strictEqual(popupStatus, 'confirmed', 'expected the popup-1 click to mutate popup DOM');
    // Sanity: the main page has no #status element. getText returns ''
    // when the locator times out — we expect the rejection here, not a
    // string from the popup.
    await assert.rejects(
      driver.getText(session, '#status'),
      /Timeout|locator/,
      'expected #status on main page to be missing (proves popup-1 click was not on main)',
    );

    // Unknown page handle rejects with a shape error citing open handles.
    await assert.rejects(
      klura.performAction(sessionId, 'click', '#confirm', undefined, {
        returnTree: false,
        page: 'popup-99',
      }),
      /unknown page handle/,
    );

    // Close the popup from the host side and assert closedAt lands.
    const driverInternal = pool.driverFor(sessionId);
    // Driver-private close: walk the WeakMap-of-Maps via a real action — the
    // simplest way is to evaluate window.close() inside the popup itself.
    await driverInternal.evaluateExpression(session, 'window.close()', {
      timeoutMs: 2000,
      page: 'popup-1',
    });
    await waitFor(session, (s) => (s.subPages ?? [])[0]?.closedAt !== undefined);
    assert.ok(session.subPages[0].closedAt, 'expected closedAt to be set after window.close');

    // Subsequent action against popup-1 rejects because it's closed.
    await assert.rejects(
      klura.performAction(sessionId, 'click', '#confirm', undefined, {
        returnTree: false,
        page: 'popup-1',
      }),
      /is closed/,
    );

    // Open another popup → must be popup-2, not a reused popup-1. The
    // closed entry stays in subPages so addressing semantics are stable.
    await klura.performAction(sessionId, 'click', '#open2', undefined, {
      returnTree: false,
    });
    await waitFor(session, (s) => (s.subPages ?? []).length >= 2);
    assert.strictEqual(session.subPages.length, 2);
    assert.strictEqual(session.subPages[0].id, 'popup-1', 'closed popup-1 entry stays put');
    assert.strictEqual(session.subPages[1].id, 'popup-2', 'next popup gets popup-2, not popup-1');
    assert.strictEqual(session.subPages[1].closedAt, undefined);

    await klura.closeSession(sessionId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('resolvePageHandle: rejects unknown handle with open-list hint', async () => {
  // Pure-shape test — no browser needed. Validates the error format the
  // integration test's "unknown page handle" path sees.
  const { resolvePageHandle } = await import('../dist/tools/perform-action.js');
  const session = {
    id: 'sess_x',
    intercepted: [],
    intercepting: false,
    subPages: [
      {
        id: 'popup-1',
        url: 'about:blank',
        openerId: 'main',
        openedAt: Date.now(),
      },
      {
        id: 'popup-2',
        url: 'about:blank',
        openerId: 'main',
        openedAt: Date.now(),
        closedAt: Date.now() + 1,
      },
    ],
  };
  // Default and "main" both pass.
  assert.strictEqual(resolvePageHandle(session, undefined), 'main');
  assert.strictEqual(resolvePageHandle(session, 'main'), 'main');
  assert.strictEqual(resolvePageHandle(session, ''), 'main');
  // Open popup is allowed.
  assert.strictEqual(resolvePageHandle(session, 'popup-1'), 'popup-1');
  // Closed popup is rejected explicitly.
  assert.throws(() => resolvePageHandle(session, 'popup-2'), /is closed/);
  // Unknown handle is rejected with the open list — popup-1 only (popup-2 is closed).
  assert.throws(() => resolvePageHandle(session, 'popup-99'), /unknown page handle.*popup-1/s);
});
