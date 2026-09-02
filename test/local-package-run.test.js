import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  ConsumerLocalListingServiceV1,
  ConsumerScrapeRunServiceV1,
  InstalledPackageError,
  LocalPackageInstallerV1,
  PackageStoreV1,
  RunStoreV1,
  readCommittedRunItems,
  recoverJournalFile,
  recoverRunState,
  sha256Digest,
} from '../consumer.js';

const require = createRequire(import.meta.url);
const { compilePublicPackageSource } = require('../factory-compiler.js');
const { interruptUnfinishedRunsAtStartup } = require('../dist/consumer/scrape/startup-recovery.js');

const LOCAL_PACKAGE_ID = 'local-acme-store';
const RUNTIME_VERSION = '0.6.3';
const SOURCE_DIGEST = sha256Digest('acme-store-local-review');

function localCollectionPackageSource() {
  return {
    package_schema_version: 1,
    package_id: LOCAL_PACKAGE_ID,
    version: '1.0.0',
    authentication_contracts: {},
    capabilities: {
      list_products: {
        description: 'List public products.',
        visibility: 'public',
        effect: 'read',
        authentication: { mode: 'none' },
        request_origins: ['https://api.example.test'],
        navigation_origins: [],
        origin_traffic_policies: [
          {
            origin: 'https://api.example.test',
            max_concurrency: 1,
            requests_per_second: 1,
            burst: 1,
            min_delay_ms: 0,
            max_redirect_hops: 2,
            circuit_breaker: {
              transient_failure_threshold: 2,
              transient_window_ms: 30_000,
              cooldown_ms: 60_000,
            },
          },
        ],
        browser_resources: null,
        max_target_requests_per_call: 1,
        max_encoded_outcome_bytes: 16_384,
        call_timeouts: { per_request_timeout_ms: 5_000, total_timeout_ms: 5_000 },
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            ids: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              minItems: 1,
              maxItems: 4,
            },
          },
          required: [],
          additionalProperties: false,
        },
        call_retry_policy: {
          max_retries: 0,
          on: [],
          base_delay_ms: 100,
          max_delay_ms: 100,
          jitter_ratio: 0,
          honor_structural_retry_after: false,
        },
        strategies: [
          {
            kind: 'http_request',
            context: 'node',
            request: {
              strategy_id: 'request',
              method: 'GET',
              base_url: 'https://api.example.test',
              endpoint: { op: 'literal', value: '/products' },
              headers: { accept: { op: 'literal', value: 'application/json' } },
              query: { id: { op: 'input', pointer: '/id' } },
              body: null,
              response_body_limit_bytes: 65_536,
            },
            projection: { kind: 'json' },
            prerequisites: [],
            replay: 'safe_read',
          },
        ],
        outcomes: [
          {
            outcome_id: 'success',
            class: 'success',
            output_schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                item: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                  additionalProperties: false,
                },
              },
              required: ['ok', 'item'],
              additionalProperties: false,
            },
            cases: [
              {
                case_id: 'success_case',
                strategy_ids: ['request'],
                matcher: { op: 'all', items: [{ op: 'status_in', values: [200] }] },
                projection: { kind: 'body' },
                assertions: [],
                retry_after: null,
              },
            ],
          },
        ],
        control: null,
        collection: {
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
                    task_kind: 'product_page',
                    seed: {
                      kind: 'for_each_input',
                      array_pointer: '/ids',
                      maximum: { id: 'seed_limit', kind: 'fixed', value: 4 },
                      input: { id: { op: 'get', from: 'seed', pointer: '' } },
                      start_url: null,
                    },
                  },
                ],
              },
            ],
          },
          start_url_templates: [],
          item_schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
          item_identity: { pointers: ['/id'] },
          inline_output_bound: null,
          semantic_stops: [],
          csv_columns: null,
          task_kinds: [
            {
              id: 'product_page',
              capability: 'list_products',
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
            max_concurrency: 1,
            per_request_timeout_ms: 1_000,
            total_timeout_ms: 5_000,
            max_requests: 4,
            max_tasks: 4,
            max_pages: 4,
            max_items: 4,
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
              max_frontier_bytes: 10_000,
              max_data_spool_bytes: 10_000,
              max_journal_bytes: 393_432,
              max_journal_frames: 128,
              max_reorder_buffer_bytes: 10_000,
              max_local_state_bytes: 100_000,
            },
          },
        },
      },
    },
  };
}

function installLocalCollectionPackage(home) {
  const compiled = compilePublicPackageSource({
    package_source_schema_version: 1,
    package: localCollectionPackageSource(),
  });
  const store = new PackageStoreV1(home);
  const installed = new LocalPackageInstallerV1(store, RUNTIME_VERSION).install({
    package_id: LOCAL_PACKAGE_ID,
    bytes: compiled.bytes,
    source_digest: SOURCE_DIGEST,
  });
  return { store, compiled, installed };
}

function itemCaller(seen = []) {
  return {
    call: async (_capability, input) => {
      seen.push(input.id);
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
  };
}

/** Truncates a completed journal after its first finished node, which is the
 *  shape a killed daemon leaves behind mid-run. */
function interruptAfterFirstNode(home, runId, outputPath) {
  const store = new RunStoreV1(home);
  const journalPath = store.journalPath(runId);
  const firstNode = recoverJournalFile(journalPath, runId).frames.find(
    (frame) => frame.body.event.kind === 'node_completed',
  );
  assert.ok(firstNode);
  unlinkSync(outputPath);
  writeFileSync(journalPath, readFileSync(journalPath).subarray(0, firstNode.end_offset));
}

test('a locally installed collection package runs, dedups and commits through the consumer run service', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-local-run-'));
  try {
    const { store, installed } = installLocalCollectionPackage(home);
    assert.equal(installed.artifact.provenance.kind, 'local');

    const seen = [];
    const outputPath = path.join(home, 'products.ndjson');
    const service = new ConsumerScrapeRunServiceV1(store, RUNTIME_VERSION, itemCaller(seen));
    const run = await service.start({
      package_id: LOCAL_PACKAGE_ID,
      capability: 'list_products',
      input: { ids: ['desk', 'lamp', 'desk'] },
      caller_bounds: {},
      output: { kind: 'file', requested_path: outputPath, format: 'ndjson' },
    });

    assert.equal(run.package_id, LOCAL_PACKAGE_ID);
    assert.equal(run.package_digest, installed.artifact.package_digest);
    assert.equal(run.result.kind, 'scrape_outcome');
    assert.deepEqual(run.result.stop, { kind: 'source_exhausted' });
    assert.deepEqual(run.result.summary, {
      items_emitted: 2,
      items_duplicate: 1,
      tasks_completed: 3,
      tasks_failed: 0,
      target_requests: 3,
    });
    assert.deepEqual(seen, ['desk', 'lamp', 'desk']);
    assert.deepEqual(readCommittedRunItems(new RunStoreV1(home), run.result.run_id), [
      { id: 'desk' },
      { id: 'lamp' },
    ]);
    assert.equal(readFileSync(outputPath, 'utf8'), '{"id":"desk"}\n{"id":"lamp"}\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an interrupted local run resumes from its content-addressed artifact, pointer or not', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-local-resume-'));
  try {
    const { store, installed } = installLocalCollectionPackage(home);
    const seen = [];
    const service = new ConsumerScrapeRunServiceV1(store, RUNTIME_VERSION, itemCaller(seen));
    const startRun = async (outputPath) => {
      const run = await service.start({
        package_id: LOCAL_PACKAGE_ID,
        capability: 'list_products',
        input: { ids: ['desk', 'lamp', 'desk'] },
        caller_bounds: {},
        output: { kind: 'file', requested_path: outputPath, format: 'ndjson' },
      });
      assert.equal(run.result.kind, 'scrape_outcome');
      return run.result.run_id;
    };
    const installedOutput = path.join(home, 'installed-run.ndjson');
    const removedOutput = path.join(home, 'removed-run.ndjson');
    const installedRunId = await startRun(installedOutput);
    const removedRunId = await startRun(removedOutput);

    interruptAfterFirstNode(home, installedRunId, installedOutput);
    interruptAfterFirstNode(home, removedRunId, removedOutput);
    assert.deepEqual(
      interruptUnfinishedRunsAtStartup(home)
        .map((entry) => entry.run_id)
        .sort(),
      [installedRunId, removedRunId].sort(),
    );
    assert.equal(recoverRunState(new RunStoreV1(home), installedRunId).resume.allowed, true);

    seen.length = 0;
    const resumed = await service.resume({ run_id: installedRunId });
    assert.equal(resumed.package_id, LOCAL_PACKAGE_ID);
    assert.equal(resumed.package_digest, installed.artifact.package_digest);
    assert.equal(resumed.result.kind, 'scrape_outcome');
    assert.deepEqual(resumed.result.summary, {
      items_emitted: 2,
      items_duplicate: 1,
      tasks_completed: 3,
      tasks_failed: 0,
      target_requests: 3,
    });
    assert.deepEqual(seen, ['lamp', 'desk']);
    assert.deepEqual(readCommittedRunItems(new RunStoreV1(home), installedRunId), [
      { id: 'desk' },
      { id: 'lamp' },
    ]);

    const removal = new ConsumerLocalListingServiceV1(store).remove({
      package_id: LOCAL_PACKAGE_ID,
    });
    assert.equal(removal.action, 'removed');
    assert.deepEqual(removal.removed_active.provenance, {
      kind: 'local',
      source_digest: SOURCE_DIGEST,
    });
    await assert.rejects(
      service.start({
        package_id: LOCAL_PACKAGE_ID,
        capability: 'list_products',
        input: { ids: ['desk'] },
        caller_bounds: {},
        output: {
          kind: 'file',
          requested_path: path.join(home, 'after-remove.ndjson'),
          format: 'ndjson',
        },
      }),
      (error) => error instanceof InstalledPackageError && error.code === 'package_not_installed',
    );

    seen.length = 0;
    const resumedAfterRemoval = await service.resume({ run_id: removedRunId });
    assert.equal(resumedAfterRemoval.result.kind, 'scrape_outcome');
    assert.deepEqual(seen, ['lamp', 'desk']);
    assert.deepEqual(readCommittedRunItems(new RunStoreV1(home), removedRunId), [
      { id: 'desk' },
      { id: 'lamp' },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
