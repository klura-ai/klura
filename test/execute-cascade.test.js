// Unit tests for the revisit-fallback partial-replay ladder (#37).
//
// The full `execute()` pipeline pulls in the browser pool (requires
// playwright), so these tests exercise `replayRecordedPathToAnchor`
// directly with a stub pool + driver and assert the anchor-matching
// contract. Integration coverage for the cascade glue lives in
// field-reports; here we cover the pure replay-to-anchor slice and the
// error shapes when the anchor is absent / renamed.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-exec-cascade-'));
process.env.KLURA_HOME = TMP;
fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({ pool: { driver: 'playwright' } }),
);

const { replayRecordedPathToAnchor } = await import('../dist/execution/recorded-path.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeStubPool(onClickThrow) {
  const stepsRun = [];
  const session = { id: 'sess_stub', platform: 'cascade-test', device: 'default' };
  const driver = {
    async delay() {},
    async navigate(_s, url) {
      stepsRun.push({ action: 'navigate', url });
    },
    async click(_s, locator) {
      stepsRun.push({ action: 'click', locator });
      if (onClickThrow && onClickThrow(locator)) throw new Error('selector not found');
    },
    async type(_s, locator, value) {
      stepsRun.push({ action: 'type', locator, value });
    },
    async fillEditor(_s, locator, value) {
      stepsRun.push({ action: 'fill_editor', locator, value });
    },
    async keyPress(_s, key) {
      stepsRun.push({ action: 'key_press', key });
    },
    async saveStorageState() {},
    async resolveLocatorCandidate(_s, locator) {
      // Runner calls this to turn {a11y, css} into a concrete selector; stub
      // returns whatever CSS was declared so the click branch sees it.
      if (locator?.css) return locator.css;
      if (locator?.a11y) return `role=${locator.a11y.role}[name=${JSON.stringify(locator.a11y.name ?? '')}]`;
      return '';
    },
    async resolveLocator(_s, locator) {
      return this.resolveLocatorCandidate(_s, locator);
    },
  };
  const pool = {
    stepsRun,
    session,
    async createSession() {
      return session;
    },
    driverFor() {
      return driver;
    },
    async endDrive() {},
    getSession() {
      return session;
    },
  };
  return pool;
}

function strategyWith(steps) {
  return {
    strategy: 'recorded-path',
    steps,
  };
}

test('replayRecordedPathToAnchor: skips when anchor id not found', async () => {
  const pool = makeStubPool();
  const strat = strategyWith([
    { id: 'navigate_home', action: 'navigate', url: 'https://example.com' },
    { id: 'click_send', action: 'click', locators: { css: 'button.send' } },
  ]);
  const res = await replayRecordedPathToAnchor(
    strat,
    'click_publish',
    {},
    'cascade-test',
    'send',
    pool,
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'anchor_not_found');
  assert.equal(pool.stepsRun.length, 0, 'no steps should have been run');
});

test('replayRecordedPathToAnchor: replays 0..anchor inclusive', async () => {
  const pool = makeStubPool();
  const strat = strategyWith([
    { id: 'navigate_home', action: 'navigate', url: 'https://example.com' },
    { id: 'click_compose', action: 'click', locators: { css: 'button.compose' } },
    { id: 'type_message', action: 'type', locators: { css: 'textarea' }, value: 'hi' },
    { id: 'click_send', action: 'click', locators: { css: 'button.send' } },
  ]);
  const res = await replayRecordedPathToAnchor(
    strat,
    'type_message',
    {},
    'cascade-test',
    'send',
    pool,
  );
  assert.equal(res.ok, true);
  // Steps 0..2 (navigate, click_compose, type_message) — click_send must NOT
  // run because the anchor is type_message.
  assert.equal(pool.stepsRun.length, 3);
  assert.equal(pool.stepsRun[0].action, 'navigate');
  assert.equal(pool.stepsRun[1].action, 'click');
  assert.equal(pool.stepsRun[2].action, 'type');
});

test('replayRecordedPathToAnchor: step failure returns step_failed reason', async () => {
  const pool = makeStubPool((loc) => typeof loc === 'string' && loc.includes('compose'));
  const strat = strategyWith([
    { id: 'navigate_home', action: 'navigate', url: 'https://example.com' },
    { id: 'click_compose', action: 'click', locators: { css: 'button.compose' } },
    { id: 'click_send', action: 'click', locators: { css: 'button.send' } },
  ]);
  const res = await replayRecordedPathToAnchor(
    strat,
    'click_send',
    {},
    'cascade-test',
    'send',
    pool,
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /step_failed/);
});
