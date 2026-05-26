// observed_capabilities_not_lifted ack anti-fabrication: when the reason
// claims "covered by <X>" / "saved as <X>", the runtime validates X against
// the platform's actually-saved capabilities. Naming-only check meant agents
// closed sessions by stringing factually-empty cover claims that named the
// required slugs but referenced capabilities that didn't exist on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-ack-fab-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { endDriveAudit, RE_CALL_THRESHOLD } = await import('../dist/audit/drive/end-drive.js');
const { __resetStore } = await import('../dist/gate/store.js');

const DISCOVER_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: 0 };

function makePayload(platform, observedNotLifted, overrides = {}) {
  return {
    sessionId: 'sess-fab',
    platform,
    endDriveAttempts: 0,
    declaredCapabilityCount: 1,
    writeActions: [],
    heavyReCallCount: 0,
    jsEvalCallCount: 0,
    persistCallCount: 0,
    actionCallCount: 0,
    saveAttemptCount: 0,
    saveSuccessCount: 1,
    skipDeclarationGuard: false,
    rePersistenceThreshold: DISCOVER_THRESHOLD,
    triageWouldFire: false,
    observedNotLifted,
    graph: 'discover',
    observedCapabilityCount: observedNotLifted.length,
    httpFailureCount: 0,
    unsavedHotXhrEndpoints: [],
    abandonedSaveAttemptsNotRetried: [],
    ...overrides,
  };
}

function writeStrategy(platform, capability) {
  const dir = path.join(TMP, 'skills', platform, 'fetch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${capability}.json`),
    JSON.stringify(
      { strategy: 'fetch', endpoint: `/api/${capability}`, method: 'GET' },
      null,
      2,
    ),
  );
}

test('structured covered_by with non-saved slug → ack rejected', () => {
  __resetStore();
  const platform = 'test-ack-fab-bogus';
  // Don't write any strategies — covered_by names ghosts.
  const result = endDriveAudit.process(
    makePayload(platform, ['deferred_cap_a', 'deferred_cap_b']),
    {},
    {
      acks: {
        observed_capabilities_not_lifted: {
          reason:
            'deferring deferred_cap_a and deferred_cap_b — claimed covers below; runtime should reject because none of the covered_by slugs are on disk',
          covered_by: ['ghost_capability_x', 'another_phantom_y'],
        },
      },
    },
  );
  assert.equal(result.status, 'rejected');
  const ackIssues = result.rejection.ack_issues ?? [];
  const fabIssue = ackIssues.find(
    (s) => s.includes('ghost_capability_x') || s.includes('another_phantom_y'),
  );
  assert.ok(
    fabIssue,
    `expected anti-fabrication rejection naming the bogus covers, got: ${JSON.stringify(ackIssues)}`,
  );
});

test('structured covered_by with real saved slug → ack accepted', () => {
  __resetStore();
  const platform = 'test-ack-fab-real';
  writeStrategy(platform, 'real_capability');
  const result = endDriveAudit.process(
    makePayload(platform, ['deferred_thing']),
    {},
    {
      acks: {
        observed_capabilities_not_lifted: {
          reason: 'deferring deferred_thing — covered by real_capability on disk from a prior session',
          covered_by: ['real_capability'],
        },
      },
    },
  );
  if (result.status === 'rejected') {
    const ackIssues = result.rejection.ack_issues ?? [];
    const fabIssues = ackIssues.filter((s) => s.includes("isn't") || s.includes("aren't"));
    assert.equal(
      fabIssues.length,
      0,
      `unexpected fabrication issues with real cover: ${JSON.stringify(fabIssues)}`,
    );
  }
});

test('mixed covered_by: one real + one bogus → only bogus rejected', () => {
  __resetStore();
  const platform = 'test-ack-fab-mixed';
  writeStrategy(platform, 'real_one');
  const result = endDriveAudit.process(
    makePayload(platform, ['slug_alpha', 'slug_beta']),
    {},
    {
      acks: {
        observed_capabilities_not_lifted: {
          reason: 'deferring slug_alpha and slug_beta — see covered_by',
          covered_by: ['real_one', 'ghost_two'],
        },
      },
    },
  );
  const ackIssues = result.rejection.ack_issues ?? [];
  const fabIssue = ackIssues.find((s) => s.includes('ghost_two'));
  assert.ok(fabIssue, `expected fabrication issue naming ghost_two, got: ${JSON.stringify(ackIssues)}`);
  assert.ok(!fabIssue.includes('real_one'), 'real cover must not be flagged');
});

test('reason with no cover claims → not flagged (anti-fabrication is opt-in)', () => {
  __resetStore();
  const platform = 'test-ack-fab-no-claim';
  const result = endDriveAudit.process(
    makePayload(platform, ['slug_x']),
    {},
    {
      acks: {
        observed_capabilities_not_lifted:
          'deferring slug_x — auth-walled, needs login flow before lifting',
      },
    },
  );
  if (result.status === 'rejected') {
    const ackIssues = result.rejection.ack_issues ?? [];
    const fabIssues = ackIssues.filter((s) => s.includes("isn't") || s.includes("aren't"));
    assert.equal(fabIssues.length, 0);
  }
});
