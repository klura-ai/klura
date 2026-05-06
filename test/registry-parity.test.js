// Tool registry parity tests. Asserts the registry is internally consistent
// and stays in sync with the vocab module.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { TOOL_REGISTRY, TOOL_NAMES } = await import('../dist/index.js');

test('TOOL_REGISTRY: every entry has a unique name', () => {
  const names = TOOL_REGISTRY.map((d) => d.name);
  const unique = new Set(names);
  assert.equal(names.length, unique.size, 'duplicate name(s) in TOOL_REGISTRY');
});

test('TOOL_REGISTRY: every entry.name is in TOOL_NAMES', () => {
  const validNames = new Set(Object.values(TOOL_NAMES));
  for (const def of TOOL_REGISTRY) {
    assert.ok(
      validNames.has(def.name),
      `TOOL_REGISTRY entry "${def.name}" not in TOOL_NAMES const map — add to vocab.ts first`,
    );
  }
});

test('TOOL_REGISTRY: every entry has a callable handler', () => {
  for (const def of TOOL_REGISTRY) {
    assert.equal(
      typeof def.handler,
      'function',
      `TOOL_REGISTRY entry "${def.name}" missing/invalid handler`,
    );
  }
});

test('TOOL_REGISTRY: every entry has a non-empty description', () => {
  for (const def of TOOL_REGISTRY) {
    assert.ok(
      typeof def.description === 'string' && def.description.length > 0,
      `TOOL_REGISTRY entry "${def.name}" missing description`,
    );
  }
});

test('TOOL_REGISTRY: every entry has an inputSchema object', () => {
  for (const def of TOOL_REGISTRY) {
    assert.equal(
      typeof def.inputSchema,
      'object',
      `TOOL_REGISTRY entry "${def.name}" missing inputSchema`,
    );
    assert.notEqual(def.inputSchema, null);
  }
});

test('TOOL_REGISTRY: every TOOL_NAMES value appears in the registry', () => {
  const registryNames = new Set(TOOL_REGISTRY.map((d) => d.name));
  const missing = Object.values(TOOL_NAMES).filter((n) => !registryNames.has(n));
  assert.deepEqual(
    missing,
    [],
    `TOOL_NAMES values missing from TOOL_REGISTRY: ${missing.join(', ')} — every named tool must have a TOOL_DEF`,
  );
});

test('TOOL_REGISTRY: gate-owning tools set their bypass flags', () => {
  const byName = new Map(TOOL_REGISTRY.map((d) => [d.name, d]));
  const ack = byName.get(TOOL_NAMES.ackCheckpoint);
  assert.ok(ack, 'ack_checkpoint missing from TOOL_REGISTRY');
  assert.equal(
    ack.skipCheckpointGate,
    true,
    'ack_checkpoint must set skipCheckpointGate:true — it resolves the pending checkpoint',
  );
  for (const name of [TOOL_NAMES.resolveInterruption, TOOL_NAMES.listInterruptionResolvers]) {
    const def = byName.get(name);
    assert.ok(def, `${name} missing from TOOL_REGISTRY`);
    assert.equal(
      def.skipInterruptionGate,
      true,
      `${name} must set skipInterruptionGate:true — interruption-resolver tools own the pending-interruption gate`,
    );
  }
});
