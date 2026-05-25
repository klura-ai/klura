// Visibility annotation helper: annotate-by-exception sidecar that
// surfaces overlapped / below-fold / off-screen interactive nodes.
// Driver-side enumeration is in playwright.ts and exercised against a
// real browser in integration runs; this suite covers the pure helper
// + the missing-method fallback so the wiring stays correct even when
// a driver doesn't implement the snap (test stubs, BYO drivers in
// pre-rollout state).

import test from 'node:test';
import assert from 'node:assert/strict';

const { snapVisibilityAnomalies } = await import('../dist/phases/visibility.js');

test('snapVisibilityAnomalies: driver lacks method → returns [] (no crash)', async () => {
  const driver = { /* no snapVisibilityForInteractiveNodes */ };
  const out = await snapVisibilityAnomalies(driver, { id: 'sess_x' });
  assert.deepStrictEqual(out, []);
});

test('snapVisibilityAnomalies: driver throws → returns [] (best-effort, swallowed)', async () => {
  const driver = {
    snapVisibilityForInteractiveNodes: async () => {
      throw new Error('boom');
    },
  };
  const out = await snapVisibilityAnomalies(driver, { id: 'sess_x' });
  assert.deepStrictEqual(out, []);
});

test('snapVisibilityAnomalies: passes through whatever the driver returns', async () => {
  const driver = {
    snapVisibilityForInteractiveNodes: async () => [
      { role: 'button', name: 'Search', _v: 'o' },
      { role: 'link', name: 'Footer link', _v: 'f' },
    ],
  };
  const out = await snapVisibilityAnomalies(driver, { id: 'sess_x' });
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'button');
  assert.equal(out[0]._v, 'o');
  assert.equal(out[1]._v, 'f');
});

test('snapVisibilityAnomalies: empty driver result → empty array (no anomalies = clean page)', async () => {
  const driver = {
    snapVisibilityForInteractiveNodes: async () => [],
  };
  const out = await snapVisibilityAnomalies(driver, { id: 'sess_x' });
  assert.deepStrictEqual(out, []);
});
