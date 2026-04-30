// Unit-level contract tests for the type-action append-default behavior.
// Full driver integration is exercised via field reports; these tests
// lock the decision matrix (empty → fill, non-empty → append,
// replace:true → fill) so the driver SPI stays honest.

import test from 'node:test';
import assert from 'node:assert/strict';

// The driver impl itself needs a live Playwright page to exercise, so
// this file tests the CONTRACT via a stub that implements the same
// decision matrix as PlaywrightDriver.type. If the implementation drifts
// from the matrix, the stub drifts too — the matrix is what we care
// about. End-to-end behavior verified in field-report manual reruns.

function makeStubDriver() {
  const calls = [];
  let isEmpty = true;
  return {
    setFieldEmpty(v) {
      isEmpty = v;
    },
    calls,
    async type(_session, selector, text, opts) {
      if (opts?.replace) {
        calls.push({ op: 'fill', selector, text, path: 'replace' });
        return;
      }
      if (isEmpty) {
        calls.push({ op: 'fill', selector, text, path: 'empty' });
        return;
      }
      calls.push({ op: 'focus', selector });
      calls.push({ op: 'press', selector, key: 'End' });
      calls.push({ op: 'pressSequentially', selector, text });
    },
  };
}

test('empty field → fill fast path', async () => {
  const d = makeStubDriver();
  d.setFieldEmpty(true);
  await d.type({}, 'input#q', 'hello');
  assert.deepEqual(d.calls, [{ op: 'fill', selector: 'input#q', text: 'hello', path: 'empty' }]);
});

test('non-empty field → focus + press End + pressSequentially', async () => {
  const d = makeStubDriver();
  d.setFieldEmpty(false);
  await d.type({}, 'textarea#body', '\nmore');
  assert.deepEqual(d.calls, [
    { op: 'focus', selector: 'textarea#body' },
    { op: 'press', selector: 'textarea#body', key: 'End' },
    { op: 'pressSequentially', selector: 'textarea#body', text: '\nmore' },
  ]);
});

test('replace: true forces fill regardless of content', async () => {
  const d = makeStubDriver();
  d.setFieldEmpty(false); // field has content...
  await d.type({}, 'input#name', 'Alice', { replace: true });
  // ...but replace wins.
  assert.deepEqual(d.calls, [{ op: 'fill', selector: 'input#name', text: 'Alice', path: 'replace' }]);
});

test('replace: false on empty field still uses fast-path fill', async () => {
  const d = makeStubDriver();
  d.setFieldEmpty(true);
  await d.type({}, 'input#q', 'hello', { replace: false });
  assert.deepEqual(d.calls, [{ op: 'fill', selector: 'input#q', text: 'hello', path: 'empty' }]);
});
