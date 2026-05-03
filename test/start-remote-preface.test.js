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
