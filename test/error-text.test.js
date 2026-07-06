// errorText must never return an empty/whitespace string — an empty error
// surfaced to the agent (the daemon's `{"error":""}`) reads as an inexplicable
// crash it cannot act on. Regression for a live-site panic-restart loop.

import test from 'node:test';
import assert from 'node:assert';

const { errorText } = await import('../dist/utils/error-text.js');

const nonEmpty = (v) => {
  const s = errorText(v);
  assert.strictEqual(typeof s, 'string');
  assert.ok(
    s.trim().length > 0,
    `expected non-empty for ${JSON.stringify(String(v))}, got ${JSON.stringify(s)}`,
  );
  return s;
};

test('preserves a real message', () => {
  assert.strictEqual(errorText(new Error('boom')), 'boom');
});

test('never emits empty for a message-less Error', () => {
  assert.match(nonEmpty(new Error('')), /Error \(no message\)/);
  assert.match(nonEmpty(new Error('   ')), /Error \(no message\)/);
});

test('names the error type when message is absent', () => {
  const e = new Error();
  e.name = 'AbortError';
  assert.match(nonEmpty(e), /AbortError/);
});

test('handles non-Error throwables without emptiness', () => {
  nonEmpty('');
  nonEmpty(null);
  nonEmpty(undefined);
  nonEmpty({});
  assert.strictEqual(errorText('plain string'), 'plain string');
});
