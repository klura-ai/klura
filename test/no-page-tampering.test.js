// Regression guard for the no-page-tampering invariant: the built-in driver
// must leave the page byte-identical to a normal browser — native WebSocket /
// WebSocket.prototype.send / history.pushState, and ZERO `__klura*` globals.
// This is what lets klura pass managed browser challenges via
// connect mode without re-flagging the page.
//
// Also asserts same-document (History API) navigation capture still works over
// CDP (Page.navigatedWithinDocument) now that the history.pushState patch is
// gone.
//
// Boots a real Chrome. Skips gracefully (rather than failing) when Chrome or
// network isn't available — most of the suite mocks the driver; this one can't.

import test from 'node:test';
import assert from 'node:assert';

const { PlaywrightDriver } = await import('../dist/drivers/playwright.js');

let driver;
let session;
let probe;
let navs;
let setupErr = null;

try {
  driver = new PlaywrightDriver({ channel: 'chrome', headful: false });
  session = await driver.createSession({});
  await driver.navigate(session, 'https://example.com', { waitUntil: 'domcontentloaded' });
  probe = await driver.evaluateExpression(
    session,
    `(() => ({
      ws: window.WebSocket.toString().includes('[native code]'),
      send: WebSocket.prototype.send.toString().includes('[native code]'),
      histPush: history.pushState.toString().includes('[native code]'),
      histReplace: history.replaceState.toString().includes('[native code]'),
      klura: Object.getOwnPropertyNames(window).filter((k) => k.indexOf('__klura') === 0),
    }))()`,
    { timeoutMs: 10000 },
  );
  // Same-document nav capture: a pushState and a hash change should land in
  // pendingNavs with the right `via` tags, captured via CDP (no page patch).
  await driver.evaluateExpression(session, `history.pushState({}, '', '/deep/link')`, {
    timeoutMs: 5000,
  });
  await driver.evaluateExpression(session, `location.hash = 'section'`, { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 300));
  navs = await driver.consumePendingNavs(session);
} catch (err) {
  setupErr = err;
} finally {
  try {
    if (session) await driver.destroySession(session);
  } catch {
    /* ignore */
  }
  try {
    if (driver) await driver.closeBrowser();
  } catch {
    /* ignore */
  }
}

const skip = setupErr ? `browser/network unavailable: ${setupErr.message}` : false;

test('built-in driver leaves the page byte-identical to real Chrome', { skip }, () => {
  assert.ok(probe.ws, 'window.WebSocket must be native');
  assert.ok(probe.send, 'WebSocket.prototype.send must be native');
  assert.ok(probe.histPush, 'history.pushState must be native');
  assert.ok(probe.histReplace, 'history.replaceState must be native');
  assert.deepStrictEqual(probe.klura, [], `no __klura* globals; got ${JSON.stringify(probe.klura)}`);
});

test('same-document navigations are captured over CDP and tagged pushState', { skip }, () => {
  // Same-doc navs (pushState + hashchange) are captured via CDP
  // Page.navigatedWithinDocument and tagged via:'pushState' (the finer
  // distinction is cosmetic — NAV_ONLY_VIAS treats them identically).
  assert.ok(
    navs.some((n) => n.via === 'pushState' && n.url.endsWith('/deep/link')),
    `expected a pushState nav to /deep/link; got ${JSON.stringify(navs)}`,
  );
  assert.ok(
    navs.some((n) => n.via === 'pushState' && n.url.includes('#section')),
    `expected the #section same-doc nav tagged pushState; got ${JSON.stringify(navs)}`,
  );
});
