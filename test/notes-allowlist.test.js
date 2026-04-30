// Unit tests for the top-level notes allowlist — closes the cover-story
// escape hatch where agents wrote arbitrary subkeys under notes to bypass
// save-time guards keyed on specific enum values. Observed-capability
// pointers are now recorded via record_observed_capability (platform
// logbook), not under notes.

import test from 'node:test';
import assert from 'node:assert';
import { validateStrategyShape } from '../dist/strategies/skills.js';

function expectReject(data, matcher) {
  assert.throws(
    () => validateStrategyShape(data),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      if (matcher instanceof RegExp) assert.match(err.message, matcher);
      else if (typeof matcher === 'string') assert.ok(err.message.includes(matcher));
      return true;
    },
  );
}

const base = () => ({
  strategy: 'fetch',
  baseUrl: 'https://api.example.com',
  endpoint: '/x',
});

// ---- valid allowlisted keys ----

test('notes with no keys accepted', () => {
  validateStrategyShape({ ...base(), notes: {} });
});

test('notes.params accepted (valid shape)', () => {
  validateStrategyShape({
    ...base(),
    notes: { params: { text: { description: 'message body', kind: 'text', example: 'hello' } } },
  });
});

// ---- removed keys are rejected ----

test('notes.quirks is rejected (removed key)', () => {
  expectReject(
    { ...base(), notes: { quirks: 'a' } },
    /notes has unknown field "quirks"/,
  );
});

test('notes.auth is rejected (removed key)', () => {
  expectReject(
    { ...base(), notes: { auth: 'cookie' } },
    /notes has unknown field "auth"/,
  );
});

test('notes.discovery is rejected (removed key)', () => {
  expectReject(
    { ...base(), notes: { discovery: 'classified via text_contains' } },
    /notes has unknown field "discovery"/,
  );
});

test('notes.discovery_attempts is rejected (removed key)', () => {
  expectReject(
    { ...base(), notes: { discovery_attempts: [] } },
    /notes has unknown field "discovery_attempts"/,
  );
});

test('notes.changelog is rejected (removed key)', () => {
  expectReject(
    { ...base(), notes: { changelog: 'changed' } },
    /notes has unknown field "changelog"/,
  );
});

// ---- the cover-story closure ----

test('notes.<arbitrary_subkey> is rejected with allowlist hint', () => {
  expectReject(
    { ...base(), notes: { higher_tier_future_work: 'a future agent could lift this' } },
    /notes has unknown field "higher_tier_future_work"/,
  );
});

test('notes.<another_unknown_subkey> is rejected', () => {
  expectReject(
    { ...base(), notes: { graduation_plan: 'someday this will be fetch' } },
    /notes has unknown field "graduation_plan"/,
  );
});

// ---- combined ----

test('allowlisted keys (params only, observed_capabilities moved) accepted', () => {
  validateStrategyShape({
    ...base(),
    notes: {
      params: { text: { description: 'body', kind: 'text', example: 'hi' } },
    },
  });
});

test('notes.observed_capabilities is rejected (moved to platform logbook)', () => {
  expectReject(
    {
      ...base(),
      notes: {
        observed_capabilities: [{
          name: 'lookup_thread_by_name',
          evidence: { endpoint: '/x' },
          why_not_lifted: 'separate_capability',
        }],
      },
    },
    /notes has unknown field "observed_capabilities"/,
  );
});

// Multiple unknown keys in one save are reported in a single rejection.
// Without batching, the agent burns one round per invented key — see the
// platform-map warm/task path that hit `auth` then `discovery` sequentially.
test('multiple unknown notes fields are batched into one rejection', () => {
  assert.throws(
    () => validateStrategyShape({ ...base(), notes: { auth: 'cookie', discovery: 'classified' } }),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      assert.match(err.message, /notes has unknown fields/);
      assert.match(err.message, /"auth"/);
      assert.match(err.message, /"discovery"/);
      return true;
    },
  );
});
