// Capability arg-shape hint helper. Pure function; no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkCapabilityArgs } = await import('../dist/tools/well-known-capabilities.js');

test('returns null for unknown capability slug', () => {
  assert.equal(checkCapabilityArgs('not_a_real_slug', { foo: 'bar' }), null);
});

test('returns null when send_message args match canonical shape', () => {
  assert.equal(
    checkCapabilityArgs('send_message', { recipient: 'Bob', text: 'hi' }),
    null,
  );
});

test('flags missing recipient when only text supplied', () => {
  const hint = checkCapabilityArgs('send_message', { text: 'Hello' });
  assert.ok(hint);
  assert.match(hint, /Missing: recipient/);
  assert.match(hint, /\{recipient, text\}/);
});

test('flags message → text typo via alias', () => {
  const hint = checkCapabilityArgs('send_message', { message: 'Hello' });
  assert.ok(hint);
  assert.match(hint, /'message' → 'text'/);
  assert.match(hint, /Missing: recipient, text/);
});

test('flags both missing recipient and unknown key', () => {
  const hint = checkCapabilityArgs('send_message', { body: 'Hello' });
  assert.ok(hint);
  assert.match(hint, /'body' → 'text'/);
  assert.match(hint, /Missing: recipient, text/);
});

test('flags entirely empty args', () => {
  const hint = checkCapabilityArgs('send_message', {});
  assert.ok(hint);
  assert.match(hint, /You supplied \{<none>\}/);
  assert.match(hint, /Missing: recipient, text/);
});

test('flags undefined args', () => {
  const hint = checkCapabilityArgs('send_message', undefined);
  assert.ok(hint);
  assert.match(hint, /Missing: recipient, text/);
});
