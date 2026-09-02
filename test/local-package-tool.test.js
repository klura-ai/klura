// install_local_package — the local-package join.
//
// A locally authored skill becomes a real, unsigned, locally provenanced
// package in the same store the signed registry path writes, compiled by the
// same compilePublicPackageSource → parsePublicToolPackage pipeline the export
// path uses. These tests pin the two halves of that claim: the agent-facing
// rejection surface (Zod-derived envelope synopsis, exact PublicContractError
// field paths from the depth) and the safety gate (nothing is relaxed for a
// local package — a collection task on a non-safe_read strategy is rejected
// exactly where a signed package would be rejected).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-local-package-'));
process.env.KLURA_HOME = TMP;

const require = createRequire(import.meta.url);
const { installLocalPackage, TOOL_DEF } = require('../dist/tools/install-local-package.js');
const {
  installLocalPlatformPackage,
  LOCAL_PACKAGE_AUDIT_CODES,
  localPackageSourcePath,
} = require('../dist/factory/public-package/local-install.js');
const {
  CAPABILITY_CONTRACT_KEYS,
} = require('../dist/factory/public-package/capability-review.js');
const {
  createPostSaveVerificationProof,
} = require('../dist/strategies/post-save-verification-proof.js');
const { PackageStoreV1 } = require('../dist/consumer/store/package-store.js');
const {
  CONSUMER_TOOL_CONTRACTS,
} = require('../dist/consumer/contracts/tool-contracts.js');
const { TOOL_NAMES } = require('../dist/vocab/index.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function localStrategy(capability = 'get_product', platform = 'shop-example') {
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
    post_save_verification: createPostSaveVerificationProof(platform, capability, strategy),
  };
  return strategy;
}

/** A strategy whose saved bytes changed after its proof was written. */
function staleProofStrategy(capability = 'get_product', platform = 'shop-example') {
  const strategy = localStrategy(capability, platform);
  strategy.notes.description = 'Get one public product, rewritten after verification.';
  return strategy;
}

function capabilityContract() {
  return {
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
  };
}

function pageScriptReview(replay = 'safe_read') {
  return {
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
    replay,
  };
}

function install(overrides = {}) {
  return {
    platform: 'shop-example',
    version: '1.0.0',
    authentication_contracts: {},
    capabilities: {
      get_product: { contract: capabilityContract(), page_script: pageScriptReview() },
    },
    ...overrides,
  };
}

/** A collection capability whose only task targets itself. */
function collectionInstall({ replay = 'safe_read', itemPointers = ['/id'] } = {}) {
  const contract = capabilityContract();
  contract.description = 'List public products.';
  contract.outcomes[0].output_schema = {
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
  contract.outcomes[0].cases[0].projection = { kind: 'body' };
  contract.outcomes[0].cases[0].assertions = [];
  contract.collection = {
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
    item_identity: { pointers: itemPointers },
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
  return install({
    capabilities: {
      list_products: { contract, page_script: pageScriptReview(replay) },
    },
  });
}

function savedPlatform(capabilities, strategyFor = localStrategy) {
  return {
    load_platform_capabilities: () => capabilities,
    load_strategies: (platform, capability) => [strategyFor(capability, platform)],
  };
}

test('a platform slug too long for the reserved namespace is rejected before anything is written', () => {
  const platform = `p${'a'.repeat(58)}`;
  const result = installLocalPlatformPackage(
    install({ platform }),
    savedPlatform(['get_product']),
  );
  assert.equal(result.kind, 'local_package_audit_failed');
  assert.equal(result.installed, false);
  assert.equal(result.package_id, null);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, LOCAL_PACKAGE_AUDIT_CODES.invalidInstall);
  assert.equal(result.issues[0].path, 'install_local_package.platform');
  assert.match(result.issues[0].message, /at most 58 characters/);
  assert.equal(fs.existsSync(localPackageSourcePath(platform)), false);
});

test('a reviewed contract missing one contract key is rejected with the Zod-derived synopsis', () => {
  const input = install();
  delete input.capabilities.get_product.contract.collection;
  let error = null;
  try {
    installLocalPackage(input);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof Error, 'a missing contract key must be rejected');
  assert.match(error.message, /install_local_package\.capabilities\.get_product\.contract/);
  // The synopsis is composed from CAPABILITY_CONTRACT_KEYS at module load, so a
  // new reviewed field reaches the agent with no edit to the tool.
  for (const key of CAPABILITY_CONTRACT_KEYS) {
    assert.ok(error.message.includes(key), `synopsis omits contract key ${key}`);
  }
  assert.match(error.message, /Expected shape:/);
  assert.match(error.message, /klura:\/\/reference#local-package/);
});

test('a malformed nested collection is rejected at its exact public-contract field path', () => {
  const result = installLocalPlatformPackage(
    collectionInstall({ itemPointers: ['id'] }),
    savedPlatform(['list_products']),
  );
  assert.equal(result.kind, 'local_package_audit_failed');
  assert.equal(result.package_id, 'local-shop-example');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, LOCAL_PACKAGE_AUDIT_CODES.packageNotCompilable);
  assert.equal(
    result.issues[0].path,
    'package.capabilities.list_products.collection.item_identity.pointers[0]',
  );
});

test('the collection safety gate is not weakened for a local package', () => {
  const result = installLocalPlatformPackage(
    collectionInstall({ replay: 'indeterminate' }),
    savedPlatform(['list_products']),
  );
  assert.equal(result.kind, 'local_package_audit_failed');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, LOCAL_PACKAGE_AUDIT_CODES.packageNotCompilable);
  assert.equal(
    result.issues[0].path,
    'package.capabilities.list_products.collection.task_kinds.list_page.capability',
  );
  assert.match(result.issues[0].message, /safe_read/);
});

test('a reviewed capability with no saved page-script is rejected', () => {
  const result = installLocalPlatformPackage(install(), {
    load_platform_capabilities: () => ['get_product'],
    load_strategies: () => [{ strategy: 'fetch', origin: 'https://shop.example.test' }],
  });
  assert.equal(result.kind, 'local_package_audit_failed');
  assert.equal(result.issues[0].code, LOCAL_PACKAGE_AUDIT_CODES.strategyNotInstallable);
  assert.equal(result.issues[0].path, 'skills.shop-example.get_product');
});

test('a stale post-save proof is advisory: the package installs and carries a hint', () => {
  const result = installLocalPlatformPackage(
    install(),
    savedPlatform(['get_product'], staleProofStrategy),
  );
  assert.equal(result.kind, 'local_package_installed');
  assert.equal(result.package_id, 'local-shop-example');
  assert.equal(result.signed, false);
  assert.equal(result.published, false);
  assert.deepEqual(result.capabilities, ['get_product']);
  assert.match(result._hint, /get_product post-save proof is artifact_changed/);
  assert.match(result._hint, new RegExp(TOOL_NAMES.listScrapeRunItems));

  // The reviewed source is on disk and its canonical digest is the artifact's
  // local provenance.
  const source = JSON.parse(fs.readFileSync(result.source_path, 'utf8'));
  assert.equal(source.package.package_id, 'local-shop-example');
  const installed = new PackageStoreV1(TMP).getInstalled('local-shop-example');
  assert.equal(installed.provenance.kind, 'local');
  assert.equal(installed.provenance.source_digest, result.source_digest);
  assert.equal(installed.package_digest, result.package_digest);
  assert.equal(Object.hasOwn(installed.provenance, 'source_index_digest'), false);

  // Reinstalling identical bytes is a no-op on the active pointer.
  const again = installLocalPlatformPackage(
    install(),
    savedPlatform(['get_product'], staleProofStrategy),
  );
  assert.equal(again.kind, 'local_package_installed');
  assert.equal(again.action, 'already_active');
});

test('a current post-save proof installs with no advisory hint', () => {
  const result = installLocalPlatformPackage(
    install({ platform: 'shop-current', version: '1.1.0' }),
    savedPlatform(['get_product']),
  );
  assert.equal(result.kind, 'local_package_installed');
  assert.equal(result.package_id, 'local-shop-current');
  assert.equal(Object.hasOwn(result, '_hint'), false);
});

test('install_local_package is a factory tool, never a consumer contract', () => {
  assert.equal(TOOL_DEF.name, TOOL_NAMES.installLocalPackage);
  assert.equal(TOOL_DEF.phasePolicy.category, 'none');
  assert.equal(Object.hasOwn(CONSUMER_TOOL_CONTRACTS, TOOL_NAMES.installLocalPackage), false);
});
