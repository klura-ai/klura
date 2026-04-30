// Tests for the `platform_map` summary attached to start_session responses.
//
// The summary is a pure function of the on-disk logbook: it reads
// observed_capabilities + url_graph + forms_seen via the working-dir/logbook
// readers, condenses them into a turn-0 teaser, and points the agent at
// get_platform_logbook for detail. Tested directly against the builder so
// we don't need to spin up a browser session.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-platform-map-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const { buildPlatformMapSummary } = await import(
  '../dist/response/platform-map-summary.js'
);
const { recordObservedCapability, writeLogbook, loadLogbook } = await import(
  '../dist/working-dir/logbook.js'
);
const { ingestCaptureEvents } = await import('../dist/working-dir/writer.js');

function metaEvent(sessionId, platform, tsOffset = 0) {
  const at = Date.now() + tsOffset;
  return {
    at,
    session_id: sessionId,
    platform,
    kind: 'session_meta',
    payload: {
      started_at: at - 5_000,
      ended_at: at,
      outcome: 'no_save',
    },
  };
}

test('no logbook for platform → builder returns null', () => {
  const summary = buildPlatformMapSummary('never-seen-platform');
  assert.equal(summary, null);
});

test('empty logbook (zero counts, no observed) → builder returns null', () => {
  // Touch the logbook by writing an empty shell — exercises the
  // fully-empty branch (logbook exists on disk but carries no signal).
  const platform = 'pm-empty';
  writeLogbook({
    schema_version: 1,
    platform,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sessions_total: 0,
    per_capability: {},
    platform_wide: { signer_functions_seen: [], bundle_drift_events: [] },
    observed_capabilities: [],
    url_graph: { nodes: [], edges: [] },
    forms_seen: [],
  });
  const summary = buildPlatformMapSummary(platform);
  assert.equal(summary, null);
});

test('observed_capabilities only → counts are 0 for url_graph + forms_seen', () => {
  const platform = 'pm-observed-only';
  recordObservedCapability(platform, {
    name: 'lookup_thread',
    evidence: { source: 'network', endpoint: '/api/x' },
    why_not_lifted: 'separate_capability',
  });
  const summary = buildPlatformMapSummary(platform);
  assert.ok(summary, 'summary present');
  assert.equal(summary.url_graph.size, 0);
  assert.deepEqual(summary.url_graph.sample, []);
  assert.equal(summary.forms.size, 0);
  assert.deepEqual(summary.forms.sample, []);
  assert.equal(summary.observed_capabilities.length, 1);
  assert.equal(summary.observed_capabilities[0].name, 'lookup_thread');
  assert.equal(summary.observed_capabilities[0].why_not_lifted, 'separate_capability');
  assert.ok(summary.last_scanned);
  assert.equal(summary.hint, undefined, 'no hint when nothing truncated');
});

test('more than 5 observed_capabilities → top 5 by recency, hint set', () => {
  const platform = 'pm-overflow';
  // Record 7 observations spaced 100ms apart. Most recent should win.
  for (let i = 0; i < 7; i++) {
    recordObservedCapability(platform, {
      name: `cap_${i}`,
      evidence: { source: 'network' },
      why_not_lifted: 'separate_capability',
    });
    // Slight wait so last_observed_at differs across entries.
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
  }
  const summary = buildPlatformMapSummary(platform);
  assert.ok(summary);
  assert.equal(summary.observed_capabilities.length, 5);
  assert.match(summary.hint ?? '', /7 observed_capabilities total/);
  assert.match(summary.hint ?? '', /get_platform_logbook/);
  // Top entry is the most recent — cap_6 was recorded last.
  assert.equal(summary.observed_capabilities[0].name, 'cap_6');
  // cap_0 + cap_1 fell off the top-5 window.
  const names = summary.observed_capabilities.map((o) => o.name);
  assert.ok(!names.includes('cap_0'));
  assert.ok(!names.includes('cap_1'));
});

test('url_graph + forms_seen + observed_capabilities → all three counts present', () => {
  const platform = 'pm-full';

  ingestCaptureEvents(platform, 'sess_a', [
    metaEvent('sess_a', platform),
    {
      at: Date.now(),
      session_id: 'sess_a',
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://site.example/home', via: 'nav' },
    },
    {
      at: Date.now() + 50,
      session_id: 'sess_a',
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://site.example/profile', via: 'click' },
    },
    {
      at: Date.now() + 100,
      session_id: 'sess_a',
      platform,
      kind: 'dom_form_observed',
      payload: {
        url: 'https://site.example/login',
        action: 'https://site.example/api/login',
        method: 'POST',
        fields: [{ name: 'email', type: 'email', required: true }],
      },
    },
  ]);

  recordObservedCapability(platform, {
    name: 'message_user',
    evidence: { source: 'ui', selector: '[data-msg]' },
    why_not_lifted: 'turn_budget',
    hypothesis: 'POST /api/messages, signed with x-csrf header from /me',
  });

  const summary = buildPlatformMapSummary(platform);
  assert.ok(summary);
  assert.equal(summary.url_graph.size, 2);
  assert.equal(summary.url_graph.sample.length, 2);
  assert.equal(summary.forms.size, 1);
  assert.equal(summary.forms.sample.length, 1);
  assert.equal(summary.forms.sample[0].method, 'POST');
  assert.deepEqual(summary.forms.sample[0].fields, ['email']);
  assert.equal(summary.observed_capabilities.length, 1);
  assert.equal(summary.observed_capabilities[0].name, 'message_user');
  assert.equal(summary.observed_capabilities[0].why_not_lifted, 'turn_budget');

  // last_scanned >= logbook.updated_at and >= observation last_observed_at.
  const logbook = loadLogbook(platform);
  assert.ok(summary.last_scanned >= logbook.updated_at || summary.last_scanned === logbook.updated_at);
});

test('8 url_graph nodes → sample capped at 5 by recency', () => {
  const platform = 'pm-url-overflow';
  const events = [metaEvent('sess_u', platform)];
  const baseAt = Date.now();
  for (let i = 0; i < 8; i++) {
    events.push({
      at: baseAt + i * 100,
      session_id: 'sess_u',
      platform,
      kind: 'dom_navigation',
      payload: { url: `https://site.example/page${i}`, via: 'nav' },
    });
  }
  ingestCaptureEvents(platform, 'sess_u', events);
  const summary = buildPlatformMapSummary(platform);
  assert.ok(summary);
  assert.equal(summary.url_graph.size, 8);
  assert.equal(summary.url_graph.sample.length, 5, 'sample capped at 5');
  // Most-recent first — page7 should be present, page0 should not.
  assert.ok(summary.url_graph.sample.includes('https://site.example/page7'));
  assert.ok(!summary.url_graph.sample.includes('https://site.example/page0'));
  assert.match(summary.hint ?? '', /get_platform_logbook/);
});

test('7 forms_seen → form sample capped at 5 with action+method+fields', () => {
  const platform = 'pm-form-overflow';
  const events = [metaEvent('sess_f', platform)];
  const baseAt = Date.now();
  for (let i = 0; i < 7; i++) {
    events.push({
      at: baseAt + i * 100,
      session_id: 'sess_f',
      platform,
      kind: 'dom_form_observed',
      payload: {
        url: `https://site.example/form${i}`,
        action: `https://site.example/api/form${i}`,
        method: 'POST',
        fields: [
          { name: 'a', type: 'text' },
          { name: 'b', type: 'text' },
        ],
      },
    });
  }
  ingestCaptureEvents(platform, 'sess_f', events);
  const summary = buildPlatformMapSummary(platform);
  assert.ok(summary);
  assert.equal(summary.forms.size, 7);
  assert.equal(summary.forms.sample.length, 5);
  for (const f of summary.forms.sample) {
    assert.equal(f.method, 'POST');
    assert.deepEqual(f.fields, ['a', 'b']);
  }
});
