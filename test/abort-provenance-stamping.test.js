// C4a: where an abort ledger entry's classification came from.
//
// `abort_session({kind: "origin_blocked"})` is the agent's conclusion. The
// runtime's own origin-blocked detector is the only thing that can corroborate
// it — so its advisories are recorded on the session, and the teardown stamps
// `runtime_observed` only when one of them names the host that was aborted on.
// Everything else is `agent_asserted`: a claim, which later sessions weigh as
// such.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-abort-provenance-'));
process.env.KLURA_HOME = TMP;

const { recordOriginBlockedObservation, findOriginBlockedObservation } = await import(
  '../dist/phases/origin-blocked-observations.js'
);
const { detectOriginBlocked } = await import('../dist/phases/origin-blocked-detector.js');
const { performAbortTeardown } = await import('../dist/tools/abort_session.js');
const { readRecentAborts } = await import('../dist/working-dir/logbook.js');
const { pool } = await import('../dist/runtime-state/index.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function advisory(overrides = {}) {
  return {
    detected: true,
    requested_host: 'shop.test',
    final_host: 'shop.test',
    nav_status: 403,
    signals: ['http_failure'],
    recommended_action: 'informational',
    ...overrides,
  };
}

// ---------- the session-scoped record ----------

test('recordOriginBlockedObservation: appends onto the session', () => {
  const session = {};
  recordOriginBlockedObservation(session, advisory());
  recordOriginBlockedObservation(session, advisory({ requested_host: 'other.test' }));
  assert.equal(session.originBlockedObservations.length, 2);
});

test('recordOriginBlockedObservation: bounded — a blocked session re-detects constantly', () => {
  const session = {};
  for (let i = 0; i < 50; i++) recordOriginBlockedObservation(session, advisory());
  assert.equal(session.originBlockedObservations.length, 20);
});

test('findOriginBlockedObservation: matches either end of the observed navigation', () => {
  const session = {};
  recordOriginBlockedObservation(
    session,
    advisory({ requested_host: 'shop.test', final_host: 'challenge.vendor.test' }),
  );
  assert.ok(findOriginBlockedObservation(session, 'shop.test'));
  assert.ok(findOriginBlockedObservation(session, 'challenge.vendor.test'));
  assert.ok(findOriginBlockedObservation(session, 'SHOP.TEST'), 'host match is case-insensitive');
  assert.equal(findOriginBlockedObservation(session, 'unrelated.test'), undefined);
});

test('findOriginBlockedObservation: a subdomain is a different host', () => {
  const session = {};
  recordOriginBlockedObservation(session, advisory({ requested_host: 'shop.test' }));
  assert.equal(findOriginBlockedObservation(session, 'api.shop.test'), undefined);
});

test('findOriginBlockedObservation: no observations / no host → undefined', () => {
  assert.equal(findOriginBlockedObservation({}, 'shop.test'), undefined);
  assert.equal(findOriginBlockedObservation({ originBlockedObservations: [] }, 'shop.test'), undefined);
  assert.equal(findOriginBlockedObservation({}, null), undefined);
});

test('the detector output is what gets recorded (hosts are already normalized)', () => {
  const detected = detectOriginBlocked({
    requestedUrl: 'https://SHOP.test/products',
    finalUrl: 'https://SHOP.test/products',
    navStatus: 403,
  });
  assert.ok(detected);
  const session = {};
  recordOriginBlockedObservation(session, detected);
  assert.ok(findOriginBlockedObservation(session, 'shop.test'));
});

// ---------- the teardown stamp ----------

function fakeSession(id, platform, overrides = {}) {
  return {
    id,
    platform,
    intercepted: [{ url: 'https://shop.test/products', isNavigation: true }],
    intercepting: false,
    performActionHistory: [],
    phase: 'drive',
    declaredCapabilities: [],
    ...overrides,
  };
}

function patchPool(session) {
  const origGet = pool.getSession;
  const origEnd = pool.endDrive;
  const origDriver = pool.driverFor;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.endDrive = async (id) => {
    if (id !== session.id) return origEnd.call(pool, id);
  };
  pool.driverFor = (id) =>
    id === session.id ? { saveStorageState: async () => {} } : origDriver.call(pool, id);
  return () => {
    pool.getSession = origGet;
    pool.endDrive = origEnd;
    pool.driverFor = origDriver;
  };
}

const payload = {
  reason: 'bot wall on every path tried, nothing loads',
  kind: 'anti_bot',
  phase_at_abort: 'drive',
  captured_actions_count: 0,
};

test('teardown: no corroborating observation → agent_asserted, no signals', async () => {
  const platform = 'stamp-agent';
  const session = fakeSession('sess_agent', platform);
  const restore = patchPool(session);
  try {
    await performAbortTeardown(session.id, payload);
  } finally {
    restore();
  }
  const [entry] = readRecentAborts(platform);
  assert.equal(entry.provenance, 'agent_asserted');
  assert.equal(entry.signals, undefined);
  assert.equal(entry.host, 'shop.test');
});

test('teardown: an observation on the aborted host → runtime_observed with its signals', async () => {
  const platform = 'stamp-runtime';
  const session = fakeSession('sess_runtime', platform, {
    originBlockedObservations: [
      advisory({ signals: ['http_failure', 'block_page_shape'] }),
    ],
  });
  const restore = patchPool(session);
  try {
    await performAbortTeardown(session.id, payload);
  } finally {
    restore();
  }
  const [entry] = readRecentAborts(platform);
  assert.equal(entry.provenance, 'runtime_observed');
  assert.deepEqual(entry.signals, ['http_failure', 'block_page_shape']);
});

test('teardown: an observation on a DIFFERENT host does not corroborate', async () => {
  const platform = 'stamp-mismatch';
  const session = fakeSession('sess_mismatch', platform, {
    originBlockedObservations: [
      advisory({ requested_host: 'elsewhere.test', final_host: 'elsewhere.test' }),
    ],
  });
  const restore = patchPool(session);
  try {
    await performAbortTeardown(session.id, payload);
  } finally {
    restore();
  }
  const [entry] = readRecentAborts(platform);
  assert.equal(
    entry.provenance,
    'agent_asserted',
    'an observation of another host is not evidence about this one',
  );
});
