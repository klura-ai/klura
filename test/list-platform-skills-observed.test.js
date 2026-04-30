// Integration test: listPlatformSkills surfaces platform-level observed_capabilities
// from the working-dir logbook (not from per-strategy notes).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-list-platform-skills-observed-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const { saveStrategy, listPlatformSkills } = await import('../dist/strategies/skills.js');
const { recordObservedCapability } = await import('../dist/working-dir/logbook.js');

test('listPlatformSkills surfaces platform observed_capabilities recorded via the logbook writer', () => {
  saveStrategy('test-platform-a', 'send_message', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages',
    method: 'POST',
  });
  recordObservedCapability('test-platform-a', {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search', method: 'POST', request_i: 12 },
    why_not_lifted: 'separate_capability',
  });

  const skills = listPlatformSkills();
  const platform = skills.find((s) => s.platform === 'test-platform-a');
  assert.ok(platform, 'platform should be in listPlatformSkills output');
  assert.ok(Array.isArray(platform.observed_capabilities));
  assert.equal(platform.observed_capabilities.length, 1);
  assert.equal(platform.observed_capabilities[0].name, 'lookup_thread_by_name');
  assert.equal(platform.observed_capabilities[0].why_not_lifted, 'separate_capability');
  assert.equal(platform.observed_capabilities[0].observed_in_sessions, 1);
  assert.ok(platform.observed_capabilities[0].last_observed_at);
});

test('listPlatformSkills omits observed_capabilities when none recorded for the platform', () => {
  saveStrategy('test-platform-b', 'send_message', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages',
    method: 'POST',
  });
  const skills = listPlatformSkills();
  const platform = skills.find((s) => s.platform === 'test-platform-b');
  assert.equal(platform.observed_capabilities, undefined);
});

test('listPlatformSkills dedupes observed_capabilities by name across repeated records', () => {
  recordObservedCapability('test-platform-c', {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search' },
    why_not_lifted: 'separate_capability',
  });
  recordObservedCapability('test-platform-c', {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search', request_i: 4 },
    why_not_lifted: 'separate_capability',
  });
  saveStrategy('test-platform-c', 'send_message', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages',
    method: 'POST',
  });
  const skills = listPlatformSkills();
  const platform = skills.find((s) => s.platform === 'test-platform-c');
  assert.equal(platform.observed_capabilities.length, 1, 'name-dedupe');
});

test('listPlatformSkills surfaces multiple distinct observed_capabilities', () => {
  recordObservedCapability('test-platform-d', {
    name: 'lookup_thread_by_name',
    evidence: { source: 'network', endpoint: '/api/search' },
    why_not_lifted: 'separate_capability',
  });
  recordObservedCapability('test-platform-d', {
    name: 'list_unread_threads',
    evidence: { source: 'network', endpoint: '/api/inbox' },
    why_not_lifted: 'turn_budget',
  });
  saveStrategy('test-platform-d', 'send_message', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages',
    method: 'POST',
  });

  const skills = listPlatformSkills();
  const platform = skills.find((s) => s.platform === 'test-platform-d');
  assert.equal(platform.observed_capabilities.length, 2);
  const names = platform.observed_capabilities.map((o) => o.name).sort();
  assert.deepEqual(names, ['list_unread_threads', 'lookup_thread_by_name']);
});

test('notes.observed_capabilities on a saved strategy is rejected at save time', () => {
  assert.throws(
    () => saveStrategy('test-platform-e', 'send_message', {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/messages',
      method: 'POST',
      notes: {
        observed_capabilities: [{
          name: 'lookup_thread_by_name',
          evidence: { endpoint: '/api/search' },
          why_not_lifted: 'separate_capability',
        }],
      },
    }),
    (err) => {
      assert.match(err.message, /notes has unknown field "observed_capabilities"/);
      assert.match(err.message, /record_observed_capability/);
      return true;
    },
  );
});
