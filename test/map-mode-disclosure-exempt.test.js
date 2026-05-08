// Disclosure-toggle exemption for the map-mode consent gate.
//
// Accordion section headers, dropdown triggers, expandable panels —
// elements that flip local UI state via aria-expanded / aria-controls /
// <summary> — are structurally read-only with respect to the user's
// account. The map-mode gate exempts them so an agent walking a platform
// to enrich the logbook can expand sections and reveal hidden content
// without per-toggle consent acks.
//
// The submitLike / formaction guards still run first, so a button that's
// both a form submit AND a disclosure toggle still gates correctly.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-mm-disclosure-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const { performAction } = await import('../dist/index.js');
const { pool } = await import('../dist/runtime-state/index.js');

function fakeSession({ graph, clickTarget }) {
  let clicks = 0;
  const fakeDriver = {
    getDebuggerPauseState: () => null,
    click: async () => {
      clicks += 1;
      return { name: 'btn' };
    },
    delay: async () => {},
    getUrl: async () => 'https://x.example/',
    getAccessibilityTree: async () => '<root />',
    inspectActionTarget: async () => clickTarget ?? null,
    consumePendingNavs: async () => [],
    captureFormSummary: async () => [],
  };
  const session = {
    id: 'sess-disc-' + Math.random().toString(36).slice(2, 8),
    graph,
    performActionHistory: [],
    extractedContentBytes: 0,
    domNavigations: [],
  };
  const origGet = pool.getSession;
  const origDriver = pool.driverFor;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.driverFor = (id) => (id === session.id ? fakeDriver : origDriver.call(pool, id));
  return {
    session,
    getClickCount: () => clicks,
    restore: () => {
      pool.getSession = origGet;
      pool.driverFor = origDriver;
    },
  };
}

test('map graph: click on aria-expanded button (accordion) → no consent', async () => {
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'button',
      href: null,
      onclick: null,
      formaction: null,
      inputType: '',
      inWriteForm: false,
      submitLike: false,
      isDisclosureToggle: true,
    },
  });
  try {
    const r = await performAction(session.id, 'click', 'button[aria-expanded="false"]');
    assert.ok(r);
    assert.equal(getClickCount(), 1, 'disclosure-toggle click should dispatch without consent');
  } finally {
    restore();
  }
});

test('map graph: click on <summary> inside <details> → no consent', async () => {
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'summary',
      href: null,
      onclick: null,
      formaction: null,
      inputType: '',
      inWriteForm: false,
      submitLike: false,
      isDisclosureToggle: true,
    },
  });
  try {
    const r = await performAction(session.id, 'click', 'summary.section-header');
    assert.ok(r);
    assert.equal(getClickCount(), 1, '<summary> click should dispatch without consent');
  } finally {
    restore();
  }
});

test('map graph: submit-like button with aria-expanded → consent still required', async () => {
  // Edge case: a button that's both a form submit AND a disclosure toggle.
  // The submit risk wins; the gate fires.
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'button',
      href: null,
      onclick: null,
      formaction: null,
      inputType: '',
      inWriteForm: true,
      submitLike: true,
      isDisclosureToggle: true,
    },
  });
  try {
    let err;
    try {
      await performAction(session.id, 'click', 'button[aria-expanded="false"][type="submit"]');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'submit-like + disclosure should still gate');
    assert.match(err.message, /action_consent_required/);
    assert.equal(getClickCount(), 0);
  } finally {
    restore();
  }
});

test('map graph: button with neither submitLike nor disclosure → still gates', async () => {
  // Sanity: a vanilla unbound button (no href, no submit role, no disclosure)
  // remains gated. The exemption only covers the structural disclosure shape.
  const { session, getClickCount, restore } = fakeSession({
    graph: 'map',
    clickTarget: {
      tag: 'button',
      href: null,
      onclick: null,
      formaction: null,
      inputType: '',
      inWriteForm: false,
      submitLike: false,
      isDisclosureToggle: false,
    },
  });
  try {
    let err;
    try {
      await performAction(session.id, 'click', 'button.menu-trigger');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'plain button without disclosure signal still gates');
    assert.match(err.message, /action_consent_required/);
    assert.equal(getClickCount(), 0);
  } finally {
    restore();
  }
});
