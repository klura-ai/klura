// In-session lift nudge: when an agent records an observed capability
// with 2xx evidence on a map-graph session, the response carries an
// _hint suggesting `lift_observed_capability` in-session. Mirrors the
// end_drive observed_capabilities_not_lifted detector but earlier in
// the lifecycle — teach-at-moment-of-mistake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-lift-nudge-test-'));
process.env.KLURA_HOME = tmp;

const { recordObservedCapability } = await import(
  '../dist/tools/discovery-artifact-tools.js'
);
const { pool } = await import('../dist/runtime-state/index.js');

function patchPool(session) {
  const origGet = pool.getSession;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  return () => {
    pool.getSession = origGet;
  };
}

test('map-graph + 2xx evidence → _hint suggests lift_observed_capability', () => {
  const session = { id: 'sess-nudge-1', graph: 'map', status: 'active', platform: 'p' };
  const restore = patchPool(session);
  try {
    const result = recordObservedCapability({
      platform: 'p',
      name: 'list_orders',
      evidence: { source: 'get_network_log', request_i: 5, status: 200 },
      why_not_lifted: 'separate_capability',
      session_id: session.id,
    });
    assert.equal(result.ok, true);
    assert.ok(result._hint);
    assert.match(result._hint, /lift_observed_capability/);
    assert.match(result._hint, /list_orders/);
    assert.match(result._hint, /sess-nudge-1/);
  } finally {
    restore();
  }
});

test('non-map graph (discover) → no _hint (lift_observed_capability not available)', () => {
  const session = { id: 'sess-nudge-2', graph: 'discover', status: 'active', platform: 'p' };
  const restore = patchPool(session);
  try {
    const result = recordObservedCapability({
      platform: 'p',
      name: 'list_orders',
      evidence: { source: 'get_network_log', request_i: 5, status: 200 },
      why_not_lifted: 'separate_capability',
      session_id: session.id,
    });
    assert.equal(result.ok, true);
    assert.equal(result._hint, undefined);
  } finally {
    restore();
  }
});

test('non-2xx evidence (e.g. 403) → no _hint (not a graduation candidate)', () => {
  const session = { id: 'sess-nudge-3', graph: 'map', status: 'active', platform: 'p' };
  const restore = patchPool(session);
  try {
    const result = recordObservedCapability({
      platform: 'p',
      name: 'list_orders',
      evidence: { source: 'get_network_log', request_i: 5, status: 403 },
      why_not_lifted: 'separate_capability',
      session_id: session.id,
    });
    assert.equal(result.ok, true);
    assert.equal(result._hint, undefined);
  } finally {
    restore();
  }
});

test('no status in evidence → no _hint', () => {
  const session = { id: 'sess-nudge-4', graph: 'map', status: 'active', platform: 'p' };
  const restore = patchPool(session);
  try {
    const result = recordObservedCapability({
      platform: 'p',
      name: 'list_orders',
      evidence: { source: 'inferred' },
      why_not_lifted: 'separate_capability',
      session_id: session.id,
    });
    assert.equal(result.ok, true);
    assert.equal(result._hint, undefined);
  } finally {
    restore();
  }
});

test('no session_id (programmatic call) → no _hint', () => {
  const result = recordObservedCapability({
    platform: 'p',
    name: 'list_orders',
    evidence: { source: 'get_network_log', request_i: 5, status: 200 },
    why_not_lifted: 'separate_capability',
  });
  assert.equal(result.ok, true);
  assert.equal(result._hint, undefined);
});

test('closed session → no _hint (no remaining lift budget)', () => {
  const session = { id: 'sess-nudge-5', graph: 'map', status: 'closed', platform: 'p' };
  const restore = patchPool(session);
  try {
    const result = recordObservedCapability({
      platform: 'p',
      name: 'list_orders',
      evidence: { source: 'get_network_log', request_i: 5, status: 200 },
      why_not_lifted: 'separate_capability',
      session_id: session.id,
    });
    assert.equal(result.ok, true);
    assert.equal(result._hint, undefined);
  } finally {
    restore();
  }
});
