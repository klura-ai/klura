// Unit tests for resolveVariables / interpolateVars — the template
// substitution that runs through `JSON.stringify → interpolate → JSON.parse`
// on strategy bodies/headers. Regression guard for the "CSRF token with
// trailing backslash breaks JSON.parse" bug observed on Wikipedia page-script
// execution (MediaWiki tokens end with `+\`).

import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveVariables, interpolateVars } = await import('../dist/execution/vars.js');

test('resolveVariables: plain string substitution — happy path', () => {
  const out = resolveVariables({ a: '{{name}}', b: 'hi' }, { name: 'alice' });
  assert.deepEqual(out, { a: 'alice', b: 'hi' });
});

test('resolveVariables: value with trailing backslash (MediaWiki CSRF shape)', () => {
  // This is the real failure mode observed in the 2026-04-21 wiki field
  // report: mw.user.tokens.get('csrfToken') returns a string ending with
  // `+\` — a literal trailing backslash. Before jsonEscape, raw
  // substitution into `"token":"{{csrf_token}}"` produced
  // `"token":"...+\"` which fails JSON.parse as "unterminated string."
  const token = '1e1f66b6d339d2ae7cee7a3f62ee4f1669e77ead+\\';
  const body = { action: 'edit', token: '{{csrf_token}}' };
  const out = resolveVariables(body, { csrf_token: token });
  assert.equal(out.action, 'edit');
  assert.equal(out.token, token, 'trailing-backslash token must round-trip');
});

test('resolveVariables: value containing a literal double quote', () => {
  const out = resolveVariables({ body: '{{msg}}' }, { msg: 'she said "hi"' });
  assert.equal(out.body, 'she said "hi"');
});

test('resolveVariables: value containing newline + tab', () => {
  const out = resolveVariables({ body: '{{v}}' }, { v: 'line1\nline2\tindented' });
  assert.equal(out.body, 'line1\nline2\tindented');
});

test('resolveVariables: value containing unicode chars', () => {
  const out = resolveVariables({ x: '{{v}}' }, { v: 'π≈3.14 • 🎉' });
  assert.equal(out.x, 'π≈3.14 • 🎉');
});

test('resolveVariables: missing placeholder leaves literal in output', () => {
  const out = resolveVariables({ x: '{{missing}}' }, {});
  assert.equal(out.x, '{{missing}}');
});

test('resolveVariables: placeholder inside nested arrays and objects', () => {
  const out = resolveVariables(
    { headers: { auth: 'Bearer {{token}}' }, items: ['{{name}}'] },
    { token: 'xyz\\+abc', name: 'alice' },
  );
  assert.equal(out.headers.auth, 'Bearer xyz\\+abc');
  assert.deepEqual(out.items, ['alice']);
});

// ---- interpolateVars direct behavior ----

test('interpolateVars: default mode leaves raw string values as-is', () => {
  // No jsonEscape, no encode. Used by sites that build URL templates
  // (:param style) before handing off to encodeURIComponent, or by
  // tests. Behavior must stay literal for back-compat.
  assert.equal(interpolateVars('v={{x}}', { x: 'a\\b' }), 'v=a\\b');
});

test('interpolateVars: encode=true URL-encodes the value', () => {
  assert.equal(
    interpolateVars('q={{t}}', { t: 'hello world' }, true),
    'q=hello%20world',
  );
});

test('interpolateVars: jsonEscape=true escapes backslashes and quotes', () => {
  assert.equal(
    interpolateVars('"token":"{{t}}"', { t: 'abc+\\' }, false, true),
    '"token":"abc+\\\\"',
    'trailing backslash must be doubled',
  );
  assert.equal(
    interpolateVars('"msg":"{{m}}"', { m: 'she said "hi"' }, false, true),
    '"msg":"she said \\"hi\\""',
    'literal quotes must be escaped',
  );
});
