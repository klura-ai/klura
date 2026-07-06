// End-drive audit: unsaved_xhr_endpoints Detector coverage.
//
// When the captured network log shows 2xx XHR responses on paths that
// aren't covered by any saved strategy AND don't match the tracking-shape
// heuristic, the agent is closing while leaving observable read-only
// surfaces unsaved. Detector refuses close on attempts 0 and 1; releases
// on attempt 2 per the third-attempt escape hatch. Ack must name at least
// one URL path verbatim (anti-canned).

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
    triageWouldFire: false, // sidestep triage_acknowledgment classifier
    observedNotLifted: [],
    graph: 'discover',
    observedCapabilityCount: 0,
    httpFailureCount: 0,
    unsavedHotXhrEndpoints: [],
    ...overrides,
  };
}

test('unsavedHotXhrEndpoints empty → detector does not fire', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload(), {}, {});
  if (result.status === 'rejected') {
    const kinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(
      !kinds.includes('unsaved_xhr_endpoints'),
      'detector should not emit when there are no unsaved hot endpoints',
    );
  }
});

test('unsavedHotXhrEndpoints non-empty → detector emits warning listing the paths', () => {
  __resetStore();
  const endpoints = [
    { method: 'GET', urlPath: '/api/products/search', sampleUrl: 'https://x.test/api/products/search?q=nike' },
    { method: 'GET', urlPath: '/api/store-locator', sampleUrl: 'https://x.test/api/store-locator' },
  ];
  const result = endDriveAudit.process(
    makePayload({ unsavedHotXhrEndpoints: endpoints }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const warning = (result.rejection.warnings ?? []).find((w) => w.kind === 'unsaved_xhr_endpoints');
  assert.ok(warning, 'detector must emit a warning when unsavedHotXhrEndpoints is non-empty');
  assert.match(warning.message, /\/api\/products\/search/);
  assert.match(warning.message, /\/api\/store-locator/);
  assert.equal(warning.context.unsaved_xhr_endpoints.length, 2);
});

test('map graph → message allows defer, hint leads with defer-ack', () => {
  __resetStore();
  const endpoints = [
    { method: 'GET', urlPath: '/api/products/search', sampleUrl: 'https://x.test/api/products/search?q=nike' },
  ];
  const result = endDriveAudit.process(
    makePayload({ graph: 'map', unsavedHotXhrEndpoints: endpoints }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const warning = (result.rejection.warnings ?? []).find((w) => w.kind === 'unsaved_xhr_endpoints');
  assert.ok(warning, 'detector must emit a warning');
  assert.doesNotMatch(warning.message, /CANNOT CLOSE/);
  assert.match(warning.message, /clean close|future lift session/i);
  assert.match(warning.hint, /^Default: defer/);
  assert.ok(
    warning.hint.indexOf('acks') < warning.hint.indexOf('declare_capability'),
    'map-graph hint must present defer-ack before the save path',
  );
});

test('non-map graph → keeps save-first framing (save path leads)', () => {
  __resetStore();
  const endpoints = [
    { method: 'GET', urlPath: '/api/products/search', sampleUrl: 'https://x.test/api/products/search?q=nike' },
  ];
  const result = endDriveAudit.process(
    makePayload({ graph: 'discover', unsavedHotXhrEndpoints: endpoints }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const warning = (result.rejection.warnings ?? []).find((w) => w.kind === 'unsaved_xhr_endpoints');
  assert.ok(warning, 'detector must emit a warning');
  assert.match(warning.message, /CANNOT CLOSE/);
  assert.ok(
    warning.hint.indexOf('declare_capability') < warning.hint.indexOf('acks'),
    'non-map hint must present the save path before defer-ack',
  );
});

test('unsavedHotXhrEndpoints: validateAck rejects canned reason that omits paths', () => {
  __resetStore();
  const endpoints = [
    { method: 'GET', urlPath: '/api/products/search', sampleUrl: 'https://x.test/api/products/search' },
    { method: 'GET', urlPath: '/api/store-locator', sampleUrl: 'https://x.test/api/store-locator' },
  ];
  const result = endDriveAudit.process(
    makePayload({ unsavedHotXhrEndpoints: endpoints }),
    {},
    {
      acks: {
        unsaved_xhr_endpoints: 'all noise — telemetry endpoints, not real capabilities',
      },
    },
  );
  assert.equal(result.status, 'rejected');
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some((s) => s.includes('/api/products/search') || s.includes('/api/store-locator')),
    `expected ack rejection naming the missing paths, got: ${JSON.stringify(ackIssues)}`,
  );
});

test('unsavedHotXhrEndpoints: validateAck accepts reason that names at least one path verbatim', () => {
  __resetStore();
  const endpoints = [
    { method: 'GET', urlPath: '/api/products/search', sampleUrl: 'https://x.test/api/products/search' },
    { method: 'GET', urlPath: '/api/store-locator', sampleUrl: 'https://x.test/api/store-locator' },
  ];
  const result = endDriveAudit.process(
    makePayload({ unsavedHotXhrEndpoints: endpoints }),
    {},
    {
      acks: {
        unsaved_xhr_endpoints:
          'deferring /api/products/search — needs search-form discovery for {{query}} arg; /api/store-locator is real but lift-after-login follow-up',
      },
    },
  );
  if (result.status === 'rejected') {
    const ackIssues = result.rejection.ack_issues ?? [];
    const xhrAckIssues = ackIssues.filter((s) => s.includes('unsaved_xhr_endpoints'));
    assert.equal(
      xhrAckIssues.length,
      0,
      `expected no ack issue when reason names at least one path verbatim, got: ${JSON.stringify(xhrAckIssues)}`,
    );
  }
});

test('unsavedHotXhrEndpoints: third-attempt force-tear-down releases', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      unsavedHotXhrEndpoints: [
        { method: 'GET', urlPath: '/api/products/search', sampleUrl: 'https://x.test/api/products/search' },
      ],
      endDriveAttempts: 2,
    }),
    {},
    {},
  );
  if (result.status === 'rejected') {
    const kinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(
      !kinds.includes('unsaved_xhr_endpoints'),
      'detector must release on third end_drive attempt (force-tear-down escape hatch)',
    );
  }
});
