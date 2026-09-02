// Caller-argument discovery for start-session auto-execute. This contract
// matches execution's notes.params preflight: sourced and optional params do
// not prevent a warm call from running.

import test from 'node:test';
import assert from 'node:assert/strict';
const { expectedAgentArgNames } = await import('../dist/tools/start-session.js');

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

test('expected args: notes.params.X.optional true excluded', () => {
  const strategy = {
    notes: {
      params: {
        query: { kind: 'text' },
        page: { kind: 'integer', optional: true },
        filters: { kind: 'json', optional: true },
      },
    },
  };
  assert.deepEqual([...expectedAgentArgNames(strategy)], ['query']);
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
