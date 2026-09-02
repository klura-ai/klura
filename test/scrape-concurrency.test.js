import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseJsonSchema,
  planScrapeRun,
  readCommittedRunItems,
  recoverJournalFile,
  RunStoreV1,
  ScrapeRunServiceV1,
} from '../consumer.js';
import {
  maximumBufferedPageBytes,
  resolveBoundedAttemptConcurrency,
} from '../dist/consumer/scrape/attempt-order.js';

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function concurrentCollectionCapability() {
  const itemSchema = parseJsonSchema({
    type: 'object',
    properties: { id: { type: 'string', minLength: 1 } },
    required: ['id'],
    additionalProperties: false,
  });
  const inputSchema = parseJsonSchema({
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      ids: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 2,
      },
    },
    required: [],
    additionalProperties: false,
  });
  const collection = {
    collection_schema_version: 1,
    input_modes: {
      ordered_mode_ids: ['by_ids'],
      conflict_policy: 'reject',
      modes: [
        {
          id: 'by_ids',
          populated_when: { op: 'exists', ref: { from: 'args', pointer: '/ids' } },
          roots: [
            {
              task_kind: 'page',
              seed: {
                kind: 'for_each_input',
                array_pointer: '/ids',
                maximum: { id: 'seed_limit', kind: 'fixed', value: 2 },
                input: { id: { op: 'get', from: 'seed', pointer: '' } },
                start_url: null,
              },
            },
          ],
        },
      ],
    },
    start_url_templates: [],
    item_schema: itemSchema,
    item_identity: { pointers: ['/id'] },
    inline_output_bound: null,
    semantic_stops: [],
    csv_columns: null,
    task_kinds: [
      {
        id: 'page',
        capability: 'get_item',
        task_role: 'page',
        page_outcome_ids: ['success'],
        terminal_outcome_ids: [],
        emit: {
          items_pointer: '/item',
          cardinality: 'one',
          projection: { op: 'get', from: 'raw_item', pointer: '' },
          limit: null,
        },
        pagination: null,
        fanout: [],
        on_failure: 'stop_run',
      },
    ],
    max_fanout_depth: 0,
    run_policy: {
      max_concurrency: 2,
      per_request_timeout_ms: 1_000,
      total_timeout_ms: 5_000,
      max_requests: 2,
      max_tasks: 2,
      max_pages: 2,
      max_items: 2,
      max_encoded_item_bytes: 1_024,
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
        max_frontier_bytes: 10_000,
        max_data_spool_bytes: 10_000,
        max_journal_bytes: 393_432,
        max_journal_frames: 128,
        max_reorder_buffer_bytes: 10_000,
        max_local_state_bytes: 10_000,
      },
    },
  };
  return {
    description: 'Read one item.',
    visibility: 'public',
    effect: 'read',
    authentication: { mode: 'none' },
    request_origins: [],
    navigation_origins: [],
    origin_traffic_policies: [],
    browser_resources: null,
    max_target_requests_per_call: 1,
    max_encoded_outcome_bytes: 1_024,
    call_timeouts: { per_request_timeout_ms: 1_000, total_timeout_ms: 1_000 },
    input_schema: inputSchema,
    call_retry_policy: {
      max_retries: 0,
      on: [],
      base_delay_ms: 100,
      max_delay_ms: 100,
      jitter_ratio: 0,
      honor_structural_retry_after: false,
    },
    strategies: [],
    outcomes: [],
    control: null,
    collection,
  };
}

function paginatedCollectionCapability() {
  const capability = concurrentCollectionCapability();
  capability.input_schema = parseJsonSchema({
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      ids: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 2,
      },
      cursor: { type: 'string', minLength: 1 },
    },
    required: [],
    additionalProperties: false,
  });
  capability.collection.task_kinds[0].pagination = {
    contract: {
      kind: 'cursor',
      continue_when: { op: 'exists', ref: { from: 'task_data', pointer: '/next' } },
      exhausted_when: { op: 'not_exists', ref: { from: 'task_data', pointer: '/next' } },
      value_pointer: '/next',
      bind_input: 'cursor',
    },
    max_pages_per_chain: { id: 'page_limit', kind: 'fixed', value: 2 },
  };
  capability.collection.run_policy.max_requests = 4;
  capability.collection.run_policy.max_tasks = 4;
  capability.collection.run_policy.max_pages = 4;
  capability.collection.run_policy.max_items = 4;
  return capability;
}

test('scrape concurrency is bounded by the declared reordering buffer', () => {
  const capability = concurrentCollectionCapability();
  assert.equal(maximumBufferedPageBytes(capability.collection.run_policy, capability), 10_000);
  assert.equal(
    resolveBoundedAttemptConcurrency(capability.collection.run_policy, { get_item: capability }),
    2,
  );

  capability.collection.run_policy.durable.max_reorder_buffer_bytes = 9_999;
  assert.equal(
    resolveBoundedAttemptConcurrency(capability.collection.run_policy, { get_item: capability }),
    1,
  );
});

test('scrape planning rejects more initial roots than its signed task ceiling', () => {
  const capability = concurrentCollectionCapability();
  capability.collection.run_policy.max_tasks = 1;
  assert.throws(
    () => planScrapeRun(capability, { get_item: capability }, { ids: ['one', 'two'] }, {}),
    /initial root count exceeds the signed task ceiling/,
  );
});

test('fan-out retention is bounded across concurrent roots', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-fanout-retention-'));
  try {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const capability = concurrentCollectionCapability();
    capability.collection.task_kinds[0].fanout = [
      {
        id: 'detail',
        child_task_kind: 'detail',
        when: null,
        input: { id: { op: 'get', from: 'parent_item', pointer: '/id' } },
        child_tasks_per_parent: 1,
      },
    ];
    capability.collection.task_kinds.push({
      id: 'detail',
      capability: 'get_detail',
      task_role: 'detail',
      page_outcome_ids: ['success'],
      terminal_outcome_ids: [],
      emit: null,
      pagination: null,
      fanout: [],
      on_failure: 'stop_run',
    });
    capability.collection.max_fanout_depth = 1;
    capability.collection.run_policy.max_tasks = 4;
    capability.collection.run_policy.max_requests = 4;
    capability.collection.run_policy.durable.max_local_state_bytes = 150;
    const detailCapability = { ...capability, collection: null };
    const dispatchedCapabilities = [];
    const service = new ScrapeRunServiceV1(new RunStoreV1(home), {
      call: async (calledCapability, input) => {
        dispatchedCapabilities.push(calledCapability);
        if (input.id === 'first') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: input.id } },
          retry_after_ms: null,
          attempts: 1,
        };
      },
    });
    const running = service.start({
      artifact: {
        package_id: 'fixture',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_item',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner: capability,
      capabilities: { get_item: capability, get_detail: detailCapability },
      input: { ids: ['first', 'second'] },
      caller_bounds: {},
      output: { kind: 'file', requested_path: path.join(home, 'items.ndjson'), format: 'ndjson' },
    });
    await firstStarted.promise;
    releaseFirst.resolve();
    const result = await running;
    assert.equal(result.kind, 'scrape_partial');
    assert.equal(result.stop, 'run_budget_exhausted');
    assert.deepEqual(readCommittedRunItems(new RunStoreV1(home), result.run_id), [{ id: 'first' }]);
    assert.deepEqual(dispatchedCapabilities, [capability, capability]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('scrape runs dispatch bounded roots concurrently and commit their output in root order', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-scrape-concurrency-'));
  try {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const startedIds = [];
    const capability = concurrentCollectionCapability();
    const service = new ScrapeRunServiceV1(new RunStoreV1(home), {
      call: async (_capability, input) => {
        startedIds.push(input.id);
        if (input.id === 'first') {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
        }
        return {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: input.id } },
          retry_after_ms: null,
          attempts: 1,
        };
      },
    });
    const outputPath = path.join(home, 'items.ndjson');
    const running = service.start({
      artifact: {
        package_id: 'demo',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_item',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner: capability,
      capabilities: { get_item: capability },
      input: { ids: ['first', 'second'] },
      caller_bounds: {},
      output: { kind: 'file', requested_path: outputPath, format: 'ndjson' },
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    assert.deepEqual(startedIds, ['first', 'second']);
    releaseFirst.resolve();

    const result = await running;
    assert.deepEqual(result.summary, {
      items_emitted: 2,
      items_duplicate: 0,
      tasks_completed: 2,
      tasks_failed: 0,
      target_requests: 2,
    });
    assert.equal(readFileSync(outputPath, 'utf8'), '{"id":"first"}\n{"id":"second"}\n');
    const frames = recoverJournalFile(
      new RunStoreV1(home).journalPath(result.run_id),
      result.run_id,
    ).frames;
    const buffered = frames
      .map((frame) => frame.body.event)
      .filter((event) => event.kind === 'item_buffered');
    const committed = frames
      .map((frame) => frame.body.event)
      .filter((event) => event.kind === 'item_committed');
    const sinkCommits = frames
      .map((frame) => frame.body.event)
      .filter((event) => event.kind === 'sink_committed');
    assert.deepEqual(
      buffered.map((event) => event.logical_order),
      [
        { node_ordinal: 1, page_ordinal: 0, item_ordinal: 0 },
        { node_ordinal: 0, page_ordinal: 0, item_ordinal: 0 },
      ],
    );
    assert.deepEqual(committed.map((event) => event.item_sequence), [1, 2]);
    assert.deepEqual(sinkCommits.map((event) => event.through_item_sequence), [1, 2]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a paginated chain commits its full prefix before a faster later root', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-scrape-concurrency-'));
  try {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const capability = paginatedCollectionCapability();
    const service = new ScrapeRunServiceV1(new RunStoreV1(home), {
      call: async (_capability, input) => {
        if (input.id === 'second') {
          secondStarted.resolve();
          return {
            kind: 'outcome',
            outcome_id: 'success',
            outcome_class: 'success',
            case_id: 'success_case',
            data: { item: { id: 'second' } },
            retry_after_ms: null,
            attempts: 1,
          };
        }
        if (input.cursor === 'next') {
          return {
            kind: 'outcome',
            outcome_id: 'success',
            outcome_class: 'success',
            case_id: 'success_case',
            data: { item: { id: 'first-2' } },
            retry_after_ms: null,
            attempts: 1,
          };
        }
        firstStarted.resolve();
        await releaseFirst.promise;
        return {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: 'first-1' }, next: 'next' },
          retry_after_ms: null,
          attempts: 1,
        };
      },
    });
    const outputPath = path.join(home, 'items.ndjson');
    const running = service.start({
      artifact: {
        package_id: 'demo',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_item',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner: capability,
      capabilities: { get_item: capability },
      input: { ids: ['first', 'second'] },
      caller_bounds: {},
      output: { kind: 'file', requested_path: outputPath, format: 'ndjson' },
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    releaseFirst.resolve();
    await running;
    assert.equal(
      readFileSync(outputPath, 'utf8'),
      '{"id":"first-1"}\n{"id":"first-2"}\n{"id":"second"}\n',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stop-run failure prevents an already-started later root from emitting items', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-scrape-concurrency-'));
  try {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const capability = concurrentCollectionCapability();
    const service = new ScrapeRunServiceV1(new RunStoreV1(home), {
      call: async (_capability, input) => {
        if (input.id === 'first') {
          firstStarted.resolve();
          await releaseFirst.promise;
          return { kind: 'failure', code: 'transport_failure', attempts: 1 };
        }
        secondStarted.resolve();
        return {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: 'second' } },
          retry_after_ms: null,
          attempts: 1,
        };
      },
    });
    const resultPromise = service.start({
      artifact: {
        package_id: 'demo',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_item',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner: capability,
      capabilities: { get_item: capability },
      input: { ids: ['first', 'second'] },
      caller_bounds: {},
      output: {
        kind: 'file',
        requested_path: path.join(home, 'items.ndjson'),
        format: 'ndjson',
      },
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    releaseFirst.resolve();
    const result = await resultPromise;
    assert.equal(result.kind, 'scrape_failure');
    assert.equal(result.summary.items_emitted, 0);
    assert.equal(result.summary.target_requests, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a caller crash releases concurrent attempt waiters', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-scrape-concurrency-'));
  try {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const capability = concurrentCollectionCapability();
    const service = new ScrapeRunServiceV1(new RunStoreV1(home), {
      call: async (_capability, input) => {
        if (input.id === 'first') {
          firstStarted.resolve();
          await releaseFirst.promise;
          throw new Error('caller crashed');
        }
        secondStarted.resolve();
        return {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: input.id } },
          retry_after_ms: null,
          attempts: 1,
        };
      },
    });
    const running = service.start({
      artifact: {
        package_id: 'demo',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_item',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner: capability,
      capabilities: { get_item: capability },
      input: { ids: ['first', 'second'] },
      caller_bounds: {},
      output: { kind: 'file', requested_path: path.join(home, 'items.ndjson'), format: 'ndjson' },
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    releaseFirst.resolve();
    await assert.rejects(running, /caller crashed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
