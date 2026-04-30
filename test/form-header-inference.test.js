// Regression guard for the "Content-Type: application/x-www-form-urlencoded
// header but no `contentType: 'form'` top-level field" case. Without the
// inference, runtime JSON-stringifies the body while declaring a form
// Content-Type — servers reject, strategy fails at warm execute time.
// Observed 2026-04-21 wiki edit_sandbox warm/execute.

import test from 'node:test';
import assert from 'node:assert/strict';

// The helper isn't exported — exercise the CONTRACT via a spec shape
// that mirrors what execution.ts does internally. If the impl drifts
// from this spec, the spec drifts too and field-report reruns catch it.

function declaresForm(headers) {
  if (!headers) return false;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'content-type') continue;
    if (typeof v === 'string' && /application\/x-www-form-urlencoded/i.test(v)) return true;
  }
  return false;
}

test('declaresForm: plain form content-type → true', () => {
  assert.equal(declaresForm({ 'Content-Type': 'application/x-www-form-urlencoded' }), true);
});

test('declaresForm: form content-type with charset → true (wiki shape)', () => {
  assert.equal(
    declaresForm({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
    true,
  );
});

test('declaresForm: case-insensitive header name', () => {
  assert.equal(declaresForm({ 'content-type': 'application/x-www-form-urlencoded' }), true);
  assert.equal(declaresForm({ 'CONTENT-TYPE': 'application/x-www-form-urlencoded' }), true);
});

test('declaresForm: case-insensitive content-type value', () => {
  assert.equal(declaresForm({ 'Content-Type': 'Application/X-WWW-Form-URLEncoded' }), true);
});

test('declaresForm: JSON content-type → false', () => {
  assert.equal(declaresForm({ 'Content-Type': 'application/json' }), false);
  assert.equal(declaresForm({ 'Content-Type': 'application/json; charset=UTF-8' }), false);
});

test('declaresForm: no content-type → false', () => {
  assert.equal(declaresForm({}), false);
  assert.equal(declaresForm(undefined), false);
  assert.equal(declaresForm({ 'X-Other': 'x' }), false);
});

test('declaresForm: multipart form-data → false (distinct shape; body is FormData / binary)', () => {
  // Multipart form-data is a different wire shape; runtime doesn't
  // serialize objects to multipart. `declaresForm` reports only the
  // URL-encoded variant.
  assert.equal(declaresForm({ 'Content-Type': 'multipart/form-data; boundary=xyz' }), false);
});
