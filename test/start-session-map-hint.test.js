// start_session graph: 'map' hint.
//
// Per-graph teaching for the map flow — fires once at start_session when
// graph: 'map' is active and no higher-priority _hint has claimed the slot
// (auto-execute, etc.). The hint comes from the active graph's
// `startSessionHint` GraphConfig knob.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-map-hint-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const { startSession } = await import('../dist/index.js');
const { pool } = await import('../dist/runtime-state.js');

function patchPoolForFakeBrowser() {
  const fakeDriver = {
    navigate: async () => {},
    getAccessibilityTree: async () => '<root />',
    getUrl: async () => 'https://x.example/',
    consumePendingNavs: async () => [],
    captureFormSummary: async () => [],
  };
  const fakeSession = {
    id: 'sess-map-hint-' + Math.random().toString(36).slice(2, 8),
    domNavigations: [],
    domFormsObserved: [],
    visitedUrls: [],
  };
  const origCreate = pool.createSession;
  const origDriver = pool.driverFor;
  pool.createSession = async () => fakeSession;
  pool.driverFor = (id) => (id === fakeSession.id ? fakeDriver : origDriver.call(pool, id));
  return () => {
    pool.createSession = origCreate;
    pool.driverFor = origDriver;
  };
}

test("graph: 'map' → response carries the map-graph start hint", async () => {
  const restore = patchPoolForFakeBrowser();
  try {
    const result = await startSession('https://x.example/', { graph: 'map' });
    assert.ok(result._hint, 'map graph has a hint');
    assert.match(result._hint, /Map mode/i);
    assert.match(result._hint, /mutating actions/);
    assert.ok(result._hint.length < 300, `hint should be terse, got ${result._hint.length} chars`);
  } finally {
    restore();
  }
});

test("graph: 'discover' → no map-graph hint", async () => {
  const restore = patchPoolForFakeBrowser();
  try {
    const result = await startSession('https://x.example/', { graph: 'discover' });
    if (result._hint) {
      assert.doesNotMatch(result._hint, /Map mode/);
    }
  } finally {
    restore();
  }
});

test('graph omitted → no map-graph hint (defaults to discover)', async () => {
  const restore = patchPoolForFakeBrowser();
  try {
    const result = await startSession('https://x.example/');
    if (result._hint) {
      assert.doesNotMatch(result._hint, /Map mode/);
    }
  } finally {
    restore();
  }
});
