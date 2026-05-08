// Unit-level tests for the popup-tracking shape contracts:
//   - recorded-path step.page validator (accepts main / popup-N, rejects
//     malformed handles)
//   - saveStrategyAudit's `popup_addressing_without_trigger` Detector
//     (warns when a saved strategy targets popups the discovery session
//      never observed)
//
// Real-Playwright integration coverage of the runtime tracking lives in
// runtime/test/driver-popups.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate KLURA_HOME so the user's local config.json (pool.driver, etc.)
// doesn't leak in. We never spin up a pool here — these are pure-shape
// tests against the audit + validator — but loading dist/audit transitively
// imports modules that try to resolve config-declared driver packages.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-popups-shape-'));
process.env.KLURA_HOME = TMP;
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { validateRecordedPathStepShape } = await import(
  '../dist/strategies/validate/recorded-path.js'
);
const { saveStrategyAudit } = await import('../dist/audit/lift/save-strategy.js');

// ---------- Step shape: page field ----------

test('step.page accepts "main" and popup-N handles', () => {
  for (const page of ['main', 'popup-1', 'popup-2', 'popup-12']) {
    assert.doesNotThrow(
      () =>
        validateRecordedPathStepShape(0, {
          id: 'click_thing',
          action: 'click',
          page,
          locators: { a11y: { role: 'button', name: 'Allow' } },
        }),
      `expected step.page = ${JSON.stringify(page)} to be accepted`,
    );
  }
});

test('step.page rejects non-string values', () => {
  assert.throws(
    () =>
      validateRecordedPathStepShape(0, {
        id: 'click_thing',
        action: 'click',
        page: 1,
        locators: { a11y: { role: 'button', name: 'Allow' } },
      }),
    /page must be a string/,
  );
});

test('step.page rejects malformed handles with the open-list hint', () => {
  for (const bad of ['popup', 'popup-0', 'popup-01', 'POPUP-1', 'main-2', 'tab-1', 'banana']) {
    assert.throws(
      () =>
        validateRecordedPathStepShape(0, {
          id: 'click_thing',
          action: 'click',
          page: bad,
          locators: { a11y: { role: 'button', name: 'Allow' } },
        }),
      new RegExp(`page = "${bad.replace(/[-]/g, '\\-')}".*not a valid page handle`),
    );
  }
});

test('step.page omitted (default main) is accepted', () => {
  assert.doesNotThrow(() =>
    validateRecordedPathStepShape(0, {
      id: 'click_thing',
      action: 'click',
      locators: { a11y: { role: 'button', name: 'Allow' } },
    }),
  );
});

// ---------- Audit detector: popup_addressing_without_trigger ----------

function makeRecordedPathStrategy(steps) {
  return {
    strategy: 'recorded-path',
    steps,
    notes: {},
  };
}

function processWithCtx(strategy, session) {
  const ctx = {
    sessionId: 'sess_test',
    capability: 'do_thing',
    session: session ?? null,
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    observedUrls: [],
  };
  return saveStrategyAudit.process(strategy, ctx, {});
}

function popupWarning(result) {
  const warnings =
    result.status === 'rejected' ? result.rejection.warnings ?? [] : result.warnings ?? [];
  return warnings.find((w) => w.kind === 'popup_addressing_without_trigger');
}

test('audit: emits popup_addressing_without_trigger when step pins to unobserved popup', () => {
  const strategy = makeRecordedPathStrategy([
    {
      id: 'click_signin',
      action: 'click',
      locators: { a11y: { role: 'button', name: 'Sign in with Google' } },
    },
    {
      id: 'click_allow',
      action: 'click',
      page: 'popup-1',
      locators: { a11y: { role: 'button', name: 'Allow' } },
    },
  ]);
  const result = processWithCtx(strategy, { id: 'sess_x', subPages: [] });
  const w = popupWarning(result);
  assert.ok(w, 'expected the detector to emit a warning');
  assert.match(w.message, /popup-1/);
  assert.match(w.message, /click_allow/);
  assert.match(w.hint, /save_warnings_acked/);
});

test('audit: stays silent when discovery observed the popup the steps target', () => {
  const strategy = makeRecordedPathStrategy([
    {
      id: 'click_signin',
      action: 'click',
      locators: { a11y: { role: 'button', name: 'Sign in with Google' } },
    },
    {
      id: 'click_allow',
      action: 'click',
      page: 'popup-1',
      locators: { a11y: { role: 'button', name: 'Allow' } },
    },
  ]);
  const session = {
    id: 'sess_x',
    subPages: [
      {
        id: 'popup-1',
        url: 'https://accounts.google.com/o/oauth2/...',
        openerId: 'main',
        openedAt: Date.now(),
      },
    ],
  };
  const result = processWithCtx(strategy, session);
  assert.strictEqual(popupWarning(result), undefined, 'no warning expected when popup was observed');
});

test('audit: stays silent when no step pins to a popup at all', () => {
  const strategy = makeRecordedPathStrategy([
    {
      id: 'click_signin',
      action: 'click',
      locators: { a11y: { role: 'button', name: 'Sign in' } },
    },
    {
      id: 'type_email',
      action: 'type',
      value: '{{email}}',
      locators: { a11y: { role: 'textbox', name: 'Email' } },
    },
  ]);
  const result = processWithCtx(strategy, { id: 'sess_x', subPages: [] });
  assert.strictEqual(popupWarning(result), undefined);
});

test('audit: ignores explicit page:"main" — no warning', () => {
  const strategy = makeRecordedPathStrategy([
    {
      id: 'click_signin',
      action: 'click',
      page: 'main',
      locators: { a11y: { role: 'button', name: 'Sign in' } },
    },
  ]);
  const result = processWithCtx(strategy, { id: 'sess_x', subPages: [] });
  assert.strictEqual(popupWarning(result), undefined);
});
