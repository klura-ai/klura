// buildOverlayInterceptHint detects playwright's "subtree intercepts pointer
// events" trace and returns dismiss-first guidance.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOverlayInterceptHint } = await import('../dist/tools/perform-action.js');

test('returns empty string for unrelated playwright errors', () => {
  assert.equal(buildOverlayInterceptHint('Timeout 5000ms exceeded'), '');
  assert.equal(buildOverlayInterceptHint('locator resolved to <a>'), '');
});

test('extracts cookie-policy-dialog interceptor from real playwright trace', () => {
  const trace =
    'Error: locator.click: Timeout 5000ms exceeded.\n' +
    'Call log:\n' +
    '  - waiting for locator(...).first()\n' +
    '  - attempting click action\n' +
    '    2 × waiting for element to be visible, enabled and stable\n' +
    '      - element is visible, enabled and stable\n' +
    '      - <div class="_3ixn"></div> from <div data-testid="cookie-policy-dialog" class="_10 _9o-w">…</div> subtree intercepts pointer events';
  const hint = buildOverlayInterceptHint(trace);
  assert.ok(hint);
  assert.match(hint, /cookie-policy-dialog/);
  assert.match(hint, /Dismiss the overlay first/);
  assert.match(hint, /key_press.*Escape/);
  assert.match(hint, /Do NOT call `start_remote_session`/);
});

test('extracts arbitrary overlay element name from trace', () => {
  const trace = 'foo from <div id="my-modal" class="overlay"> subtree intercepts pointer events bar';
  const hint = buildOverlayInterceptHint(trace);
  assert.ok(hint);
  assert.match(hint, /my-modal/);
});

test('handles whitespace and multiline traces', () => {
  const trace =
    '  - <span></span>\n' +
    '      from <div class="banner">…</div>  subtree intercepts pointer events\n' +
    '  - retrying';
  const hint = buildOverlayInterceptHint(trace);
  assert.ok(hint);
  assert.match(hint, /class="banner"/);
});
