// End-drive audit: abandoned_save_attempts_not_retried Detector coverage.
//
// post-save validation can leave a capability in a non-working state two
// ways: archived (.broken on validation failure) or declined (cancelled
// post_save_validation_consent). When the agent doesn't subsequently
// re-save the capability, warm callers silently use a stale/.broken
// strategy. Detector refuses close until re-save lands OR the agent
// explicitly acks the abandonment with a reason naming each capability.

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
    triageWouldFire: false,
    observedNotLifted: [],
    graph: 'discover',
    observedCapabilityCount: 0,
    httpFailureCount: 0,
    unsavedHotXhrEndpoints: [],
    abandonedSaveAttemptsNotRetried: [],
    ...overrides,
  };
}

test('abandonedSaveAttempts empty → detector does not fire', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload(), {}, {});
  if (result.status === 'rejected') {
    const kinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(
      !kinds.includes('abandoned_save_attempts_not_retried'),
      'detector should not emit when no abandoned attempts remain',
    );
  }
});

test('abandonedSaveAttempts (archived) → detector emits warning naming the capability', () => {
  __resetStore();
  const abandoned = [
    { capability: 'list_categories', kind: 'archived', at: Date.now() - 1000 },
  ];
  const result = endDriveAudit.process(
    makePayload({ abandonedSaveAttemptsNotRetried: abandoned }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const warning = (result.rejection.warnings ?? []).find(
    (w) => w.kind === 'abandoned_save_attempts_not_retried',
  );
  assert.ok(warning, 'detector must emit warning');
  assert.match(warning.message, /list_categories/);
  assert.match(warning.message, /validation failed/);
});

test('abandonedSaveAttempts (declined) → detector emits warning with declined phrasing', () => {
  __resetStore();
  const abandoned = [
    { capability: 'get_sponsored_products', kind: 'declined', at: Date.now() - 1000 },
  ];
  const result = endDriveAudit.process(
    makePayload({ abandonedSaveAttemptsNotRetried: abandoned }),
    {},
    {},
  );
  const warning = (result.rejection.warnings ?? []).find(
    (w) => w.kind === 'abandoned_save_attempts_not_retried',
  );
  assert.ok(warning);
  assert.match(warning.message, /consent declined/);
});

test('abandonedSaveAttempts: validateAck rejects canned reason that omits capability slugs', () => {
  __resetStore();
  const abandoned = [
    { capability: 'list_categories', kind: 'archived', at: Date.now() - 1000 },
    { capability: 'get_sponsored_products', kind: 'declined', at: Date.now() - 500 },
  ];
  const result = endDriveAudit.process(
    makePayload({ abandonedSaveAttemptsNotRetried: abandoned }),
    {},
    {
      acks: {
        abandoned_save_attempts_not_retried:
          'abandoning all unfixable this session',
      },
    },
  );
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some(
      (s) => s.includes('list_categories') && s.includes('get_sponsored_products'),
    ),
    `expected ack rejection naming missing slugs, got: ${JSON.stringify(ackIssues)}`,
  );
});

test('abandonedSaveAttempts: validateAck accepts reason naming every slug', () => {
  __resetStore();
  const abandoned = [
    { capability: 'list_categories', kind: 'archived', at: Date.now() - 1000 },
  ];
  const result = endDriveAudit.process(
    makePayload({ abandonedSaveAttemptsNotRetried: abandoned }),
    {},
    {
      acks: {
        abandoned_save_attempts_not_retried:
          'abandoning list_categories — requires page-script which timed out in this driver',
      },
    },
  );
  if (result.status === 'rejected') {
    const ackIssues = result.rejection.ack_issues ?? [];
    const issuesForKind = ackIssues.filter((s) =>
      s.includes('abandoned_save_attempts_not_retried'),
    );
    assert.equal(issuesForKind.length, 0);
  }
});

test('abandonedSaveAttempts: third-attempt force-tear-down releases', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      abandonedSaveAttemptsNotRetried: [
        { capability: 'list_categories', kind: 'archived', at: Date.now() },
      ],
      endDriveAttempts: 2,
    }),
    {},
    {},
  );
  if (result.status === 'rejected') {
    const kinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(
      !kinds.includes('abandoned_save_attempts_not_retried'),
      'detector must release on third end_drive attempt',
    );
  }
});
