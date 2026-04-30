// Unit tests for the platform-map additions to the logbook:
// URL normalization, url_graph accretion, forms_seen merge, cross-session
// ingestion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-surface-map-'));
process.env.KLURA_HOME = TMP;

const { normalizeUrlForGraph } = await import('../dist/working-dir/url-graph.js');
const { ingestCaptureEvents } = await import('../dist/working-dir/writer.js');
const { loadLogbook, readUrlGraph, readFormsSeen } = await import(
  '../dist/working-dir/logbook.js'
);

function meta(sessionId, platform, tsOffset = 0) {
  return {
    at: Date.now() + tsOffset,
    session_id: sessionId,
    platform,
    kind: 'session_meta',
    payload: {
      started_at: Date.now() + tsOffset - 5_000,
      ended_at: Date.now() + tsOffset,
      outcome: 'no_save',
    },
  };
}

test('normalizeUrlForGraph — trailing slash stripped except at root', () => {
  assert.equal(normalizeUrlForGraph('https://X.com/'), 'https://x.com/');
  assert.equal(normalizeUrlForGraph('https://x.com/foo/'), 'https://x.com/foo');
  assert.equal(normalizeUrlForGraph('https://x.com/foo/bar/'), 'https://x.com/foo/bar');
});

test('normalizeUrlForGraph — scheme + host lowercased, path preserved', () => {
  assert.equal(
    normalizeUrlForGraph('HTTPS://Example.COM/Path/CasedBit'),
    'https://example.com/Path/CasedBit',
  );
});

test('normalizeUrlForGraph — session-ish params stripped', () => {
  const cases = [
    ['https://x.com/p?token=abc', 'https://x.com/p'],
    ['https://x.com/p?sid=xyz&page=2', 'https://x.com/p?page=2'],
    ['https://x.com/p?t=1712345678&foo=bar', 'https://x.com/p?foo=bar'],
    ['https://x.com/p?auth=xxx&csrf=yyy&nonce=zzz', 'https://x.com/p'],
    // UUID-shaped value
    [
      'https://x.com/p?ref=550e8400-e29b-41d4-a716-446655440000',
      'https://x.com/p',
    ],
    // long hex id
    ['https://x.com/p?id=deadbeefcafebabe12', 'https://x.com/p'],
    // long url-safe token
    ['https://x.com/p?sig=AbCdEfGhIjKlMnOpQrStUvWx', 'https://x.com/p'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeUrlForGraph(input), expected, `input: ${input}`);
  }
});

test('normalizeUrlForGraph — route-shape params preserved', () => {
  assert.equal(
    normalizeUrlForGraph('https://x.com/search?cuisine=sushi&page=2'),
    'https://x.com/search?cuisine=sushi&page=2',
  );
  assert.equal(
    normalizeUrlForGraph('https://x.com/search?page=2&cuisine=sushi'),
    'https://x.com/search?cuisine=sushi&page=2',
    'params alphabetized',
  );
});

test('normalizeUrlForGraph — invalid input returned verbatim', () => {
  assert.equal(normalizeUrlForGraph('not a url'), 'not a url');
});

test('url_graph accretion across sessions — first_visited preserved, last_visited bumped, session_count increments', () => {
  const platform = 'surface-map-1';
  const now = Date.now();

  ingestCaptureEvents(platform, 'sess_a', [
    meta('sess_a', platform, -60_000),
    {
      at: now - 60_000,
      session_id: 'sess_a',
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://site.com/home', via: 'nav' },
    },
    {
      at: now - 59_000,
      session_id: 'sess_a',
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://site.com/profile/', via: 'click' },
    },
  ]);

  ingestCaptureEvents(platform, 'sess_b', [
    meta('sess_b', platform, 0),
    {
      at: now,
      session_id: 'sess_b',
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://site.com/home', via: 'nav', title: 'Home' },
    },
  ]);

  const graph = readUrlGraph(platform);
  const home = graph.nodes.find((n) => n.url === 'https://site.com/home');
  const profile = graph.nodes.find((n) => n.url === 'https://site.com/profile');
  assert.ok(home, 'home node exists');
  assert.ok(profile, 'profile node exists (trailing slash stripped)');
  assert.equal(home.session_count, 2, 'home visited by 2 sessions');
  assert.equal(profile.session_count, 1, 'profile visited by 1 session');
  assert.ok(
    Date.parse(home.last_visited) > Date.parse(home.first_visited),
    'last_visited bumped past first_visited',
  );
  assert.equal(home.title, 'Home', 'title folded in');
});

test('url_graph edge dedup — same edge from two sessions = one entry', () => {
  const platform = 'surface-map-2';
  const navEvents = (sessionId) => [
    meta(sessionId, platform),
    {
      at: Date.now(),
      session_id: sessionId,
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://s.io/a', via: 'nav' },
    },
    {
      at: Date.now() + 100,
      session_id: sessionId,
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://s.io/b', via: 'click' },
    },
  ];

  ingestCaptureEvents(platform, 'sa', navEvents('sa'));
  ingestCaptureEvents(platform, 'sb', navEvents('sb'));

  const graph = readUrlGraph(platform);
  const matching = graph.edges.filter(
    (e) => e.from === 'https://s.io/a' && e.to === 'https://s.io/b',
  );
  assert.equal(matching.length, 1, 'one edge despite two sessions');
  assert.equal(matching[0].via, 'click');
});

test('forms_seen dedup + field merge across sessions', () => {
  const platform = 'surface-map-3';

  ingestCaptureEvents(platform, 'fs_a', [
    meta('fs_a', platform),
    {
      at: Date.now(),
      session_id: 'fs_a',
      platform,
      kind: 'dom_form_observed',
      payload: {
        url: 'https://site.com/signup/',
        action: 'https://site.com/api/signup',
        method: 'post',
        fields: [
          { name: 'email', type: 'email', required: true },
          { name: 'password', type: 'password', required: true },
        ],
      },
    },
  ]);

  ingestCaptureEvents(platform, 'fs_b', [
    meta('fs_b', platform, 10_000),
    {
      at: Date.now() + 10_000,
      session_id: 'fs_b',
      platform,
      kind: 'dom_form_observed',
      payload: {
        url: 'https://site.com/signup',
        action: 'https://site.com/api/signup',
        method: 'POST',
        fields: [
          // Retype password field -> type update wins
          { name: 'password', type: 'text', required: true },
          // New optional field
          { name: 'referral', type: 'text', required: false },
        ],
      },
    },
  ]);

  const forms = readFormsSeen(platform);
  assert.equal(forms.length, 1, 'method-case + trailing-slash normalized to one entry');
  const f = forms[0];
  assert.equal(f.method, 'POST');
  assert.equal(f.url, 'https://site.com/signup');
  const byName = Object.fromEntries(f.fields.map((x) => [x.name, x]));
  assert.equal(byName.email.type, 'email');
  assert.equal(byName.password.type, 'text', 'latest-seen type wins');
  assert.equal(byName.referral.required, false);
  assert.ok(Date.parse(f.last_seen) >= Date.parse(f.first_seen));
});

test('cross-session accretion — combined logbook carries both sessions', () => {
  const platform = 'surface-map-4';

  ingestCaptureEvents(platform, 's1', [
    meta('s1', platform),
    {
      at: Date.now(),
      session_id: 's1',
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://ex.co/', via: 'nav' },
    },
    {
      at: Date.now() + 10,
      session_id: 's1',
      platform,
      kind: 'dom_form_observed',
      payload: {
        url: 'https://ex.co/',
        action: 'https://ex.co/login',
        method: 'POST',
        fields: [{ name: 'u', type: 'text' }],
      },
    },
  ]);

  ingestCaptureEvents(platform, 's2', [
    meta('s2', platform, 5_000),
    {
      at: Date.now() + 5_000,
      session_id: 's2',
      platform,
      kind: 'dom_navigation',
      payload: { url: 'https://ex.co/dashboard', via: 'nav' },
    },
  ]);

  const logbook = loadLogbook(platform);
  assert.equal(logbook.sessions_total, 2);
  assert.equal(readUrlGraph(platform).nodes.length, 2, 'two distinct URL nodes');
  assert.equal(readFormsSeen(platform).length, 1);
});

test('readUrlGraph / readFormsSeen return empty defaults for unknown platform', () => {
  assert.deepEqual(readUrlGraph('never-seen'), { nodes: [], edges: [] });
  assert.deepEqual(readFormsSeen('never-seen'), []);
});
