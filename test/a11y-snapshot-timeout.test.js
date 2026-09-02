import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-a11y-timeout-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const { PlaywrightDriver } = await import('../dist/drivers/playwright.js');
const { startSession } = await import('../dist/index.js');
const { pool } = await import('../dist/runtime-state/index.js');

const A11Y_SNAPSHOT_TIMEOUT_MS = 10_000;

class StubPlaywrightDriver extends PlaywrightDriver {
  constructor(page) {
    super({ channel: 'chromium' });
    this.page = page;
  }

  _page() {
    return this.page;
  }
}

function session(id) {
  return {
    id,
    intercepted: [],
    intercepting: false,
  };
}

test('native ariaSnapshot timeout falls back to an inert DOM tree without real waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let contentCalls = 0;
  const never = new Promise(() => {});
  const page = {
    locator(selector) {
      assert.equal(selector, ':root');
      return { ariaSnapshot: () => never };
    },
    content: async () => {
      contentCalls += 1;
      return '<main><h1>Fallback ready</h1></main>';
    },
  };
  const driver = new StubPlaywrightDriver(page);
  const fakeSession = session('sess-a11y-fallback');

  const pending = driver.getAccessibilityTree(fakeSession);
  t.mock.timers.tick(A11Y_SNAPSHOT_TIMEOUT_MS);
  const tree = await pending;

  assert.match(tree, /Fallback ready/);
  assert.equal(contentCalls, 1);
  assert.equal(fakeSession.accessibilitySnapshot?.source, 'static_dom');
  assert.match(fakeSession.accessibilitySnapshot?.warning ?? '', /native accessibility snapshot/i);
});

test('a never-resolving native snapshot rejects on its synthetic deadline when fallback fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = new Promise(() => {});
  const page = {
    locator: () => ({ ariaSnapshot: () => never }),
    content: async () => {
      throw new Error('synthetic content failure');
    },
  };
  const driver = new StubPlaywrightDriver(page);
  const fakeSession = session('sess-a11y-unavailable');

  const pending = driver.getAccessibilityTree(fakeSession);
  const rejection = assert.rejects(
    pending,
    /native accessibility snapshot and inert serialized-DOM fallback both failed/i,
  );

  t.mock.timers.tick(A11Y_SNAPSHOT_TIMEOUT_MS);
  await rejection;

  assert.equal(fakeSession.accessibilitySnapshot?.source, 'unavailable');
  assert.match(
    fakeSession.accessibilitySnapshot?.warning ?? '',
    /get_accessibility_tree:native_snapshot: timed out after 10000ms/,
  );
  assert.match(fakeSession.accessibilitySnapshot?.warning ?? '', /synthetic content failure/);
});

test('start_session keeps the navigated session usable when accessibility is unavailable', async () => {
  const fakeDriver = {
    navigate: async () => {},
    getAccessibilityTree: async () => {
      throw new Error('synthetic snapshot failure');
    },
    getUrl: async () => 'https://x.example/landing',
    consumePendingNavs: async () => [],
    captureFormSummary: async () => [],
  };
  const fakeSession = {
    id: 'sess-start-a11y-unavailable',
    intercepted: [],
    intercepting: false,
    domNavigations: [],
    domFormsObserved: [],
    visitedUrls: [],
  };
  const originalCreate = pool.createSession;
  const originalDriver = pool.driverFor;
  pool.createSession = async () => fakeSession;
  pool.driverFor = (id) => (id === fakeSession.id ? fakeDriver : originalDriver.call(pool, id));

  try {
    const result = await startSession('https://x.example/start');

    assert.equal(result.sessionId, fakeSession.id);
    assert.equal(result.url, 'https://x.example/landing');
    assert.equal(result.a11yTree, '');
    assert.equal(result.a11y_snapshot?.source, 'unavailable');
    assert.match(result.a11y_snapshot?.warning ?? '', /session is still live/i);
    assert.equal(fakeSession.status, 'active');
  } finally {
    pool.createSession = originalCreate;
    pool.driverFor = originalDriver;
  }
});
