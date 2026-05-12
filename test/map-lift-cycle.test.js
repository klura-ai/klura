// lift_observed_capability tool + map graph drive ⇄ triage ⇄ lift FSM.
//
// End-to-end of the map-only lift cycle:
//   1. Drive a fresh map session.
//   2. record_observed_capability registers a slug on the logbook.
//   3. lift_observed_capability transitions the FSM drive → triage.
//   4. The same call from lift transitions lift → triage (next slug).
//   5. Calling on a non-map session is rejected at the tool boundary.
//   6. Calling with an unknown slug is rejected with the observed list.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-map-lift-cycle-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const PLATFORM = 'klura-eats-test';

const { liftObservedCapability } = await import('../dist/tools/lift-observed-capability.js');
const { recordObservedCapability } = await import('../dist/tools/discovery-artifact-tools.js');
const { dispatch } = await import('../dist/phases/state-machine.js');
const { currentPhase, currentGraph } = await import('../dist/phases/registry.js');

function fakeMapSession(id) {
  return {
    id,
    platform: PLATFORM,
    graph: 'map',
    phase: 'drive',
    declaredCapabilities: [],
    drive: { enteredAt: Date.now(), roundsSinceEntry: 0, budget: 0, softBlockEngaged: false },
  };
}

function fakeDiscoverSession(id) {
  return {
    id,
    platform: PLATFORM,
    graph: 'discover',
    phase: 'drive',
    declaredCapabilities: [],
    drive: { enteredAt: Date.now(), roundsSinceEntry: 0, budget: 0, softBlockEngaged: false },
  };
}

async function patchPool(session) {
  const { pool } = await import('../dist/runtime-state/index.js');
  const origGet = pool.getSession;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  return () => {
    pool.getSession = origGet;
  };
}

test('lift_observed_capability: drive → triage transition on map session', async () => {
  const session = fakeMapSession('sess-map-lift-1');
  const restore = await patchPool(session);
  try {
    recordObservedCapability({
      platform: PLATFORM,
      name: 'search_restaurants',
      evidence: { source: 'network', endpoint: '/api/search' },
      why_not_lifted: 'separate_capability',
    });
    assert.equal(currentPhase(session), 'drive', 'session starts in drive');
    const result = liftObservedCapability({
      session_id: session.id,
      name: 'search_restaurants',
      args: { q: 'thai' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.phase, 'triage');
    assert.equal(currentPhase(session), 'triage', 'FSM transitioned to triage');
    assert.equal(session.declaredCapabilities.length, 1);
    assert.equal(session.declaredCapabilities[0].capability, 'search_restaurants');
    assert.deepEqual(session.declaredCapabilities[0].args, { q: 'thai' });
  } finally {
    restore();
  }
});

test('lift_observed_capability: lift → triage transition (next slug after save)', async () => {
  const session = fakeMapSession('sess-map-lift-2');
  const restore = await patchPool(session);
  try {
    recordObservedCapability({
      platform: PLATFORM,
      name: 'add_to_cart',
      evidence: { source: 'network', endpoint: '/api/cart/add' },
      why_not_lifted: 'separate_capability',
    });
    // Force the session into lift (simulating: drive → triage via lift_observed_capability,
    // then triage → lift via plan_handoff, then a successful save_strategy
    // call which doesn't itself dispatch resolved_via_save today).
    dispatch(session, { kind: 'lift_observed_capability_invoked' });
    dispatch(session, { kind: 'plan_handoff' });
    assert.equal(currentPhase(session), 'lift', 'session in lift before second lift call');
    const result = liftObservedCapability({
      session_id: session.id,
      name: 'add_to_cart',
      args: { restaurant_id: 'r-1', item_id: 'i-1', quantity: '1' },
    });
    assert.equal(result.ok, true);
    assert.equal(currentPhase(session), 'triage', 'lift → triage on second lift call');
  } finally {
    restore();
  }
});

test('lift_observed_capability: rejects when session graph is not map', async () => {
  const session = fakeDiscoverSession('sess-discover-1');
  const restore = await patchPool(session);
  try {
    assert.throws(
      () =>
        liftObservedCapability({
          session_id: session.id,
          name: 'whatever',
        }),
      /only available on map-graph sessions/,
    );
  } finally {
    restore();
  }
});

test('lift_observed_capability: rejects unknown slug, names observed ones', async () => {
  const session = fakeMapSession('sess-map-unknown-slug');
  const restore = await patchPool(session);
  try {
    recordObservedCapability({
      platform: PLATFORM,
      name: 'list_restaurants',
      evidence: { source: 'network', endpoint: '/api/restaurants' },
      why_not_lifted: 'separate_capability',
    });
    assert.throws(
      () =>
        liftObservedCapability({
          session_id: session.id,
          name: 'never_observed',
        }),
      (err) => {
        assert.match(err.message, /invalid_lift_capability/);
        assert.match(err.message, /never_observed/);
        assert.match(err.message, /record_observed_capability/);
        assert.match(err.message, /list_restaurants/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('lift_observed_capability: rejects when called from triage (active plan in flight)', async () => {
  const session = fakeMapSession('sess-map-from-triage');
  const restore = await patchPool(session);
  try {
    recordObservedCapability({
      platform: PLATFORM,
      name: 'list_orders',
      evidence: { source: 'network', endpoint: '/api/orders' },
      why_not_lifted: 'separate_capability',
    });
    dispatch(session, { kind: 'lift_observed_capability_invoked' });
    assert.equal(currentPhase(session), 'triage');
    assert.throws(
      () =>
        liftObservedCapability({
          session_id: session.id,
          name: 'list_orders',
        }),
      /can only be called from drive or lift/,
    );
  } finally {
    restore();
  }
});

test('graph: map session still has the map config (gateMutatingActions, skipAutoSynth)', async () => {
  const session = fakeMapSession('sess-map-config');
  const restore = await patchPool(session);
  try {
    const g = currentGraph(session);
    assert.equal(g.name, 'map');
    assert.equal(g.config.gateMutatingActions, true);
    assert.equal(g.config.skipAutoSynth, true);
    assert.equal(g.config.inferObservedCapabilitiesAtClose, true);
  } finally {
    restore();
  }
});
