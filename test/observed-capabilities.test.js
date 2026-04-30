// Unit tests for recordObservedCapability — the platform-logbook writer for
// "I observed a companion capability but didn't lift it." Shape validation
// moved here from the save-time validators.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-observed-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const { recordObservedCapability, readObservedCapabilities } =
  await import('../dist/working-dir/logbook.js');

let counter = 0;
function fresh() {
  counter += 1;
  return `obs-plat-${counter}`;
}

function expectReject(fn, matcher) {
  assert.throws(fn, (err) => {
    assert.match(err.message, /^invalid_observed_capability:/);
    if (matcher instanceof RegExp) assert.match(err.message, matcher);
    else if (typeof matcher === 'string') assert.ok(err.message.includes(matcher));
    return true;
  });
}

// ---- valid cases ----

test('minimal observation is accepted and written to the logbook', () => {
  const platform = fresh();
  recordObservedCapability(platform, {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search' },
    why_not_lifted: 'separate_capability',
  });
  const out = readObservedCapabilities(platform);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'lookup_thread_by_name');
  assert.equal(out[0].why_not_lifted, 'separate_capability');
  assert.equal(out[0].observed_in_sessions, 1);
  assert.ok(out[0].first_observed_at);
  assert.ok(out[0].last_observed_at);
});

test('hypothesis is accepted when structural', () => {
  const platform = fresh();
  recordObservedCapability(platform, {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search' },
    why_not_lifted: 'separate_capability',
    hypothesis: 'GraphQL search endpoint observed in new-chat searchbox',
  });
  const out = readObservedCapabilities(platform);
  assert.equal(out[0].hypothesis, 'GraphQL search endpoint observed in new-chat searchbox');
});

test('ui-sourced observation accepted with free-form evidence fields', () => {
  const platform = fresh();
  recordObservedCapability(platform, {
    name: 'search_users',
    evidence: { source: 'ui', ui_selector: 'input[role="searchbox"]', ui_hint: 'new-chat searchbox' },
    why_not_lifted: 'turn_budget',
  });
  const out = readObservedCapabilities(platform);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.source, 'ui');
});

// ---- dedup + session tracking ----

test('repeated observations of the same name dedupe and bump per-session once', () => {
  const platform = fresh();
  const sid = 'sess-A';
  recordObservedCapability(platform, {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search' },
    why_not_lifted: 'separate_capability',
    session_id: sid,
  });
  recordObservedCapability(platform, {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search' },
    why_not_lifted: 'separate_capability',
    session_id: sid,
  });
  const out = readObservedCapabilities(platform);
  assert.equal(out.length, 1, 'dedup by name');
  assert.equal(out[0].observed_in_sessions, 1, 'session_id dedupe — one bump');
});

test('different sessions each bump observed_in_sessions', () => {
  const platform = fresh();
  recordObservedCapability(platform, {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search' },
    why_not_lifted: 'separate_capability',
    session_id: 'sess-B1',
  });
  recordObservedCapability(platform, {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search' },
    why_not_lifted: 'separate_capability',
    session_id: 'sess-B2',
  });
  const out = readObservedCapabilities(platform);
  assert.equal(out.length, 1);
  assert.equal(out[0].observed_in_sessions, 2);
});

// ---- validation rejections ----

test('missing name is rejected', () => {
  expectReject(() => recordObservedCapability('plat-x', {
    evidence: { source: 'network', endpoint: '/x' },
    why_not_lifted: 'separate_capability',
  }), /name/);
});

test('non-slug name (whitespace) is rejected', () => {
  expectReject(() => recordObservedCapability('plat-x', {
    name: 'lookup thread',
    evidence: { source: 'network', endpoint: '/x' },
    why_not_lifted: 'separate_capability',
  }), /name/);
});

test('missing evidence is rejected', () => {
  expectReject(() => recordObservedCapability('plat-x', {
    name: 'lookup_thread_by_name',
    why_not_lifted: 'separate_capability',
  }), /evidence/);
});

test('evidence without source is rejected', () => {
  expectReject(() => recordObservedCapability('plat-x', {
    name: 'lookup_thread_by_name',
    evidence: { endpoint: '/x' },
    why_not_lifted: 'separate_capability',
  }), /evidence\.source/);
});

test('unknown why_not_lifted enum value is rejected', () => {
  expectReject(() => recordObservedCapability('plat-x', {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/x' },
    why_not_lifted: 'lazy',
  }), /why_not_lifted/);
});

test('hypothesis > 800 chars is rejected', () => {
  expectReject(() => recordObservedCapability('plat-x', {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/x' },
    why_not_lifted: 'separate_capability',
    hypothesis: 'a'.repeat(801),
  }), /hypothesis/);
});
