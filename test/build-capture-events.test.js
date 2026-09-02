// Unit tests for buildCaptureEvents — the single reshape shared by end_drive
// and the capture-journal checkpoint. The load-bearing contract recovery relies
// on: the stream ALWAYS opens with a session_meta event, so a journal snapshot
// is foldable by ingestCaptureEvents without synthesis.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-build-events-'));
process.env.KLURA_HOME = TMP;

const { buildCaptureEvents } = await import('../dist/phases/drive/build-capture-events.js');

function fakeSession(overrides = {}) {
  return {
    id: 'sess_build',
    platform: 'build-p',
    startedAt: 900,
    declaredCapabilities: [{ capability: 'list_x', args: { q: 'alice' } }],
    savedCapabilities: [],
    domNavigations: [
      { at: 1002, url: 'https://build-p/', via: 'nav' },
      { at: 1003, url: 'https://build-p/products', via: 'click' },
    ],
    domFormsObserved: [
      {
        at: 1004,
        url: 'https://build-p/products',
        action: '/search',
        method: 'get',
        fields: [{ name: 'q', type: 'text' }],
      },
    ],
    performActionHistory: [{ at: 1005, action: 'click', selector: '#go' }],
    artifactAccumulator: undefined,
    ...overrides,
  };
}

test('stream always opens with a session_meta event', () => {
  const events = buildCaptureEvents(fakeSession(), [], [], []);
  assert.ok(events.length > 0);
  assert.equal(events[0].kind, 'session_meta');
  assert.equal(events[0].session_id, 'sess_build');
  assert.equal(events[0].platform, 'build-p');
  assert.equal(events[0].payload.started_at, 900);
});

test('reshapes http/ws/nav/form/action into matching CaptureEvent kinds', () => {
  const requests = [
    {
      method: 'GET',
      url: 'https://build-p/api/items',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      postData: null,
      status: 200,
      responseBody: '{"ok":true}',
      timestamp: 1001,
    },
  ];
  const wsFrames = [
    { direction: 'sent', url: 'wss://build-p/ws', payload: 'hello', timestamp: 1002 },
  ];
  const events = buildCaptureEvents(fakeSession(), requests, wsFrames, []);
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of [
    'session_meta',
    'http_request',
    'ws_frame',
    'dom_navigation',
    'dom_form_observed',
    'perform_action',
  ]) {
    assert.ok(kinds.has(k), `expected a ${k} event`);
  }
  const http = events.find((e) => e.kind === 'http_request');
  assert.equal(http.payload.status, 200);
  assert.equal(http.payload.contentType, 'application/json', 'content-type parsed off the header');
  assert.equal(http.payload.responseSize, '{"ok":true}'.length);
});

test('outcome reflects the best saved tier', () => {
  const withSave = fakeSession({ savedCapabilities: [{ capability: 'list_x', tier: 'fetch' }] });
  const meta = buildCaptureEvents(withSave, [], [], [])[0];
  assert.equal(meta.payload.outcome, 'fetch_saved');

  const noSave = buildCaptureEvents(fakeSession(), [], [], [])[0];
  assert.equal(noSave.payload.outcome, 'no_save');
});

test('mixed-tier saves fold to the canonical best tier (fetch over page-script)', () => {
  // The session_meta outcome and lift-attempt dedup both rank by the
  // canonical tier speed ordering (audit/concerns/tier-rank.ts), so a
  // session that saved both tiers reports the fetch win everywhere.
  const mixed = fakeSession({
    savedCapabilities: [
      { capability: 'list_x', tier: 'page-script' },
      { capability: 'list_x', tier: 'fetch' },
    ],
  });
  const meta = buildCaptureEvents(mixed, [], [], [])[0];
  assert.equal(meta.payload.outcome, 'fetch_saved');

  const pageScriptOnly = fakeSession({
    savedCapabilities: [{ capability: 'list_x', tier: 'page-script' }],
  });
  const psMeta = buildCaptureEvents(pageScriptOnly, [], [], [])[0];
  assert.equal(psMeta.payload.outcome, 'page_script_saved');
});
