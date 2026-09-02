import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRunId,
  FileRunOutputSinkV1,
  partialOutputPath,
  privateOutputPath,
  RunOutputSinkError,
} from '../consumer.js';

test('file sink keeps each JSON prefix valid and atomically commits a completed output', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-output-sink-json-'));
  try {
    const runId = createRunId();
    const output = {
      kind: 'file',
      requested_path: path.join(directory, 'items.json'),
      format: 'json',
    };
    const sink = FileRunOutputSinkV1.create(output, runId, {
      csv_columns: null,
      max_output_bytes: 1000,
    });
    assert.equal(fs.readFileSync(privateOutputPath(output, runId), 'utf8'), '[]');
    const firstProgress = sink.write({ id: '42' });
    assert.equal(fs.readFileSync(privateOutputPath(output, runId), 'utf8'), '[{"id":"42"}]');
    assert.deepEqual(firstProgress, {
      byte_offset: Buffer.byteLength('[{"id":"42"}]', 'utf8'),
      prefix_digest: 'c0110210218e54ecc2730cda6a4cd5d1ef676cfa0f1d9f5b0989635a186a8fa4',
      items_written: 1,
    });
    sink.write({ id: '43' });
    assert.deepEqual(sink.commitComplete(), {
      path: output.requested_path,
      bytes_written: Buffer.byteLength('[{"id":"42"},{"id":"43"}]', 'utf8'),
      items_written: 2,
    });
    assert.equal(fs.readFileSync(output.requested_path, 'utf8'), '[{"id":"42"},{"id":"43"}]');
    assert.equal(fs.existsSync(privateOutputPath(output, runId)), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('file sink publishes valid NDJSON and declared CSV partial prefixes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-output-sink-partial-'));
  try {
    const runId = createRunId();
    const ndjson = {
      kind: 'file',
      requested_path: path.join(directory, 'items.ndjson'),
      format: 'ndjson',
    };
    const ndjsonSink = FileRunOutputSinkV1.create(ndjson, runId, {
      csv_columns: null,
      max_output_bytes: 1000,
    });
    ndjsonSink.write({ id: '42' });
    assert.equal(ndjsonSink.commitPartial().path, partialOutputPath(ndjson, runId));
    assert.equal(fs.readFileSync(partialOutputPath(ndjson, runId), 'utf8'), '{"id":"42"}\n');

    const csvRunId = createRunId();
    const csv = {
      kind: 'file',
      requested_path: path.join(directory, 'items.csv'),
      format: 'csv',
    };
    const csvSink = FileRunOutputSinkV1.create(csv, csvRunId, {
      csv_columns: [{ name: 'id', pointer: '/id' }],
      max_output_bytes: 1000,
    });
    csvSink.write({ id: '42' });
    assert.equal(csvSink.commitPartial().path, partialOutputPath(csv, csvRunId));
    assert.equal(fs.readFileSync(partialOutputPath(csv, csvRunId), 'utf8'), '"id"\n"42"\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('file sink enforces its exact byte budget before a partial write', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-output-sink-budget-'));
  try {
    const runId = createRunId();
    const output = {
      kind: 'file',
      requested_path: path.join(directory, 'items.json'),
      format: 'json',
    };
    const sink = FileRunOutputSinkV1.create(output, runId, {
      csv_columns: null,
      max_output_bytes: 2,
    });
    assert.throws(
      () => sink.write({ id: '42' }),
      (error) => error instanceof RunOutputSinkError && error.code === 'output_budget_exhausted',
    );
    assert.equal(fs.readFileSync(privateOutputPath(output, runId), 'utf8'), '[]');
    sink.discard();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
