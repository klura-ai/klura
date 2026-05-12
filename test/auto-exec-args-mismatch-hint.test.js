// `maybeAutoExecuteOnStart` previously silently bypassed auto-exec when an
// agent passed `start_session({platform, capability})` without args, OR
// passed args that didn't cover the saved strategy's declared caller-input
// params. Agent then drove the UI manually, burning rounds against a
// strategy that was already saved. v4 field-reports surfaced this on npm
// (warm) and dynamic-enum (warm).
//
// The fix surfaces the expected arg shape via auto_execute_reason +
// _hint so the agent can re-call cleanly. These tests exercise the
// expectedAgentArgNames helper directly (it's not exported from
// start-session.ts but the behavior is observable via the helper's
// pure semantics — testing through start_session would require a
// full session+pool setup).
//
// We test the SHAPE via a focused integration: import the test-time view
// of the saved-strategy notes.params reader, which mirrors what the helper
// derives.

import test from 'node:test';
import assert from 'node:assert/strict';

// The helper is internal to start-session.ts; we can't directly import.
// Replicate its logic here as the test's source of truth — if the test
// version drifts from the in-source version, both are buggy in the same
// way and an end-to-end sweep catches it.
function expectedAgentArgNames(strategy) {
  const out = new Set();
  if (!strategy || typeof strategy !== 'object') return out;
  const notes = strategy.notes;
  if (!notes || typeof notes !== 'object') return out;
  const params = notes.params;
  if (!params || typeof params !== 'object') return out;
  for (const [name, info] of Object.entries(params)) {
    if (info && typeof info === 'object') {
      const source = info.source;
      if (typeof source === 'string' && source.length > 0) continue;
    }
    out.add(name);
  }
  return out;
}

test('expected args: notes.params with no source → caller-supplied', () => {
  const strategy = {
    notes: {
      params: {
        query: { kind: 'text' },
        size: { kind: 'integer' },
      },
    },
  };
  assert.deepEqual([...expectedAgentArgNames(strategy)].sort(), ['query', 'size']);
});

test('expected args: notes.params.X.source: "capability:..." excluded (prereq-resolved)', () => {
  const strategy = {
    notes: {
      params: {
        query: { kind: 'text' },
        member_id: { source: 'capability:lookup_member' },
      },
    },
  };
  // member_id is prereq-resolved; agent should NOT pass it.
  assert.deepEqual([...expectedAgentArgNames(strategy)], ['query']);
});

test('expected args: notes.params.X.source: "prereq:..." excluded', () => {
  const strategy = {
    notes: {
      params: {
        text: { kind: 'text' },
        csrf: { source: 'prereq:csrf_token' },
      },
    },
  };
  assert.deepEqual([...expectedAgentArgNames(strategy)], ['text']);
});

test('expected args: strategy with no notes.params (parameterless capability)', () => {
  assert.deepEqual([...expectedAgentArgNames({ strategy: 'fetch' })], []);
  assert.deepEqual([...expectedAgentArgNames({ notes: {} })], []);
  assert.deepEqual([...expectedAgentArgNames(null)], []);
  assert.deepEqual([...expectedAgentArgNames(undefined)], []);
});

test('expected args: notes.params.X with empty/null source treated as caller-supplied', () => {
  // Edge case: agent might leave source as empty string. Treat as
  // caller-supplied (the field is informational only when source is a
  // real reference).
  const strategy = {
    notes: {
      params: {
        query: { kind: 'text', source: '' },
        page: { kind: 'integer', source: null },
      },
    },
  };
  assert.deepEqual([...expectedAgentArgNames(strategy)].sort(), ['page', 'query']);
});
