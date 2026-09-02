import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  exportPlatformPackageToTools,
} = require('../dist/factory/public-package/platform-export.js');
const {
  createPostSaveVerificationProof,
} = require('../dist/strategies/post-save-verification-proof.js');

// The export audit checks an installable release's range against the runtime
// performing the export, so the reviewed window follows package.json rather
// than pinning a version that a release bump would silently exclude.
const RUNTIME_VERSION = require('../package.json').version;
const RUNTIME_RANGE = {
  minimum_inclusive: RUNTIME_VERSION,
  maximum_exclusive: (() => {
    const [major, minor] = RUNTIME_VERSION.split('.').map(Number);
    return `${major}.${minor + 1}.0`;
  })(),
};

function localStrategy(capability = 'get_product') {
  const strategy = {
    strategy: 'page-script',
    origin: 'https://shop.example.test',
    notes: {
      description: 'Get one public product.',
      params: {
        id: {
          kind: 'text',
          description: 'Public product ID.',
          source: 'caller',
          example: 'desk',
        },
      },
    },
    prerequisites: [
      {
        name: 'product_result',
        kind: 'js-eval',
        url: 'https://shop.example.test/product?id={{id}}',
        expression:
          '(async () => await (await fetch(`/products?id=${encodeURIComponent(args.id)}`)).json())()',
        binds: 'product_result',
        args_template: { id: '{{id}}' },
        return_shape: { kind: 'object', required_keys: ['ok', 'item'] },
      },
    ],
    response: { from: 'product_result', format: 'json' },
  };
  strategy.runtime_meta = {
    post_save_validation: 'passed',
    post_save_verification: createPostSaveVerificationProof('shop-example', capability, strategy),
  };
  return strategy;
}

function review() {
  return {
    package_id: 'shop-example',
    version: '1.0.0',
    authentication_contracts: {},
    catalog: {
      display_name: 'Shop Example',
      description: 'Read public product data locally.',
      domains: ['shop.example.test'],
      tags: ['products'],
      state: 'installable',
      runtime_range: { ...RUNTIME_RANGE },
    },
    capabilities: {
      get_product: {
        contract: {
          description: 'Get one public product.',
          visibility: 'public',
          effect: 'read',
          authentication: { mode: 'none' },
          request_origins: [],
          navigation_origins: ['https://shop.example.test'],
          origin_traffic_policies: [
            {
              origin: 'https://shop.example.test',
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
          browser_resources: {
            egress_rules: [
              {
                rule_id: 'document',
                phase: 'navigation',
                origin: 'https://shop.example.test',
                methods: ['GET'],
                route: {
                  path: { kind: 'exact', value: '/product' },
                  query: { kind: 'keys', required: ['id'], allowed: ['id'] },
                },
                resource_types: ['document'],
                max_requests: 1,
                max_encoded_request_body_bytes: 0,
                max_encoded_response_bytes: 65_536,
              },
              {
                rule_id: 'product_script',
                phase: 'page_script',
                origin: 'https://shop.example.test',
                methods: ['GET'],
                route: {
                  path: { kind: 'exact', value: '/products' },
                  query: { kind: 'keys', required: ['id'], allowed: ['id'] },
                },
                resource_types: ['fetch', 'xhr'],
                max_requests: 1,
                max_encoded_request_body_bytes: 0,
                max_encoded_response_bytes: 65_536,
              },
            ],
            max_requests_per_browser_task: 2,
            max_encoded_request_body_bytes_per_browser_task: 0,
            max_encoded_response_bytes_per_browser_task: 131_072,
            max_proxy_wire_bytes_per_browser_task: 262_144,
            max_single_request_body_bytes: 0,
            max_single_response_bytes: 65_536,
            service_workers: 'block',
            downloads: 'block',
            popups: 'block',
            websockets: 'block',
            webtransport: 'block',
            webrtc_direct_egress: 'block',
            browser_cache: 'block',
          },
          max_target_requests_per_call: 2,
          max_encoded_outcome_bytes: 16_384,
          call_timeouts: { per_request_timeout_ms: 5_000, total_timeout_ms: 5_000 },
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
            required: ['id'],
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
          outcomes: [
            {
              outcome_id: 'success',
              class: 'success',
              output_schema: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
                additionalProperties: false,
              },
              cases: [
                {
                  case_id: 'success_case',
                  strategy_ids: ['product_script'],
                  matcher: {
                    op: 'all',
                    items: [
                      { op: 'status_in', values: [200] },
                      {
                        op: 'json_pointer',
                        pointer: '/ok',
                        test: 'equals',
                        value: true,
                        expected_type: null,
                      },
                    ],
                  },
                  projection: { kind: 'json_pointer', pointer: '/item' },
                  assertions: [
                    {
                      assertion_id: 'returned_id',
                      kind: 'input_output_equal',
                      input_pointer: '/id',
                      output_pointer: '/id',
                    },
                  ],
                  retry_after: null,
                },
              ],
            },
          ],
          control: null,
          collection: null,
        },
        page_script: {
          tier: 'page-script',
          strategy_id: 'product_script',
          wait: { kind: 'dom_content_loaded' },
          interaction: null,
          expect: {
            wait: null,
            egress_rule_ids: ['product_script'],
            minimum_matching_requests: 1,
            maximum_matching_requests: 1,
          },
          request_body_limits: {
            max_encoded_request_body_bytes_per_script: 0,
            max_single_request_body_bytes: 0,
            max_encoded_request_body_bytes_by_rule: { product_script: 0 },
          },
          replay: 'safe_read',
        },
        fixtures: [{ fixture_id: 'get_product', kind: 'call', input: { id: 'desk' } }],
      },
    },
  };
}

function collectionReview() {
  const base = review();
  const capability = structuredClone(base.capabilities.get_product);
  delete base.capabilities.get_product;
  capability.contract.description = 'List public products.';
  capability.contract.outcomes[0].output_schema = {
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
  };
  capability.contract.outcomes[0].cases[0].projection = { kind: 'body' };
  capability.contract.outcomes[0].cases[0].assertions = [];
  capability.contract.collection = {
    collection_schema_version: 1,
    input_modes: {
      ordered_mode_ids: ['by_id'],
      conflict_policy: 'reject',
      modes: [
        {
          id: 'by_id',
          populated_when: { op: 'exists', ref: { from: 'args', pointer: '/id' } },
          roots: [
            {
              task_kind: 'list_page',
              seed: {
                kind: 'once',
                input: { id: { op: 'get', from: 'args', pointer: '/id' } },
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
        id: 'list_page',
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
        max_journal_frames: 100,
        max_reorder_buffer_bytes: 1_000,
        max_local_state_bytes: 100_000,
      },
    },
  };
  capability.fixtures = [
    { fixture_id: 'list_products', kind: 'call', input: { id: 'desk' } },
    {
      fixture_id: 'list_products_run',
      kind: 'run',
      input: { id: 'desk' },
      caller_bounds: {},
      input_mode_id: 'by_id',
    },
  ];
  base.capabilities.list_products = capability;
  return base;
}

function collectionSmokeResponse() {
  return {
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: { ok: true, item: { id: 'desk' } },
    target_requests: 2,
  };
}

function collectionSmokeCall() {
  return async () => ({
    result: {
      kind: 'outcome',
      outcome_id: 'success',
      outcome_class: 'success',
      case_id: 'success_case',
      data: { ok: true, item: { id: 'desk' } },
      retry_after_ms: null,
      attempts: 2,
    },
    responses: [{ strategy_id: 'product_script', response: collectionSmokeResponse() }],
    diagnostics: [],
  });
}

test('platform export writes one PR-ready tools directory and stops before git', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const response = {
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: { ok: true, item: { id: 'desk' } },
    target_requests: 2,
  };
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: review(),
    },
    {
      load_platform_capabilities: () => ['get_product'],
      load_strategies: () => [localStrategy()],
      smoke_call: async () => ({
        result: {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { id: 'desk' },
          retry_after_ms: null,
          attempts: 2,
        },
        responses: [{ strategy_id: 'product_script', response }],
        diagnostics: [],
      }),
    },
  );
  assert.equal(result.kind, 'package_exported');
  assert.equal(result.git_changed, false);
  assert.equal(result.published, false);
  const target = path.join(repository, 'tools', 'shop-example');
  assert.deepEqual(fs.readdirSync(target).sort(), [
    'fixtures',
    'package.source.json',
    'registry.json',
  ]);
  assert.deepEqual(result.export_tree.directories, ['fixtures']);
  assert.deepEqual(
    result.export_tree.files.map((file) => file.path),
    ['fixtures/get-product.call.json', 'package.source.json', 'registry.json'],
  );
  assert.match(result.export_tree.tree_digest, /^[a-f0-9]{64}$/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(target, 'package.source.json'), 'utf8')).package
      .package_id,
    'shop-example',
  );
  const {
    parseRegistryCatalogManifestBytes,
  } = require('../dist/public/contracts/registry-catalog.js');
  assert.deepEqual(
    parseRegistryCatalogManifestBytes(
      fs.readFileSync(path.join(target, 'registry.json')),
      'registry.json',
    ),
    {
      registry_catalog_schema_version: 1,
      display_name: 'Shop Example',
      description: 'Read public product data locally.',
      domains: ['shop.example.test'],
      tags: ['products'],
      stable_version: '1.0.0',
      releases: [
        {
          source: 'package.source.json',
          state: 'installable',
          runtime_range: { ...RUNTIME_RANGE },
        },
      ],
    },
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(target, 'fixtures', 'get-product.call.json'), 'utf8'))
      .expected.result,
    {
      kind: 'outcome',
      outcome_id: 'success',
      outcome_class: 'success',
      case_id: 'success_case',
      data: { id: 'desk' },
      retry_after_ms: null,
      attempts: 2,
    },
  );
});

test('platform export keeps unreviewed local primitives internal to the actor package', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-subset-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const response = {
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: { ok: true, item: { id: 'desk' } },
    target_requests: 2,
  };
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: review(),
    },
    {
      load_platform_capabilities: () => ['get_product', 'internal_search_primitive'],
      load_strategies: () => [localStrategy()],
      smoke_call: async () => ({
        result: {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { id: 'desk' },
          retry_after_ms: null,
          attempts: 2,
        },
        responses: [{ strategy_id: 'product_script', response }],
        diagnostics: [],
      }),
    },
  );
  assert.equal(result.kind, 'package_exported');
  assert.deepEqual(result.capabilities, ['get_product']);
});

test('platform export records selector evidence so selector-matched outcomes replay from fixtures', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-selectors-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const selectorReview = review();
  selectorReview.capabilities.get_product.contract.outcomes[0].cases[0].matcher.items.push({
    op: 'html_selector_exists',
    selector: 'main > h1',
  });
  const queried = [];
  const response = {
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: { ok: true, item: { id: 'desk' } },
    target_requests: 2,
    html_selector_exists: (selector) => {
      queried.push(selector);
      return selector === 'main > h1';
    },
  };
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: selectorReview,
    },
    {
      load_platform_capabilities: () => ['get_product'],
      load_strategies: () => [localStrategy()],
      smoke_call: async () => ({
        result: {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { id: 'desk' },
          retry_after_ms: null,
          attempts: 2,
        },
        responses: [{ strategy_id: 'product_script', response }],
        diagnostics: [],
      }),
    },
  );
  assert.equal(result.kind, 'package_exported');
  assert.deepEqual(queried, ['main > h1']);
  const written = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'tools', 'shop-example', 'fixtures', 'get-product.call.json'),
      'utf8',
    ),
  );
  assert.deepEqual(written.responses[0].response.selector_matches, { 'main > h1': true });
});

test('a fixture_id reused across capabilities fails before any smoke traffic', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-fixture-dup-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const duplicated = review();
  duplicated.capabilities.get_product_alt = structuredClone(duplicated.capabilities.get_product);
  let smokeCalls = 0;
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: duplicated,
    },
    {
      load_platform_capabilities: () => ['get_product', 'get_product_alt'],
      load_strategies: () => [localStrategy()],
      smoke_call: async () => {
        smokeCalls += 1;
        throw new Error('smoke must not run for an invalid review');
      },
    },
  );
  assert.equal(result.kind, 'export_audit_failed');
  assert.equal(smokeCalls, 0);
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['invalid_export'],
  );
  assert.equal(
    result.issues[0].path,
    'platform_export.review.capabilities.get_product_alt.fixtures[0].fixture_id',
  );
  assert.match(result.issues[0].message, /must be unique across every capability/);
  assert.deepEqual(fs.readdirSync(path.join(repository, 'tools')), []);
});

test('platform export batches missing reviewed capability issues and writes nothing', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-audit-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: review(),
    },
    {
      load_platform_capabilities: () => ['search_products'],
      load_strategies: () => [{ ...localStrategy(), runtime_meta: {} }],
    },
  );
  assert.equal(result.kind, 'export_audit_failed');
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['capability_not_saved', 'strategy_not_verified'],
  );
  assert.deepEqual(fs.readdirSync(path.join(repository, 'tools')), []);
});

test('an installable release range that excludes the exporting runtime fails the export audit', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-range-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const outOfRangeReview = review();
  outOfRangeReview.catalog.runtime_range = {
    minimum_inclusive: '99.0.0',
    maximum_exclusive: '100.0.0',
  };
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: outOfRangeReview,
    },
    {
      load_platform_capabilities: () => ['get_product'],
      load_strategies: () => [localStrategy()],
    },
  );
  assert.equal(result.kind, 'export_audit_failed');
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['invalid_export'],
  );
  assert.equal(result.issues[0].path, 'platform_export.review.catalog.runtime_range');
  assert.match(result.issues[0].message, /must include the exporting runtime/);
  assert.deepEqual(fs.readdirSync(path.join(repository, 'tools')), []);
});

test('platform export uses the canonical proof assessor after strategy bytes change', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-stale-proof-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const changed = localStrategy();
  changed.prerequisites[0].expression =
    '(async () => ({ok:true,item:{id:String(args.id),changed:true}}))()';

  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: review(),
    },
    {
      load_platform_capabilities: () => ['get_product'],
      load_strategies: () => [changed],
    },
  );

  assert.equal(result.kind, 'export_audit_failed');
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['strategy_verification_stale'],
  );
  assert.match(result.issues[0].message, /artifact_changed/);
  assert.deepEqual(fs.readdirSync(path.join(repository, 'tools')), []);
});

test('platform export requires a run fixture for a collection capability', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-run-missing-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const exportReview = collectionReview();
  exportReview.capabilities.list_products.fixtures = [
    { fixture_id: 'list_products', kind: 'call', input: { id: 'desk' } },
  ];
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: exportReview,
    },
    {
      load_platform_capabilities: () => ['list_products'],
      load_strategies: () => [localStrategy('list_products')],
    },
  );
  assert.equal(result.kind, 'export_audit_failed');
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['fixture_coverage_incomplete'],
  );
  assert.match(result.issues[0].message, /has no run fixture/);
  assert.deepEqual(fs.readdirSync(path.join(repository, 'tools')), []);
});

test('platform export rejects a run fixture on a capability without a collection', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-run-extra-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const exportReview = review();
  exportReview.capabilities.get_product.fixtures.push({
    fixture_id: 'get_product_run',
    kind: 'run',
    input: { id: 'desk' },
    caller_bounds: {},
    input_mode_id: null,
  });
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: exportReview,
    },
    {
      load_platform_capabilities: () => ['get_product'],
      load_strategies: () => [localStrategy()],
    },
  );
  assert.equal(result.kind, 'export_audit_failed');
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['fixture_coverage_incomplete'],
  );
  assert.match(result.issues[0].message, /run fixture is not allowed/);
  assert.deepEqual(fs.readdirSync(path.join(repository, 'tools')), []);
});

test('platform export captures a replayable run fixture for a collection capability', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-export-run-'));
  fs.mkdirSync(path.join(repository, 'tools'));
  const smokeRunCalls = [];
  const result = await exportPlatformPackageToTools(
    {
      platform: 'shop-example',
      tools_repository_path: repository,
      review: collectionReview(),
    },
    {
      load_platform_capabilities: () => ['list_products'],
      load_strategies: () => [localStrategy('list_products')],
      smoke_call: collectionSmokeCall(),
      smoke_run: async (capability, fixture, context) => {
        smokeRunCalls.push({ capability, fixture, context });
        return {
          result: {
            kind: 'scrape_outcome',
            run_id: `run_v1_${'0'.repeat(32)}`,
            summary: {
              items_emitted: 1,
              items_duplicate: 0,
              tasks_completed: 1,
              tasks_failed: 0,
              target_requests: 1,
            },
            stop: { kind: 'source_exhausted' },
          },
          items: [{ id: 'desk' }],
          responses: [{ strategy_id: 'product_script', response: collectionSmokeResponse() }],
          diagnostics: [],
        };
      },
    },
  );
  assert.equal(result.kind, 'package_exported');
  assert.deepEqual(
    result.export_tree.files.map((file) => file.path),
    [
      'fixtures/list-products-run.run.json',
      'fixtures/list-products.call.json',
      'package.source.json',
      'registry.json',
    ],
  );
  // One run records the fixture; a second runs the collection to its own
  // declared ceilings so the exported package is proven to reach them live.
  assert.equal(smokeRunCalls.length, 2);
  assert.notEqual(smokeRunCalls[0].capability.collection, null);
  assert.deepEqual(smokeRunCalls[0].fixture, {
    input: { id: 'desk' },
    caller_bounds: {},
    input_mode_id: 'by_id',
  });
  assert.deepEqual(smokeRunCalls[1].fixture, {
    input: { id: 'desk' },
    caller_bounds: {},
    input_mode_id: 'by_id',
  });
  assert.equal(smokeRunCalls[1].context.artifact.capability, 'list_products');
  assert.equal(smokeRunCalls[0].context.artifact.capability, 'list_products');
  assert.match(smokeRunCalls[0].context.artifact.package_digest, /^[a-f0-9]{64}$/);
  const { parsePublicPackageFixtureBytes } = require('../dist/public/contracts/fixture.js');
  const runFixture = parsePublicPackageFixtureBytes(
    fs.readFileSync(
      path.join(repository, 'tools', 'shop-example', 'fixtures', 'list-products-run.run.json'),
    ),
    'fixture list-products-run.run.json',
  );
  assert.equal(runFixture.kind, 'run');
  assert.equal(runFixture.capability, 'list_products');
  assert.deepEqual(runFixture.caller_bounds, {});
  assert.equal(runFixture.input_mode_id, 'by_id');
  assert.equal('run_id' in runFixture.expected.result, false);
  assert.deepEqual(runFixture.expected.result.stop, { kind: 'source_exhausted' });
  assert.deepEqual(runFixture.expected.items, [{ id: 'desk' }]);
});
