// Unit tests for `rediscoverFailureGate`.
//
// The gate is a predicate on `execute_failed` payloads in the `execute`
// graph. It decides whether the FSM routes execute → triage (relearn the
// stale strategy) or terminal{failed} (caller-side error, retrying is
// futile).
//
// Two signals:
//   1. Structural: `diagnosis_kind` from the cascade's typed
//      AutoExecDiagnosis. Stale-shape kinds trip on the FIRST failure.
//   2. Rate-based fallback: rolling success rate < pool.rediscoverThreshold.
//
// These tests pin the structural signal. Rate-based behavior is covered
// implicitly by execute-error-shape.test.js + graph-invariants.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

const { rediscoverFailureGate } = await import(
  '../dist/graphs/guards/rediscover.js'
);

const fakeSession = {};

function payload(overrides = {}) {
  return {
    platform: 'test_platform',
    capability: 'test_capability',
    error: 'execute_failed',
    ...overrides,
  };
}

// ---------- structural signal ----------

test('gate: stale_nonce trips on first failure (no rate history)', () => {
  // Token rotated server-side. Definitely a relearn — the saved
  // expression doesn't reach the new path. Single failure is enough.
  assert.equal(
    rediscoverFailureGate(fakeSession, payload({ diagnosis_kind: 'stale_nonce' })),
    true,
  );
});

test('gate: endpoint_stale trips on first failure', () => {
  // URL retired (4xx with retired-endpoint pattern). Relearn finds
  // the new URL.
  assert.equal(
    rediscoverFailureGate(fakeSession, payload({ diagnosis_kind: 'endpoint_stale' })),
    true,
  );
});

test('gate: needs_rediscovery trips on first failure', () => {
  // The cascade explicitly said so — trip without further checks.
  assert.equal(
    rediscoverFailureGate(fakeSession, payload({ diagnosis_kind: 'needs_rediscovery' })),
    true,
  );
});

test('gate: prereq_returned_undefined trips on first failure', () => {
  // The prereq's expression read page state that has drifted; the
  // new shape is discoverable by the agent, so relearn.
  assert.equal(
    rediscoverFailureGate(
      fakeSession,
      payload({ diagnosis_kind: 'prereq_returned_undefined' }),
    ),
    true,
  );
});

test('gate: auth_failed does NOT trip — relearn cannot fix logged-out state', () => {
  // The user needs to re-auth via remote viewer. Routing to triage
  // would just thrash; terminal{failed} surfaces the real fix.
  assert.equal(
    rediscoverFailureGate(fakeSession, payload({ diagnosis_kind: 'auth_failed' })),
    false,
  );
});

test('gate: unknown falls through to rate-based fallback (no rate → no trip)', () => {
  // No saved strategies for the test platform/capability → rate is
  // null → gate doesn't trip on its own. Same shape as a fresh
  // strategy whose first call fails for a caller-arg reason.
  assert.equal(
    rediscoverFailureGate(fakeSession, payload({ diagnosis_kind: 'unknown' })),
    false,
  );
});

test('gate: missing diagnosis_kind falls through to rate-based fallback', () => {
  // Synthetic failure (executor never ran — auto_execute_reason path).
  // Same fallback as 'unknown'.
  assert.equal(rediscoverFailureGate(fakeSession, payload({})), false);
});

// ---------- payload validation ----------

test('gate: returns false when payload is null/undefined/wrong shape', () => {
  assert.equal(rediscoverFailureGate(fakeSession, undefined), false);
  assert.equal(rediscoverFailureGate(fakeSession, null), false);
  assert.equal(rediscoverFailureGate(fakeSession, {}), false);
  assert.equal(rediscoverFailureGate(fakeSession, { platform: 'p' }), false);
});
