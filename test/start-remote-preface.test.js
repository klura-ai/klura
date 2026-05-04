// buildPreface for start_remote_session — mode-aware verbatim contract.
// Pure function; URL-shape sniffing decides reachability wording.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildPreface } = await import('../dist/tools/remote.js');

test('local exposure frames reachability as same-machine', () => {
  const preface = buildPreface('local');
  assert.match(preface, /klura runs on the user's machine/);
  assert.match(preface, /localhost is THEIR localhost/);
  assert.doesNotMatch(preface, /public tunnel/);
});

test('public exposure warns about public reachability', () => {
  const preface = buildPreface('public');
  assert.match(preface, /public tunnel/);
  assert.match(preface, /not paste it into a public channel/);
  assert.doesNotMatch(preface, /THEIR localhost/);
});

test('preface forbids markdown wrapping characters in both modes', () => {
  for (const mode of ['local', 'public']) {
    const preface = buildPreface(mode);
    assert.match(preface, /Do NOT/);
    assert.match(preface, /backticks/);
    assert.match(preface, /markdown/);
    assert.match(preface, /quotation marks/);
  }
});

test('preface names JWT signature breakage as the consequence', () => {
  assert.match(buildPreface('local'), /JWT/);
  assert.match(buildPreface('local'), /signature/);
});

test('preface names the browser-profile separation in both modes', () => {
  for (const mode of ['local', 'public']) {
    const preface = buildPreface(mode);
    assert.match(preface, /viewer's browser/);
    assert.match(preface, /not the user's regular Chrome/);
  }
});

test('autoOpened preface tells the user a browser tab should already have opened', () => {
  const preface = buildPreface('local', { autoOpened: true });
  assert.match(preface, /tab should already have opened/);
  assert.match(preface, /look for the popup/);
  // Reachability + no-wrapping + browser-profile clauses still present.
  assert.match(preface, /klura runs on the user's machine/);
  assert.match(preface, /Do NOT/);
  assert.match(preface, /viewer's browser/);
});

test('autoOpened preface still surfaces the URL as a fallback', () => {
  const preface = buildPreface('local', { autoOpened: true });
  // Specifically calls out the failure modes where auto-open silently misses.
  assert.match(preface, /popup blocker|headless terminal|wrong monitor/);
  assert.match(preface, /fallback/);
});

test('isShort preface drops the JWT-signature alarm', () => {
  const preface = buildPreface('local', { isShort: true });
  // Short URL relay carries a 16-char redirect token, not the JWT — the
  // "any retype breaks the signature" warning is misleading there.
  assert.doesNotMatch(preface, /JWT/);
  assert.doesNotMatch(preface, /signature/);
  // But still describes what it is so the agent doesn't try to decode it.
  assert.match(preface, /short single-use redirect/);
  assert.match(preface, /60s TTL/);
  // No-wrapping rule still applies — the user pastes it the same way.
  assert.match(preface, /Do NOT/);
  assert.match(preface, /backticks/);
});

test('autoOpened + isShort compose: tab-already-opened lead AND short-URL framing', () => {
  const preface = buildPreface('local', { autoOpened: true, isShort: true });
  assert.match(preface, /tab should already have opened/);
  assert.match(preface, /short single-use redirect/);
  assert.doesNotMatch(preface, /JWT/);
});
