// End-drive audit: observed_capabilities_not_lifted Detector coverage.
//
// Agents that call record_observed_capability on slugs they never lift
// (neither via lift_observed_capability into declaredCapabilities, nor
// via save_strategy into savedCapabilities) drop breadcrumbs and walk
// away. The loop's "save every safe read-only capability" task makes
// these leftovers a missed opportunity, not a deferred one. Detector
// refuses close on attempts 0 and 1; releases on attempt 2 per the
// existing third-attempt escape hatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { endDriveAudit, RE_CALL_THRESHOLD } = await import('../dist/audit/drive/end-drive.js');
const { __resetStore } = await import('../dist/gate/store.js');

const DISCOVER_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: 0 };

function makePayload(overrides = {}) {
  return {
    sessionId: 'sess-test',
    platform: 'p',
    endDriveAttempts: 0,
    declaredCapabilityCount: 1,
    writeActions: [],
    heavyReCallCount: 0,
    jsEvalCallCount: 0,
    persistCallCount: 0,
    actionCallCount: 0,
    saveAttemptCount: 0,
    saveSuccessCount: 1, // bypass save_attempted_none_landed
    skipDeclarationGuard: false,
    rePersistenceThreshold: DISCOVER_THRESHOLD,
    triageWouldFire: false, // also sidestep triage_acknowledgment
    observedNotLifted: [],
    graph: 'discover',
    observedCapabilityCount: 0,
    httpFailureCount: 0,
    ...overrides,
  };
}

test('observedNotLifted empty → detector does not fire', () => {
  __resetStore();
  // The triage_acknowledgment classifier WILL fire (saveSuccessCount > 0
  // means triage skipped), so we expect "rejected" but the rejection
  // should come from that classifier, not our detector.
  const result = endDriveAudit.process(makePayload(), {}, {});
  if (result.status === 'rejected') {
    const warningKinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(
      !warningKinds.includes('observed_capabilities_not_lifted'),
      'detector should not emit when observedNotLifted is empty',
    );
  }
});

test('observedNotLifted non-empty → detector emits warning naming the slugs', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ observedNotLifted: ['list_orders', 'get_inventory'] }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const warning = (result.rejection.warnings ?? []).find(
    (w) => w.kind === 'observed_capabilities_not_lifted',
  );
  assert.ok(warning, 'detector must emit a warning');
  assert.match(warning.message, /list_orders/);
  assert.match(warning.message, /get_inventory/);
  assert.equal(warning.context.observed_not_lifted.length, 2);
});

test('observedNotLifted: validateAck rejects canned reason that omits slugs', () => {
  __resetStore();
  const slugs = ['list_orders', 'get_inventory'];
  // Provide a stub user_confirmation classifier answer + an ack that
  // doesn't mention either slug.
  const result = endDriveAudit.process(
    makePayload({ observedNotLifted: slugs }),
    {},
    {
      acks: {
        observed_capabilities_not_lifted:
          'deferring to next session because of time constraints',
      },
    },
  );
  assert.equal(result.status, 'rejected');
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some((s) => s.includes('list_orders') && s.includes('get_inventory')),
    `expected ack rejection naming missing slugs, got: ${JSON.stringify(ackIssues)}`,
  );
});

test('observedNotLifted: validateAck accepts reason that names every slug', () => {
  __resetStore();
  const slugs = ['list_orders', 'get_inventory'];
  // We still expect a rejection on this run because triage_acknowledgment
  // classifier fires (saveSuccessCount > 0). But the observed-not-lifted
  // ack should not be in ack_issues.
  const result = endDriveAudit.process(makePayload({ observedNotLifted: slugs }), {}, {
    acks: {
      observed_capabilities_not_lifted:
        'deferring list_orders (auth-walled, will lift after login flow lands) and get_inventory (paginated listing without cursor — needs follow-up RE)',
    },
  });
  if (result.status === 'rejected') {
    const ackIssues = result.rejection.ack_issues ?? [];
    const observedAckIssues = ackIssues.filter((s) =>
      s.includes('observed_capabilities_not_lifted'),
    );
    assert.equal(
      observedAckIssues.length,
      0,
      `expected no ack issue for observed_capabilities_not_lifted with full-slug reason, got: ${JSON.stringify(observedAckIssues)}`,
    );
  }
});

test('observedNotLifted: third-attempt force-tear-down releases', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      observedNotLifted: ['list_orders'],
      endDriveAttempts: 2, // pre-bump: third call
    }),
    {},
    {},
  );
  if (result.status === 'rejected') {
    const warningKinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(
      !warningKinds.includes('observed_capabilities_not_lifted'),
      'detector must release on third end_drive attempt (force-tear-down escape hatch)',
    );
  }
});
