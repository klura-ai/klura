// Unit tests for patchStep (#36).
// Covers the step_id-keyed lookup, 404 error listing known ids, and the
// happy-path patch-apply-then-read-back flow.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-patch-step-'));
process.env.KLURA_HOME = TMP;

const { saveStrategy, patchStep, loadStrategies } = await import('../dist/strategies/skills.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seed(platform, capability) {
  saveStrategy(platform, capability, {
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_home', action: 'navigate', url: 'https://example.com' },
      {
        id: 'type_message',
        action: 'type',
        locators: { a11y: { role: 'textbox', name: 'Message' }, css: 'textarea.msg' },
        value: '{{message}}',
      },
      {
        id: 'click_send',
        action: 'click',
        locators: { a11y: { role: 'button', name: 'Send' }, css: 'button.send' },
      },
    ],
    notes: { params: { message: { kind: 'text', example: 'hello world' } } },
  });
}

test('patchStep: patches by step id and persists', () => {
  seed('pstep-1', 'send_message');
  const res = patchStep('pstep-1', 'send_message', 'recorded-path', 'click_send', {
    locators: { a11y: { role: 'button', name: 'Send' }, css: 'button.new-send' },
  });
  assert.ok('ok' in res && res.ok === true, `expected ok, got ${JSON.stringify(res)}`);

  const strat = loadStrategies('pstep-1', 'send_message').find((s) => s.strategy === 'recorded-path');
  assert.ok(strat);
  const patched = strat.steps.find((s) => s.id === 'click_send');
  assert.equal(patched.locators.css, 'button.new-send');
});

test('patchStep: 404 on unknown id lists known ids', () => {
  seed('pstep-2', 'send_message');
  const res = patchStep('pstep-2', 'send_message', 'recorded-path', 'click_publish', {
    locators: { css: 'button' },
  });
  assert.ok('error' in res);
  assert.match(res.error, /no step with id "click_publish"/);
  assert.match(res.error, /known ids:/);
  assert.match(res.error, /"navigate_home"/);
  assert.match(res.error, /"type_message"/);
  assert.match(res.error, /"click_send"/);
});

test('patchStep: rejects empty step_id', () => {
  seed('pstep-3', 'send_message');
  const res = patchStep('pstep-3', 'send_message', 'recorded-path', '', {
    locators: { css: 'button' },
  });
  assert.ok('error' in res);
  assert.match(res.error, /step_id must be a non-empty string/);
});

test('patchStep: missing strategy file', () => {
  const res = patchStep('nowhere', 'none', 'recorded-path', 'click_send', {});
  assert.ok('error' in res);
  assert.match(res.error, /not found/);
});
