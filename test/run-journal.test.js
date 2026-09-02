import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  appendJournalFrame,
  encodeJournalFrame,
  calculateTerminalDescriptorDigest,
  appendDataBlob,
  canonicalJson,
  createRunNodeId,
  createRunOperationId,
  createRunId,
  createRunMetaEnvelope,
  FileRunOutputSinkV1,
  parseRunOutput,
  partialOutputPath,
  preflightRunOutput,
  RunOutputError,
  parseJournalEvent,
  readJournal,
  readDataBlob,
  recoverJournalFile,
  RunStoreV1,
  RunJournalError,
  JOURNAL_EMERGENCY_BYTE_RESERVE_V1,
  sha256Digest,
} from '../consumer.js';

const require = createRequire(import.meta.url);
const { interruptUnfinishedRunsAtStartup } = require('../dist/consumer/scrape/startup-recovery.js');

function frame(runId, sequence, previousFrameDigest, event) {
  return {
    frame_schema_version: 1,
    run_id: runId,
    sequence,
    execution_epoch: 0,
    previous_frame_digest: previousFrameDigest,
    event,
  };
}

function terminalEvent(resultKind, stop = resultKind === 'scrape_outcome' ? { kind: 'source_exhausted' } : null) {
  const descriptor = {
    descriptor_schema_version: 1,
    result_kind: resultKind,
    stop,
    summary: {
      items_emitted: 0,
      items_duplicate: 0,
      tasks_completed: 0,
      tasks_failed: 0,
      target_requests: 0,
    },
    output: { kind: 'none' },
  };
  return {
    kind: 'terminal',
    descriptor,
    descriptor_digest: calculateTerminalDescriptorDigest(descriptor),
  };
}

test('run journal hash-chains canonical frames and recovers only an incomplete EOF suffix', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-journal-'));
  try {
    const journalPath = path.join(directory, 'journal.log');
    const runId = createRunId();
    const first = appendJournalFrame(
      journalPath,
      frame(runId, 1, null, { kind: 'run_created', meta_digest: 'a'.repeat(64) }),
      100_000,
    );
    const second = appendJournalFrame(
      journalPath,
      frame(runId, 2, first.digest, {
        kind: 'state_changed',
        state: { kind: 'running', execution_epoch: 0, current_node_id: null },
      }),
      100_000,
    );
    assert.equal(recoverJournalFile(journalPath, runId).frames.length, 2);
    fs.appendFileSync(journalPath, Buffer.from([0, 0, 1]));
    const recovered = recoverJournalFile(journalPath, runId);
    assert.equal(recovered.frames[1].digest, second.digest);
    assert.equal(fs.readFileSync(journalPath).byteLength, second.end_offset);
    const corrupt = fs.readFileSync(journalPath);
    corrupt[8] ^= 1;
    assert.throws(() => readJournal(corrupt, runId), RunJournalError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ordinary journal frames preserve the terminalization byte allowance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-journal-reserve-'));
  try {
    const journalPath = path.join(directory, 'journal.log');
    const runId = createRunId();
    const first = appendJournalFrame(
      journalPath,
      frame(runId, 1, null, { kind: 'run_created', meta_digest: 'a'.repeat(64) }),
      2_000_000,
    );
    const secondBody = frame(runId, 2, first.digest, {
      kind: 'state_changed',
      state: { kind: 'running', execution_epoch: 0, current_node_id: null },
    });
    const exactMaximum =
      first.end_offset + encodeJournalFrame(secondBody).byteLength + JOURNAL_EMERGENCY_BYTE_RESERVE_V1;
    assert.throws(
      () =>
        appendJournalFrame(
          journalPath,
          secondBody,
          exactMaximum - 1,
          undefined,
          JOURNAL_EMERGENCY_BYTE_RESERVE_V1,
        ),
      (error) => error instanceof RunJournalError && error.code === 'durable_budget_exhausted',
    );
    const second = appendJournalFrame(
      journalPath,
      secondBody,
      exactMaximum,
      undefined,
      JOURNAL_EMERGENCY_BYTE_RESERVE_V1,
    );
    assert.equal(second.body.sequence, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('run journal rejects an append that exceeds its signed frame budget', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-journal-frame-budget-'));
  try {
    const journalPath = path.join(directory, 'journal.log');
    const runId = createRunId();
    const first = appendJournalFrame(
      journalPath,
      frame(runId, 1, null, { kind: 'run_created', meta_digest: 'a'.repeat(64) }),
      100_000,
      1,
    );
    assert.throws(
      () =>
        appendJournalFrame(
          journalPath,
          frame(runId, 2, first.digest, {
            kind: 'state_changed',
            state: { kind: 'running', execution_epoch: 0, current_node_id: null },
          }),
          100_000,
          1,
        ),
      (error) => error instanceof RunJournalError && error.code === 'durable_budget_exhausted',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('run journal events are a closed structural union', () => {
  assert.deepEqual(
    parseJournalEvent({ kind: 'run_created', meta_digest: 'a'.repeat(64) }, 'event'),
    { kind: 'run_created', meta_digest: 'a'.repeat(64) },
  );
  assert.throws(
    () =>
      parseJournalEvent({ kind: 'run_created', meta_digest: 'a'.repeat(64), extra: true }, 'event'),
    /is not allowed/i,
  );
  assert.deepEqual(parseJournalEvent({ kind: 'cancel_requested', source: 'cli_cancel' }, 'event'), {
    kind: 'cancel_requested',
    source: 'cli_cancel',
  });
  assert.deepEqual(
    parseJournalEvent(
      {
        kind: 'sink_committed',
        through_item_sequence: 7,
        byte_offset: 42,
        prefix_digest: 'b'.repeat(64),
      },
      'event',
    ),
    {
      kind: 'sink_committed',
      through_item_sequence: 7,
      byte_offset: 42,
      prefix_digest: 'b'.repeat(64),
    },
  );
  assert.throws(
    () =>
      calculateTerminalDescriptorDigest({
        descriptor_schema_version: 1,
        result_kind: 'scrape_outcome',
        stop: { kind: 'source_exhausted' },
        summary: {
          items_emitted: 0,
          items_duplicate: 0,
          tasks_completed: 0,
          tasks_failed: 0,
          target_requests: 0,
        },
        output: {
          kind: 'file',
          path: `/${'x'.repeat(17_000)}`,
          format: 'ndjson',
          partial: false,
        },
      }),
    /16 KiB/,
  );
  assert.throws(
    () => parseJournalEvent({ kind: 'made_up' }, 'event'),
    /not a supported journal event/,
  );
});

test('run store persists immutable digest-bound metadata before run execution', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-run-store-'));
  try {
    const runId = createRunId();
    const store = new RunStoreV1(directory);
    const meta = runMeta(runId);
    const created = store.create(meta);
    assert.equal(store.read(runId).meta_digest, created.meta_digest);
    assert.equal(createRunMetaEnvelope(meta).meta_digest, created.meta_digest);
    assert.ok(fs.existsSync(store.journalPath(runId)));
    assert.throws(() => store.create(meta), /already exists/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('file outputs require an absolute normalized path and an unused regular parent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-run-output-'));
  try {
    const runId = createRunId();
    const output = parseRunOutput(
      {
        kind: 'file',
        requested_path: path.join(directory, 'items.ndjson'),
        format: 'ndjson',
      },
      'run.output',
    );
    assert.deepEqual(output, {
      kind: 'file',
      requested_path: path.join(directory, 'items.ndjson'),
      format: 'ndjson',
    });
    preflightRunOutput(output, runId);
    fs.writeFileSync(output.requested_path, 'taken');
    assert.throws(
      () => preflightRunOutput(output, runId),
      (error) => error instanceof RunOutputError && error.code === 'output_exists',
    );
    assert.throws(
      () =>
        parseRunOutput(
          { kind: 'file', requested_path: 'items.ndjson', format: 'ndjson' },
          'run.output',
        ),
      /absolute path/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup recovery marks only valid unfinished runs as interrupted', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-run-startup-recovery-'));
  try {
    const store = new RunStoreV1(directory);
    const unfinishedId = createRunId();
    const unfinished = store.create(runMeta(unfinishedId));
    appendJournalFrame(
      store.journalPath(unfinishedId),
      frame(unfinishedId, 1, null, { kind: 'run_created', meta_digest: unfinished.meta_digest }),
      393_432,
      6,
    );
    const terminalId = createRunId();
    const terminal = store.create(runMeta(terminalId));
    const terminalCreated = appendJournalFrame(
      store.journalPath(terminalId),
      frame(terminalId, 1, null, { kind: 'run_created', meta_digest: terminal.meta_digest }),
      393_432,
      6,
    );
    appendJournalFrame(
      store.journalPath(terminalId),
      frame(terminalId, 2, terminalCreated.digest, terminalEvent('scrape_outcome')),
      393_432,
      6,
    );
    const corruptId = createRunId();
    store.create(runMeta(corruptId));
    const cancelledId = createRunId();
    const cancelled = store.create(runMeta(cancelledId));
    const cancelledCreated = appendJournalFrame(
      store.journalPath(cancelledId),
      frame(cancelledId, 1, null, { kind: 'run_created', meta_digest: cancelled.meta_digest }),
      393_432,
      6,
    );
    appendJournalFrame(
      store.journalPath(cancelledId),
      frame(cancelledId, 2, cancelledCreated.digest, {
        kind: 'cancel_requested',
        source: 'cli_cancel',
      }),
      393_432,
      6,
    );

    const first = interruptUnfinishedRunsAtStartup(directory);
    assert.deepEqual(
      first.find((result) => result.run_id === unfinishedId),
      {
        run_id: unfinishedId,
        kind: 'interrupted',
      },
    );
    assert.deepEqual(
      first.find((result) => result.run_id === terminalId),
      {
        run_id: terminalId,
        kind: 'terminal',
      },
    );
    assert.deepEqual(
      first.find((result) => result.run_id === corruptId),
      {
        run_id: corruptId,
        kind: 'quarantined',
      },
    );
    assert.deepEqual(
      first.find((result) => result.run_id === cancelledId),
      {
        run_id: cancelledId,
        kind: 'cancelled',
      },
    );
    assert.deepEqual(
      recoverJournalFile(store.journalPath(cancelledId), cancelledId).frames.at(-1)?.body.event,
      terminalEvent('scrape_failure', 'cancelled'),
    );
    const frames = recoverJournalFile(store.journalPath(unfinishedId), unfinishedId).frames;
    assert.deepEqual(frames.at(-1)?.body.event, {
      kind: 'interrupted',
      reason: 'daemon_stopped',
    });

    const second = interruptUnfinishedRunsAtStartup(directory);
    assert.deepEqual(
      second.find((result) => result.run_id === unfinishedId),
      {
        run_id: unfinishedId,
        kind: 'already_interrupted',
      },
    );
    assert.equal(
      recoverJournalFile(store.journalPath(unfinishedId), unfinishedId).frames.length,
      2,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup recovery completes a prepared file output before marking a run interrupted', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-prepared-output-recovery-'));
  try {
    const store = new RunStoreV1(directory);
    const runId = createRunId();
    const output = {
      kind: 'file',
      requested_path: path.join(directory, 'items.ndjson'),
      format: 'ndjson',
    };
    const meta = runMeta(runId);
    meta.output = output;
    const created = store.create(meta);
    const sink = FileRunOutputSinkV1.create(output, runId, {
      csv_columns: null,
      max_output_bytes: 1_000,
    });
    sink.write({ id: '42' });
    const prepared = sink.prepareComplete();
    const descriptor = {
      descriptor_schema_version: 1,
      result_kind: 'scrape_outcome',
      stop: { kind: 'source_exhausted' },
      summary: {
        items_emitted: 1,
        items_duplicate: 0,
        tasks_completed: 1,
        tasks_failed: 0,
        target_requests: 1,
      },
      output: {
        kind: 'file',
        path: output.requested_path,
        format: 'ndjson',
        partial: false,
      },
    };
    const descriptorDigest = calculateTerminalDescriptorDigest(descriptor);
    const createdFrame = appendJournalFrame(
      store.journalPath(runId),
      frame(runId, 1, null, { kind: 'run_created', meta_digest: created.meta_digest }),
      393_432,
      6,
    );
    appendJournalFrame(
      store.journalPath(runId),
      frame(runId, 2, createdFrame.digest, {
        kind: 'output_prepared',
        path_digest: sha256Digest(output.requested_path),
        content_digest: prepared.content_digest,
        byte_length: prepared.byte_length,
        terminal_descriptor: descriptor,
        terminal_descriptor_digest: descriptorDigest,
      }),
      393_432,
      6,
    );
    assert.deepEqual(interruptUnfinishedRunsAtStartup(directory), [
      { run_id: runId, kind: 'terminal' },
    ]);
    assert.equal(fs.readFileSync(output.requested_path, 'utf8'), '{"id":"42"}\n');
    assert.equal(fs.existsSync(partialOutputPath(output, runId)), false);
    const frames = recoverJournalFile(store.journalPath(runId), runId).frames;
    assert.deepEqual(
      frames.slice(-2).map((frame) => frame.body.event.kind),
      ['output_committed', 'terminal'],
    );
    assert.deepEqual(frames.at(-1)?.body.event, {
      kind: 'terminal',
      descriptor,
      descriptor_digest: descriptorDigest,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup recovery publishes a cancellation partial file from the durable item ledger', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-cancelled-output-recovery-'));
  try {
    const store = new RunStoreV1(directory);
    const runId = createRunId();
    const output = {
      kind: 'file',
      requested_path: path.join(directory, 'items.ndjson'),
      format: 'ndjson',
    };
    const meta = runMeta(runId);
    meta.output = output;
    meta.effective_bounds.policy.durable.max_journal_frames = 20;
    const created = store.create(meta);
    const logicalKey = { kind: 'root', root_ordinal: 0, seed_ordinal: null };
    const nodeId = createRunNodeId(runId, logicalKey);
    const nodeState = appendDataBlob(
      store.dataSpoolPath(runId),
      {
        node_id: nodeId,
        logical_key: logicalKey,
        task_kind_id: 'product_page',
        capability: 'get_product',
        input: { id: '42' },
        root_ordinal: 0,
        seed_ordinal: null,
        depth: 0,
        output_ordinal: 0,
        seen_input_digests: [sha256Digest(canonicalJson({ id: '42' }))],
        pages_started_in_chain: 0,
      },
      10_000,
    );
    const item = { id: '42' };
    const itemData = appendDataBlob(store.dataSpoolPath(runId), item, 10_000);
    const identityDigest = sha256Digest(canonicalJson([item.id]));
    let previous = appendJournalFrame(
      store.journalPath(runId),
      frame(runId, 1, null, { kind: 'run_created', meta_digest: created.meta_digest }),
      393_432,
      20,
    );
    const append = (event) => {
      previous = appendJournalFrame(
        store.journalPath(runId),
        frame(runId, previous.body.sequence + 1, previous.digest, event),
        393_432,
        20,
      );
    };
    append({
      kind: 'node_enqueued',
      node_id: nodeId,
      logical_key_digest: sha256Digest(canonicalJson(logicalKey)),
      node_state: nodeState,
      task_kind_id: 'product_page',
      root_ordinal: 0,
      seed_ordinal: null,
      depth: 0,
      output_ordinal: 0,
    });
    append({ kind: 'attempt_intent', node_id: nodeId, task_kind_id: 'product_page' });
    append({
      kind: 'attempt_observed',
      node_id: nodeId,
      task_kind_id: 'product_page',
      result_kind: 'outcome',
      attempts: 1,
    });
    append({ kind: 'task_completed', node_id: nodeId, task_kind_id: 'product_page' });
    append({
      kind: 'item_buffered',
      node_id: nodeId,
      identity_digest: identityDigest,
      data: itemData,
      logical_order: { node_ordinal: 0, page_ordinal: 0, item_ordinal: 0 },
    });
    append({
      kind: 'item_committed',
      node_id: nodeId,
      identity_digest: identityDigest,
      logical_order: { node_ordinal: 0, page_ordinal: 0, item_ordinal: 0 },
      item_sequence: 1,
    });
    append({ kind: 'cancel_requested', source: 'cli_cancel' });

    assert.deepEqual(interruptUnfinishedRunsAtStartup(directory), [
      { run_id: runId, kind: 'cancelled' },
    ]);
    assert.equal(fs.readFileSync(partialOutputPath(output, runId), 'utf8'), '{"id":"42"}\n');
    const terminal = recoverJournalFile(store.journalPath(runId), runId).frames.at(-1)?.body.event;
    assert.equal(terminal?.kind, 'terminal');
    if (terminal?.kind === 'terminal') {
      assert.equal(terminal.descriptor.result_kind, 'scrape_partial');
      assert.equal(terminal.descriptor.stop, 'cancelled');
      assert.deepEqual(terminal.descriptor.summary, {
        items_emitted: 1,
        items_duplicate: 0,
        tasks_completed: 1,
        tasks_failed: 0,
        target_requests: 1,
      });
      assert.deepEqual(terminal.descriptor.output, {
        kind: 'file',
        path: partialOutputPath(output, runId),
        format: 'ndjson',
        partial: true,
      });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runMeta(runId) {
  return {
    meta_schema_version: 1,
    run_id: runId,
    start_operation_id: createRunOperationId(),
    artifact: {
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: 'a'.repeat(64),
      capability: 'get_product',
      runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      collection_contract_digest: 'b'.repeat(64),
    },
    canonical_input: { id: '42' },
    selected_input_mode_id: 'by_id',
    effective_bounds: {
      policy: {
        max_concurrency: 1,
        per_request_timeout_ms: 1_000,
        total_timeout_ms: 5_000,
        max_requests: 5,
        max_tasks: 5,
        max_pages: 5,
        max_items: 5,
        max_encoded_item_bytes: 512,
        max_output_bytes: 10_000,
        retry: {
          max_retries: 0,
          on: [],
          base_delay_ms: 100,
          max_delay_ms: 100,
          jitter_ratio: 0,
          honor_structural_retry_after: false,
        },
        durable: {
          max_frontier_bytes: 1_000,
          max_data_spool_bytes: 10_000,
          max_journal_bytes: 393_432,
          max_journal_frames: 6,
          max_reorder_buffer_bytes: 1_000,
          max_local_state_bytes: 100_000,
        },
      },
      named_limits: {},
    },
    output: { kind: 'inline' },
    created_at: '2026-07-27T12:00:00Z',
  };
}

test('data spool persists canonical blobs before a journal can reference them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-data-spool-'));
  try {
    const spoolPath = path.join(directory, 'data.spool');
    fs.writeFileSync(spoolPath, Buffer.alloc(0), { mode: 0o600 });
    const reference = appendDataBlob(spoolPath, { id: '42', rank: 1 }, 1_000);
    assert.deepEqual(readDataBlob(spoolPath, reference), { id: '42', rank: 1 });
    const bytes = fs.readFileSync(spoolPath);
    bytes[0] ^= 1;
    fs.writeFileSync(spoolPath, bytes);
    assert.throws(() => readDataBlob(spoolPath, reference), /digest/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
