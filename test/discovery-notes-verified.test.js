// Unit tests for the discovery-artifact `notes` + `verified_expressions`
// fields: validator shape, accumulator init, round-trip via buildAndMergeArtifact.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-notes-ve-test-'));
process.env.KLURA_HOME = TMP;

const mod = await import('../dist/strategies/discovery-artifact.js');
const {
  validateDiscoveryArtifactShape,
  buildAndMergeArtifact,
  ensureAccumulator,
  DISCOVERY_NOTE_KINDS,
  VERIFIED_EXPR_RETURNS,
  MAX_DISCOVERY_NOTES,
  MAX_VERIFIED_EXPRESSIONS,
} = mod;

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('DISCOVERY_NOTE_KINDS matches the schema', () => {
  assert.deepStrictEqual(DISCOVERY_NOTE_KINDS, [
    'function_hint',
    'module_path',
    'field_rotation',
    'byte_layout',
    'verified_expression',
    'open_question',
    'user_declined_send',
    'other',
  ]);
});

test('VERIFIED_EXPR_RETURNS lists expected shapes', () => {
  assert.deepStrictEqual(VERIFIED_EXPR_RETURNS, ['hex', 'base64', 'string', 'object']);
});

test('validateDiscoveryArtifactShape accepts artifact with notes + verified_expressions', () => {
  const artifact = {
    schema_version: 1,
    capability: 'send_message',
    created_at: '2026-04-17T00:00:00Z',
    updated_at: '2026-04-17T00:00:00Z',
    sessions_contributed: 1,
    resume_pointers: [],
    observations: [],
    tool_call_trace: [],
    notes: [
      {
        kind: 'module_path',
        body: 'encoder reachable via window.X.Y; returns ArrayBuffer length ~1254',
        at: '2026-04-17T00:00:00Z',
        verified: true,
      },
    ],
    verified_expressions: [
      {
        expression: "await window.X.Y({text:'{{text}}'})",
        binds_args: ['text'],
        returns: 'hex',
        sample_byte_length: 1254,
        tested_at: '2026-04-17T00:00:00Z',
      },
    ],
  };
  validateDiscoveryArtifactShape(artifact);
});

test('validator rejects note with invalid kind', () => {
  assert.throws(
    () =>
      validateDiscoveryArtifactShape({
        schema_version: 1,
        capability: 'cap_ok',
        created_at: 'a',
        updated_at: 'b',
        sessions_contributed: 0,
        resume_pointers: [],
        observations: [],
        tool_call_trace: [],
        notes: [{ kind: 'made_up_kind', body: 'x', at: 'a' }],
      }),
    /invalid.*kind|notes\[0\]/i,
  );
});

test('validator rejects verified_expression with bad returns', () => {
  assert.throws(
    () =>
      validateDiscoveryArtifactShape({
        schema_version: 1,
        capability: 'cap_ok',
        created_at: 'a',
        updated_at: 'b',
        sessions_contributed: 0,
        resume_pointers: [],
        observations: [],
        tool_call_trace: [],
        verified_expressions: [
          {
            expression: 'x',
            binds_args: [],
            returns: 'binary',
            tested_at: 'a',
          },
        ],
      }),
    /returns/,
  );
});

test('validator caps notes at 20', () => {
  const tooMany = Array.from({ length: 21 }, (_, i) => ({
    kind: 'other',
    body: `n${i}`,
    at: 'a',
  }));
  assert.throws(
    () =>
      validateDiscoveryArtifactShape({
        schema_version: 1,
        capability: 'cap_ok',
        created_at: 'a',
        updated_at: 'b',
        sessions_contributed: 0,
        resume_pointers: [],
        observations: [],
        tool_call_trace: [],
        notes: tooMany,
      }),
    /max 20/,
  );
});

test('ensureAccumulator initializes notes + verifiedExpressions', () => {
  const session = {};
  const acc = ensureAccumulator(session);
  assert.deepStrictEqual(acc.notes, {});
  assert.deepStrictEqual(acc.verifiedExpressions, {});
});

test('buildAndMergeArtifact persists current-session notes + verified_expressions', () => {
  const session = { performActionHistory: [] };
  const acc = ensureAccumulator(session);
  acc.notes.send_message = [
    { kind: 'module_path', body: 'MqttProtocolCodec.WireMessage.Publish', at: '2026-04-17T00:00:00Z', verified: true },
  ];
  acc.verifiedExpressions.send_message = [
    {
      expression: "await window.X.Y({text:'{{text}}'})",
      binds_args: ['text'],
      returns: 'hex',
      tested_at: '2026-04-17T00:00:00Z',
    },
  ];
  const { artifact } = buildAndMergeArtifact('testplat', 'send_message', acc, null, {
    now: '2026-04-17T00:00:00Z',
  });
  assert.strictEqual(artifact.notes.length, 1);
  assert.strictEqual(artifact.notes[0].kind, 'module_path');
  assert.strictEqual(artifact.verified_expressions.length, 1);
  assert.strictEqual(artifact.verified_expressions[0].returns, 'hex');
});

test('MAX caps are exposed', () => {
  assert.strictEqual(MAX_DISCOVERY_NOTES, 20);
  assert.strictEqual(MAX_VERIFIED_EXPRESSIONS, 5);
});
