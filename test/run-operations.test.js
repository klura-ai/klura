import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRunId,
  createRunOperationId,
  RunOperationError,
  RunOperationStoreV1,
} from '../consumer.js';

test('run operation records bind one operation id to canonical command arguments and replay one result', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-run-operation-'));
  try {
    const operationId = createRunOperationId();
    const runId = createRunId();
    const store = new RunOperationStoreV1(home);
    const first = store.reserve({
      operation_id: operationId,
      command: 'start',
      run_id: runId,
      arguments: { package_id: 'ikea', input: { id: '42' } },
    });
    assert.equal(first.kind, 'reserved');
    assert.equal(first.record.result, null);
    const replayedPending = new RunOperationStoreV1(home).reserve({
      operation_id: operationId,
      command: 'start',
      run_id: runId,
      arguments: { input: { id: '42' }, package_id: 'ikea' },
    });
    assert.equal(replayedPending.kind, 'replayed');
    const result = { kind: 'run_accepted', operation_id: operationId, run_id: runId };
    assert.deepEqual(store.complete(operationId, result).result, result);
    const replayedResult = new RunOperationStoreV1(home).reserve({
      operation_id: operationId,
      command: 'start',
      run_id: runId,
      arguments: { package_id: 'ikea', input: { id: '42' } },
    });
    assert.deepEqual(replayedResult, {
      kind: 'replayed',
      record: { ...first.record, result },
    });
    assert.throws(
      () =>
        store.reserve({
          operation_id: operationId,
          command: 'cancel',
          arguments: { run_id: runId },
        }),
      (error) => error instanceof RunOperationError && error.code === 'operation_conflict',
    );
    assert.throws(
      () => store.complete(operationId, { kind: 'different_result' }),
      (error) => error instanceof RunOperationError && error.code === 'operation_conflict',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('run operation store rejects a tampered durable record', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-run-operation-'));
  try {
    const operationId = createRunOperationId();
    const store = new RunOperationStoreV1(home);
    store.reserve({
      operation_id: operationId,
      command: 'discard',
      arguments: { run_id: createRunId() },
    });
    fs.writeFileSync(
      path.join(home, 'run-operations', `${operationId}.json`),
      '{"operation_schema_version":2}',
    );
    assert.throws(
      () => store.read(operationId),
      (error) => error instanceof RunOperationError && error.code === 'local_state_invalid',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
