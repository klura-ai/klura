import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  appendJournalFrame,
  calculateAuthenticationContractDigest,
  calculatePublicToolPackageManifestDigest,
  canonicalJson,
  canonicalJsonDigest,
  comparePackageVersions,
  deriveInlineOutputBound,
  exportCommittedRunItems,
  exportCommittedRunItemsNdjson,
  evaluateOutcomeContracts,
  evaluateCollectionPredicate,
  evaluateScrapeValue,
  evaluateValueExpression,
  getPublicCapabilityTransports,
  parseStartUrlTemplate,
  parseScrapeLimit,
  parseScrapeInputModes,
  parseScrapeRunPolicy,
  parseScrapeTaskKinds,
  planScrapeRun,
  parsePackageId,
  parseCollectionPredicate,
  parseSemanticStopItemValue,
  parseSemanticStops,
  parseScrapeValue,
  parsePublicToolPackage,
  parseOutcomeContract,
  parseJsonPointer,
  parseRuntimeRange,
  parseJsonSchema,
  parseStrictJson,
  parseValueExpression,
  ConsumerCallServiceV1,
  ConsumerRunSessionError,
  ConsumerScrapeRunServiceV1,
  ConsumerLoginServiceV1,
  ConsumerSessionServiceV1,
  KluraConsumerClientV1,
  ConsumerRegistryServiceV1,
  ConsumerRunServiceV1,
  createRunId,
  RunListError,
  InstalledPackageError,
  InstalledPackageResolverV1,
  inspectStoredRun,
  PackageStoreV1,
  preflightInlineRunOutput,
  RunOutputError,
  sha256Digest,
  resolveEffectiveRunBounds,
  resolveSemanticStops,
  readCommittedRunItems,
  readCommittedRunItemsPage,
  readCommittedNodeItems,
  readDataBlob,
  recoverRunState,
  recoverJournalFile,
  RunStoreV1,
  readJournal,
  JOURNAL_FRAMES_FIXED_V1,
  JOURNAL_FRAMES_PER_ITEM_V1,
  JOURNAL_FRAMES_PER_TASK_V1,
  minimumJournalFrames,
  minimumJournalBytes,
  JOURNAL_EMERGENCY_BYTE_RESERVE_V1,
  JOURNAL_ORDINARY_FRAME_BYTES_V1,
  SessionStoreError,
  SessionStoreV1,
  ScrapeRunServiceV1,
  ValueExpressionError,
  validateStartUrl,
  validateJsonSchema,
  verifySignedRegistryIndex,
} from '../consumer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const {
  executeNodeHttpStrategy,
  outgoingRequestHeaders,
  PublicHttpExecutionError,
} = require('../dist/consumer/execution/node-http.js');
const { OriginSchedulerV1 } = require('../dist/consumer/execution/origin-scheduler.js');
const { PublicCallerV1 } = require('../dist/consumer/call.js');
const {
  measureBrowserRequestBodyBytes,
} = require('../dist/consumer/execution/public-browser/request-body-policy.js');
const { ConsumerDaemonRoutesV1 } = require('../dist/consumer/daemon-routes.js');
const { RunOperationStoreV1 } = require('../dist/consumer/scrape/run-operations.js');
const { interruptUnfinishedRunsAtStartup } = require('../dist/consumer/scrape/startup-recovery.js');
const { InstallPackageError, PackageInstallerV1 } = require('../dist/consumer/install.js');
const { RegistryClientError, RegistryClientV1 } = require('../dist/consumer/registry/client.js');
const { RegistryCatalogError, RegistryCatalogV1 } = require('../dist/consumer/registry/catalog.js');
const {
  createDefaultConsumerRegistryService,
} = require('../dist/consumer/registry/default-service.js');
const {
  compilePublicPackageSource,
  compileRegistryReleaseEntry,
  compileStaticRegistryIndex,
  exportReviewedLocalPageScriptStrategySource,
  signStaticRegistryIndex,
} = require('../factory-compiler.js');

function indexPayload() {
  return {
    registry_schema_version: 1,
    generated_at: '2026-07-27T10:00:00Z',
    expires_at: '2026-07-28T10:00:00Z',
    packages: {
      ikea: {
        package_id: 'ikea',
        display_name: 'IKEA',
        description: 'Read products from IKEA.',
        domains: ['ikea.com'],
        tags: ['shopping'],
        stable_version: '1.0.0',
        versions: {
          '1.0.0': {
            version: '1.0.0',
            state: 'installable',
            package_url: 'https://registry.klura.ai/v1/packages/a.json',
            package_bytes: 256,
            package_digest: 'a'.repeat(64),
            manifest_digest: 'b'.repeat(64),
            runtime_range: { minimum_inclusive: '1.0.0', maximum_exclusive: '2.0.0' },
            capabilities: {
              get_product: {
                description: 'Get one product.',
                run_supported: true,
                transports: ['http_node'],
              },
            },
          },
        },
      },
    },
  };
}

function signedIndex(payload = indexPayload()) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString(
    'base64url',
  );
  return {
    privateKey,
    publicKey,
    index: {
      envelope_schema_version: 1,
      payload,
      signature: { algorithm: 'ed25519', key_id: 'registry-v1', value: signature },
    },
  };
}

function publicPackageValue() {
  const value = {
    package_schema_version: 1,
    package_id: 'ikea',
    version: '1.0.0',
    manifest_digest: '0'.repeat(64),
    authentication_contracts: {},
    capabilities: {
      get_product: {
        description: 'Get one product.',
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
          properties: { id: { type: 'string', minLength: 1 } },
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
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
            cases: [
              {
                case_id: 'success_case',
                strategy_ids: ['request'],
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
    },
  };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  return value;
}

function semanticCutoffPackageValue() {
  const value = publicPackageValue();
  const capability = value.capabilities.get_product;
  capability.input_schema.properties.cursor = { type: 'string', minLength: 1 };
  capability.input_schema.properties.since = { type: 'string', minLength: 10, maxLength: 10 };
  capability.collection = {
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
              task_kind: 'ordered_page',
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
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64 },
        published_at: { type: 'string', minLength: 10, maxLength: 10 },
      },
      required: ['id', 'published_at'],
      additionalProperties: false,
    },
    item_identity: { pointers: ['/id'] },
    inline_output_bound: null,
    semantic_stops: [
      {
        id: 'published_since',
        kind: 'date_cutoff',
        bound_arg_pointer: '/since',
        item_value_pointer: '/published_at',
        comparator: { kind: 'iso_date', format: 'YYYY-MM-DD', timezone: 'UTC' },
        order: 'descending',
        inclusive: true,
        ordering_assertion_id: 'published_desc',
        invalid_item_value: 'item_invalid',
      },
    ],
    csv_columns: null,
    task_kinds: [
      {
        id: 'ordered_page',
        capability: 'get_product',
        task_role: 'page',
        page_outcome_ids: ['success'],
        terminal_outcome_ids: [],
        emit: {
          items_pointer: '/items',
          cardinality: 'array',
          projection: { op: 'get', from: 'raw_item', pointer: '' },
          limit: null,
        },
        pagination: {
          contract: {
            kind: 'cursor',
            continue_when: { op: 'exists', ref: { from: 'task_data', pointer: '/next' } },
            exhausted_when: {
              op: 'not_exists',
              ref: { from: 'task_data', pointer: '/next' },
            },
            value_pointer: '/next',
            bind_input: 'cursor',
          },
          max_pages_per_chain: { id: 'page_cap', kind: 'fixed', value: 2 },
        },
        fanout: [],
        on_failure: 'stop_run',
      },
    ],
    max_fanout_depth: 0,
    run_policy: {
      max_concurrency: 1,
      per_request_timeout_ms: 1_000,
      total_timeout_ms: 5_000,
      max_requests: 2,
      max_tasks: 2,
      max_pages: 2,
      max_items: 10,
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
        max_journal_frames: 64,
        max_reorder_buffer_bytes: 1_000,
        max_local_state_bytes: 100_000,
      },
    },
  };
  capability.collection.inline_output_bound = deriveInlineOutputBound(
    parseJsonSchema(capability.collection.item_schema),
  );
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  return value;
}

function publicPackageBytes() {
  const value = publicPackageValue();
  return { value, bytes: Buffer.from(canonicalJson(value), 'utf8') };
}

function authenticatedPackageValue() {
  const value = browserHttpPackageValue();
  value.capabilities.get_product.authentication = {
    mode: 'optional',
    authentication_contract_id: 'account',
  };
  value.authentication_contracts = {
    account: {
      login_url: 'https://account.example.test/login',
      navigation_origins: ['https://account.example.test'],
      origin_traffic_policies: [
        {
          origin: 'https://account.example.test',
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
            rule_id: 'login_document',
            phase: 'login',
            origin: 'https://account.example.test',
            methods: ['GET'],
            route: { path: { kind: 'exact', value: '/login' }, query: { kind: 'none' } },
            resource_types: ['document'],
            max_requests: 1,
            max_encoded_request_body_bytes: 0,
            max_encoded_response_bytes: 65_536,
          },
          {
            rule_id: 'login_submit',
            phase: 'login',
            origin: 'https://account.example.test',
            methods: ['POST'],
            route: { path: { kind: 'exact', value: '/session' }, query: { kind: 'none' } },
            resource_types: ['document'],
            max_requests: 1,
            max_encoded_request_body_bytes: 1_024,
            max_encoded_response_bytes: 65_536,
          },
        ],
        max_requests_per_login: 2,
        max_encoded_request_body_bytes_per_login: 1_024,
        max_encoded_response_bytes_per_login: 131_072,
        max_proxy_wire_bytes_per_login: 262_144,
        max_single_request_body_bytes: 1_024,
        max_single_response_bytes: 65_536,
        total_timeout_ms: 60_000,
        service_workers: 'block',
        downloads: 'block',
        popups: 'block',
        websockets: 'block',
        webtransport: 'block',
        webrtc_direct_egress: 'block',
        browser_cache: 'block',
      },
      check: {
        capability: 'get_product',
        input: { id: 'session' },
        authenticated_outcome_ids: ['success'],
      },
    },
  };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  return value;
}

function authenticatedCollectionPackageValue() {
  const value = authenticatedPackageValue();
  value.capabilities.session_check = JSON.parse(JSON.stringify(value.capabilities.get_product));
  value.authentication_contracts.account.check.capability = 'session_check';
  value.capabilities.get_product.authentication = {
    mode: 'required',
    authentication_contract_id: 'account',
  };
  value.capabilities.get_product.collection = {
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
              task_kind: 'product_page',
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
    csv_columns: [{ name: 'id', pointer: '/id' }],
    task_kinds: [
      {
        id: 'product_page',
        capability: 'get_product',
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
      max_requests: 2,
      max_tasks: 1,
      max_pages: 1,
      max_items: 1,
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
        max_journal_frames: 32,
        max_reorder_buffer_bytes: 1_000,
        max_local_state_bytes: 10_000,
      },
    },
  };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  return value;
}

function browserNavigationPackageValue() {
  const value = publicPackageValue();
  const capability = value.capabilities.get_product;
  capability.request_origins = [];
  capability.navigation_origins = ['https://shop.example.test'];
  capability.origin_traffic_policies = [
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
  ];
  capability.browser_resources = {
    egress_rules: [
      {
        rule_id: 'document',
        phase: 'navigation',
        origin: 'https://shop.example.test',
        methods: ['GET'],
        route: {
          path: { kind: 'prefix', value: '/' },
          query: { kind: 'keys', required: [], allowed: ['id'] },
        },
        resource_types: ['document'],
        max_requests: 2,
        max_encoded_request_body_bytes: 0,
        max_encoded_response_bytes: 65_536,
      },
    ],
    max_requests_per_browser_task: 2,
    max_encoded_request_body_bytes_per_browser_task: 0,
    max_encoded_response_bytes_per_browser_task: 65_536,
    max_proxy_wire_bytes_per_browser_task: 131_072,
    max_single_request_body_bytes: 0,
    max_single_response_bytes: 65_536,
    service_workers: 'block',
    downloads: 'block',
    popups: 'block',
    websockets: 'block',
    webtransport: 'block',
    webrtc_direct_egress: 'block',
    browser_cache: 'block',
  };
  capability.strategies = [
    {
      kind: 'browser_navigation',
      strategy_id: 'product_page',
      url: {
        op: 'concat',
        values: [
          { op: 'literal', value: 'https://shop.example.test/product?id=' },
          { op: 'url_encode', value: { op: 'input', pointer: '/id' } },
        ],
      },
      wait: { kind: 'selector', selector: 'main > h1', state: 'visible', minimum_count: 1 },
      interaction: null,
      projection: {
        item_selector: 'main',
        cardinality: 'one',
        fields: {
          id: { kind: 'attribute', selector: null, attribute: 'data-id', required: true },
        },
      },
      prerequisites: [],
      replay: 'safe_read',
    },
  ];
  capability.outcomes[0].cases[0].strategy_ids = ['product_page'];
  capability.outcomes[0].cases[0].matcher = {
    op: 'all',
    items: [
      { op: 'status_in', values: [200] },
      { op: 'body_kind', value: 'json_object' },
      { op: 'html_selector_exists', selector: 'main > h1' },
    ],
  };
  capability.outcomes[0].cases[0].projection = { kind: 'body' };
  capability.outcomes[0].cases[0].assertions = [];
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  return value;
}

function browserPageScriptPackageValue() {
  const value = browserNavigationPackageValue();
  const capability = value.capabilities.get_product;
  const source =
    'async (args) => await (await fetch(`/products?id=${encodeURIComponent(args.id)}`)).json()';
  capability.browser_resources.egress_rules.push({
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
  });
  capability.browser_resources.max_requests_per_browser_task = 3;
  capability.browser_resources.max_encoded_response_bytes_per_browser_task = 131_072;
  capability.max_target_requests_per_call = 3;
  capability.strategies = [
    {
      kind: 'browser_page_script',
      strategy_id: 'product_script',
      url: {
        op: 'concat',
        values: [
          { op: 'literal', value: 'https://shop.example.test/product?id=' },
          { op: 'url_encode', value: { op: 'input', pointer: '/id' } },
        ],
      },
      wait: { kind: 'dom_content_loaded' },
      interaction: null,
      program: {
        source,
        source_digest: sha256Digest(source),
        arguments: {
          op: 'object',
          fields: { id: { op: 'input', pointer: '/id' } },
        },
        result_shape: { kind: 'object', required_keys: ['item', 'ok'] },
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
      },
      prerequisites: [],
      replay: 'safe_read',
    },
  ];
  capability.outcomes[0].cases[0].strategy_ids = ['product_script'];
  capability.outcomes[0].cases[0].matcher = {
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
  };
  capability.outcomes[0].cases[0].projection = {
    kind: 'json_pointer',
    pointer: '/item',
  };
  capability.outcomes[0].cases[0].assertions = [
    {
      assertion_id: 'returned_id',
      kind: 'input_output_equal',
      input_pointer: '/id',
      output_pointer: '/id',
    },
  ];
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  return value;
}

function browserHttpPackageValue() {
  const value = publicPackageValue();
  const capability = value.capabilities.get_product;
  capability.navigation_origins = ['https://api.example.test'];
  capability.browser_resources = {
    egress_rules: [
      {
        rule_id: 'bootstrap',
        phase: 'navigation',
        origin: 'https://api.example.test',
        methods: ['GET'],
        route: { path: { kind: 'exact', value: '/' }, query: { kind: 'none' } },
        resource_types: ['document'],
        max_requests: 1,
        max_encoded_request_body_bytes: 0,
        max_encoded_response_bytes: 16_384,
      },
      {
        rule_id: 'product_request',
        phase: 'runtime_request',
        origin: 'https://api.example.test',
        methods: ['GET'],
        route: {
          path: { kind: 'exact', value: '/products' },
          query: { kind: 'keys', required: ['id'], allowed: ['id'] },
        },
        resource_types: ['fetch'],
        max_requests: 1,
        max_encoded_request_body_bytes: 0,
        max_encoded_response_bytes: 65_536,
      },
    ],
    max_requests_per_browser_task: 2,
    max_encoded_request_body_bytes_per_browser_task: 0,
    max_encoded_response_bytes_per_browser_task: 65_536,
    max_proxy_wire_bytes_per_browser_task: 131_072,
    max_single_request_body_bytes: 0,
    max_single_response_bytes: 65_536,
    service_workers: 'block',
    downloads: 'block',
    popups: 'block',
    websockets: 'block',
    webtransport: 'block',
    webrtc_direct_egress: 'block',
    browser_cache: 'block',
  };
  capability.max_target_requests_per_call = 2;
  capability.strategies[0].context = 'browser';
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  return value;
}

function responseWithBytes(bytes, status = 200) {
  return {
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function sourceImportSpecifiers(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const addSpecifier = (value) => {
    if (value && ts.isStringLiteralLike(value)) specifiers.push(value.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) addSpecifier(reference.expression);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) {
        addSpecifier(first);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

test('consumer entrypoint is physical and loads without factory modules', () => {
  const consumerPath = path.join(here, '..', 'consumer.js');
  const resolved = require.resolve(consumerPath);
  delete require.cache[resolved];
  require(consumerPath);
  const loaded = Object.keys(require.cache);
  for (const modulePath of loaded) {
    assert.ok(!modulePath.includes(`${path.sep}audit${path.sep}`));
    assert.ok(!modulePath.includes(`${path.sep}runtime-state${path.sep}`));
    assert.ok(!modulePath.includes(`${path.sep}strategies${path.sep}`));
    assert.ok(!modulePath.includes(`${path.sep}phases${path.sep}`));
  }
});

test('public and consumer source trees cannot import discovery or host modules', () => {
  const sourceRoot = path.join(here, '..', 'src');
  const forbiddenSegments = new Set([
    'agent',
    'audit',
    'gate',
    'phases',
    'runtime-state',
    'strategies',
    'tools',
    'working-dir',
  ]);
  for (const root of ['public', 'core', 'consumer']) {
    const directory = path.join(sourceRoot, root);
    if (!existsSync(directory)) continue;
    for (const file of sourceFiles(directory)) {
      for (const specifier of sourceImportSpecifiers(file)) {
        if (!specifier.startsWith('.')) continue;
        const relative = path.relative(sourceRoot, path.resolve(path.dirname(file), specifier));
        const forbidden = relative.split(path.sep).find((segment) => forbiddenSegments.has(segment));
        assert.equal(
          forbidden,
          undefined,
          `${path.relative(sourceRoot, file)} imports forbidden module ${specifier}`,
        );
      }
    }
  }
});

test('canonical JSON sorts keys and hashes the exact canonical bytes', () => {
  assert.equal(canonicalJson({ z: [true, null], a: 'x' }), '{"a":"x","z":[true,null]}');
  assert.equal(
    canonicalJsonDigest({ a: 1 }),
    '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
  );
});

test('strict JSON rejects duplicate keys before parsing', () => {
  assert.throws(
    () => parseStrictJson('{"a":1,"a":2}', 'index', 100, 12),
    (error) => error instanceof PublicContractError && /duplicate object key/.test(error.message),
  );
});

test('registry signatures cover canonical payload bytes', () => {
  const { index, publicKey } = signedIndex();
  const verified = verifySignedRegistryIndex(index, publicKey);
  assert.equal(verified.payload.packages.ikea.stable_version, '1.0.0');

  index.payload.packages.ikea.description = 'Changed after signing.';
  assert.throws(
    () => verifySignedRegistryIndex(index, publicKey),
    (error) => error instanceof PublicContractError && /does not verify/.test(error.message),
  );
});

test('production registry authority is compiled into the consumer service', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-production-registry-'));
  const originalFetch = globalThis.fetch;
  const index = {
    envelope_schema_version: 1,
    payload: {
      expires_at: '2025-01-07T00:00:00Z',
      generated_at: '2025-01-01T00:00:00Z',
      packages: {},
      registry_schema_version: 1,
    },
    signature: {
      algorithm: 'ed25519',
      key_id: 'registry-v1',
      value: 'WV79TohI67t_JzNzuXfvdH7gNYIb4QshBBOMII9NP1pg3iH4gEdGsIaGwn26sGeWcod1JiQi9-ycjKZiRBO6DQ',
    },
  };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), redirect: options.redirect });
    return new Response(canonicalJson(index), { status: 200 });
  };
  try {
    const registry = createDefaultConsumerRegistryService(home);
    const result = await registry.search({}, new Date('2025-01-02T00:00:00Z'));
    assert.equal(result.kind, 'package_search');
    assert.deepEqual(result.items, []);
    assert.deepEqual(requests, [
      {
        url: 'https://registry.klura.ai/v1/index.signed.json',
        redirect: 'error',
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test('registry refresh verifies before atomically replacing a usable cache', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-registry-cache-'));
  try {
    const { value: packageValue, bytes: packageBytes } = publicPackageBytes();
    const payload = indexPayload();
    const version = payload.packages.ikea.versions['1.0.0'];
    version.package_url = 'https://registry.example.test/v1/packages/ikea.json';
    version.package_bytes = packageBytes.byteLength;
    version.package_digest = sha256Digest(packageBytes);
    version.manifest_digest = packageValue.manifest_digest;
    version.capabilities.get_product.run_supported = false;
    const { index, publicKey } = signedIndex(payload);
    const bytes = Buffer.from(canonicalJson(index), 'utf8');
    const authority = {
      index_url: 'https://registry.example.test/v1/index.signed.json',
      public_key: publicKey,
    };
    const client = new RegistryClientV1(home, authority, async (url) =>
      responseWithBytes(url === authority.index_url ? bytes : packageBytes),
    );
    const refreshed = await client.refresh(new Date('2026-07-27T12:00:00Z'));
    assert.equal(refreshed.source_digest, sha256Digest(bytes));
    assert.equal(client.inspectCache(new Date('2026-07-27T12:00:00Z')).kind, 'ok');
    assert.deepEqual(
      await client.downloadPackage(refreshed.signed_index.payload.packages.ikea.versions['1.0.0']),
      packageBytes,
    );

    const unavailable = new RegistryClientV1(home, authority, async () => {
      throw new Error('offline');
    });
    await assert.rejects(
      () => unavailable.refresh(new Date('2026-07-27T12:00:00Z')),
      (error) => error instanceof RegistryClientError && error.code === 'registry_unavailable',
    );
    assert.equal(unavailable.inspectCache(new Date('2026-07-27T12:00:00Z')).kind, 'ok');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('registry catalog searches signed fields with exact cache-bound cursors', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-registry-catalog-'));
  try {
    const payload = indexPayload();
    payload.packages.acme = {
      package_id: 'acme',
      display_name: 'Ｆｕｌｌｗｉｄｔｈ Market',
      description: 'Shopping products from Acme.',
      domains: ['acme.test'],
      tags: ['retail'],
      stable_version: '1.0.0',
      versions: {
        '1.0.0': {
          ...payload.packages.ikea.versions['1.0.0'],
          capabilities: {
            find_product: {
              description: 'Find products.',
              run_supported: false,
              transports: ['http_node'],
            },
          },
        },
      },
    };
    const signed = signedIndex(payload);
    let activeIndex = signed.index;
    let fetches = 0;
    const authority = {
      index_url: 'https://registry.example.test/v1/index.signed.json',
      public_key: signed.publicKey,
    };
    const registry = new RegistryClientV1(home, authority, async () => {
      fetches += 1;
      return responseWithBytes(Buffer.from(canonicalJson(activeIndex), 'utf8'));
    });
    const catalog = new RegistryCatalogV1(registry);
    const now = new Date('2026-07-27T12:00:00Z');

    const first = await catalog.search({ query: '  SHOPPING   PRODUCT ', limit: 1 }, now);
    assert.equal(first.query, 'shopping product');
    assert.deepEqual(
      first.items.map((item) => item.package_id),
      ['acme'],
    );
    assert.ok(first.next_cursor);
    assert.equal(fetches, 1);

    const second = await catalog.search(
      { query: 'shopping product', limit: 1, cursor: first.next_cursor },
      now,
    );
    assert.deepEqual(
      second.items.map((item) => item.package_id),
      ['ikea'],
    );
    assert.equal(second.next_cursor, null);
    assert.equal(fetches, 1);

    const normalized = await catalog.search({ query: 'fullwidth' }, now);
    assert.deepEqual(
      normalized.items.map((item) => item.package_id),
      ['acme'],
    );

    await assert.rejects(
      () => catalog.search({ query: 'other', cursor: first.next_cursor }, now),
      (error) => error instanceof RegistryCatalogError && error.code === 'cursor_invalid',
    );

    const unboundCursor = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString('utf8'));
    unboundCursor.last_package_id = 'missing';
    await assert.rejects(
      () =>
        catalog.search(
          {
            query: 'shopping product',
            cursor: Buffer.from(canonicalJson(unboundCursor), 'utf8').toString('base64url'),
          },
          now,
        ),
      (error) => error instanceof RegistryCatalogError && error.code === 'cursor_invalid',
    );

    const replacementPayload = { ...payload, generated_at: '2026-07-27T10:00:01Z' };
    activeIndex = {
      envelope_schema_version: 1,
      payload: replacementPayload,
      signature: {
        algorithm: 'ed25519',
        key_id: 'registry-v1',
        value: sign(
          null,
          Buffer.from(canonicalJson(replacementPayload)),
          signed.privateKey,
        ).toString('base64url'),
      },
    };
    await registry.refresh(now);
    await assert.rejects(
      () => catalog.search({ query: 'shopping product', cursor: first.next_cursor }, now),
      (error) => error instanceof RegistryCatalogError && error.code === 'cursor_stale',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('registry catalog shows a verified selected package without installing it', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-registry-show-'));
  try {
    const { value: packageValue, bytes: packageBytes } = publicPackageBytes();
    const payload = indexPayload();
    const version = payload.packages.ikea.versions['1.0.0'];
    version.package_url = 'https://registry.example.test/v1/packages/ikea.json';
    version.package_bytes = packageBytes.byteLength;
    version.package_digest = sha256Digest(packageBytes);
    version.manifest_digest = packageValue.manifest_digest;
    version.capabilities.get_product.run_supported = false;
    const { index, publicKey } = signedIndex(payload);
    const indexBytes = Buffer.from(canonicalJson(index), 'utf8');
    const authority = {
      index_url: 'https://registry.example.test/v1/index.signed.json',
      public_key: publicKey,
    };
    let packageDownloads = 0;
    const catalog = new RegistryCatalogV1(
      new RegistryClientV1(home, authority, async (url) => {
        if (url === authority.index_url) return responseWithBytes(indexBytes);
        packageDownloads += 1;
        return responseWithBytes(packageBytes);
      }),
    );
    const now = new Date('2026-07-27T12:00:00Z');

    const packageDetail = await catalog.show({ package_id: 'ikea' }, now);
    assert.equal(packageDetail.kind, 'package_detail');
    assert.equal(packageDetail.selected_version, '1.0.0');
    assert.equal(packageDetail.package.package_id, 'ikea');
    assert.equal(packageDetail.artifact.package_digest, sha256Digest(packageBytes));
    assert.equal(packageDownloads, 1);

    const capabilityDetail = await catalog.show(
      { package_id: 'ikea', capability: 'get_product' },
      now,
    );
    assert.equal(capabilityDetail.kind, 'capability_detail');
    assert.equal(capabilityDetail.capability.summary.capability, 'get_product');
    assert.equal(capabilityDetail.capability.summary.run_supported, false);
    assert.equal(capabilityDetail.capability.collection, null);
    assert.deepEqual(capabilityDetail.capability.request_origins, ['https://api.example.test']);
    assert.equal(packageDownloads, 2);

    await assert.rejects(
      () => catalog.show({ package_id: 'ikea', capability: 'not_present' }, now),
      (error) => error instanceof RegistryCatalogError && error.code === 'capability_not_found',
    );
    await assert.rejects(
      () => catalog.show({ package_id: 'ikea', unexpected: true }, now),
      (error) => error instanceof RegistryCatalogError && error.code === 'invalid_options',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installer requires a fresh verified index then activates only its projected immutable package', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-installer-'));
  try {
    const { value: packageValue, bytes: packageBytes } = publicPackageBytes();
    const payload = indexPayload();
    const version = payload.packages.ikea.versions['1.0.0'];
    version.package_url = 'https://registry.example.test/v1/packages/ikea.json';
    version.package_bytes = packageBytes.byteLength;
    version.package_digest = sha256Digest(packageBytes);
    version.manifest_digest = packageValue.manifest_digest;
    version.capabilities.get_product.run_supported = false;
    const { index, publicKey } = signedIndex(payload);
    const indexBytes = Buffer.from(canonicalJson(index), 'utf8');
    const authority = {
      index_url: 'https://registry.example.test/v1/index.signed.json',
      public_key: publicKey,
    };
    let packageDownloads = 0;
    const registry = new RegistryClientV1(home, authority, async (url) => {
      if (url === authority.index_url) return responseWithBytes(indexBytes);
      packageDownloads += 1;
      return responseWithBytes(packageBytes);
    });
    const store = new PackageStoreV1(home);
    const installer = new PackageInstallerV1(registry, store, '1.0.0');
    const now = new Date('2026-07-27T12:00:00Z');
    const first = await installer.install({ package_id: 'ikea' }, now);
    assert.equal(first.action, 'installed');
    assert.equal(first.artifact.manifest_digest, packageValue.manifest_digest);
    assert.deepEqual(store.getInstalled('ikea').provenance, {
      kind: 'registry',
      source_index_digest: sha256Digest(indexBytes),
    });
    assert.equal(packageDownloads, 1);

    const second = await installer.install({ package_id: 'ikea' }, now);
    assert.equal(second.action, 'already_active');
    assert.equal(packageDownloads, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installer rejects a downloaded package whose internal package id differs from the signed entry', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-installer-package-id-'));
  try {
    const packageValue = publicPackageValue();
    packageValue.package_id = 'other';
    packageValue.manifest_digest = calculatePublicToolPackageManifestDigest(packageValue);
    const packageBytes = Buffer.from(canonicalJson(packageValue), 'utf8');
    const payload = indexPayload();
    const version = payload.packages.ikea.versions['1.0.0'];
    version.package_url = 'https://registry.example.test/v1/packages/ikea.json';
    version.package_bytes = packageBytes.byteLength;
    version.package_digest = sha256Digest(packageBytes);
    version.manifest_digest = packageValue.manifest_digest;
    version.capabilities.get_product.run_supported = false;
    const { index, publicKey } = signedIndex(payload);
    const indexBytes = Buffer.from(canonicalJson(index), 'utf8');
    const authority = {
      index_url: 'https://registry.example.test/v1/index.signed.json',
      public_key: publicKey,
    };
    const registry = new RegistryClientV1(home, authority, async (url) =>
      responseWithBytes(url === authority.index_url ? indexBytes : packageBytes),
    );
    const store = new PackageStoreV1(home);
    const installer = new PackageInstallerV1(registry, store, '1.0.0');
    await assert.rejects(
      () => installer.install({ package_id: 'ikea' }, new Date('2026-07-27T12:00:00Z')),
      (error) => error instanceof InstallPackageError && error.code === 'package_invalid',
    );
    assert.equal(store.getInstalled('ikea'), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer registry service returns canonical success and failure envelopes', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-registry-service-'));
  try {
    const { value: packageValue, bytes: packageBytes } = publicPackageBytes();
    const payload = indexPayload();
    const version = payload.packages.ikea.versions['1.0.0'];
    version.package_url = 'https://registry.example.test/v1/packages/ikea.json';
    version.package_bytes = packageBytes.byteLength;
    version.package_digest = sha256Digest(packageBytes);
    version.manifest_digest = packageValue.manifest_digest;
    version.capabilities.get_product.run_supported = false;
    const { index, publicKey } = signedIndex(payload);
    const indexBytes = Buffer.from(canonicalJson(index), 'utf8');
    const authority = {
      index_url: 'https://registry.example.test/v1/index.signed.json',
      public_key: publicKey,
    };
    const store = new PackageStoreV1(home);
    const service = new ConsumerRegistryServiceV1(
      new RegistryClientV1(home, authority, async (url) =>
        responseWithBytes(url === authority.index_url ? indexBytes : packageBytes),
      ),
      store,
      '1.0.0',
    );
    const now = new Date('2026-07-27T12:00:00Z');

    const search = await service.search({ query: 'ikea' }, now);
    assert.equal(search.result_schema_version, 1);
    assert.equal(search.kind, 'package_search');
    assert.deepEqual(
      search.items.map((item) => item.package_id),
      ['ikea'],
    );

    const missing = await service.show({ package_id: 'missing' }, now);
    assert.deepEqual(missing, {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'show',
      code: 'package_not_found',
      retryable: false,
      package_id: 'missing',
    });

    const installed = await service.install({ package_id: 'ikea' }, now);
    assert.equal(installed.kind, 'install_result');
    assert.equal(installed.action, 'installed');
    assert.equal(installed.previous_active, null);
    assert.equal(installed.artifact.package_id, 'ikea');
    assert.equal(store.getInstalled('ikea')?.package_digest, sha256Digest(packageBytes));

    const invalid = await service.install({ package_id: 'ikea', unexpected: true }, now);
    assert.deepEqual(invalid, {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'install',
      code: 'invalid_options',
      retryable: false,
      package_id: null,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('registry parser rejects map-key mismatch, unknown keys, and expired source shape', () => {
  const mapMismatch = signedIndex().index;
  mapMismatch.payload.packages.ikea.package_id = 'other';
  assert.throws(
    () => verifySignedRegistryIndex(mapMismatch, signedIndex().publicKey),
    PublicContractError,
  );

  const withUnknownKey = signedIndex().index;
  withUnknownKey.payload.unexpected = true;
  assert.throws(
    () => verifySignedRegistryIndex(withUnknownKey, signedIndex().publicKey),
    PublicContractError,
  );

  const invalidWindow = signedIndex().index;
  invalidWindow.payload.expires_at = '2026-08-10T10:00:00Z';
  assert.throws(
    () => verifySignedRegistryIndex(invalidWindow, signedIndex().publicKey),
    PublicContractError,
  );
});

test('scalar parsers enforce canonical identifiers and closed version ranges', () => {
  assert.equal(parsePackageId('ikea-tools', 'package_id'), 'ikea-tools');
  assert.throws(() => parsePackageId('IKEA', 'package_id'), PublicContractError);
  assert.ok(comparePackageVersions('1.0.0-alpha', '1.0.0') < 0);
  assert.throws(
    () => parseRuntimeRange({ minimum_inclusive: '2.0.0', maximum_exclusive: '2.0.0' }, 'range'),
    PublicContractError,
  );
});

test('value expressions evaluate only through the closed data AST', () => {
  const expression = parseValueExpression({
    op: 'object',
    fields: {
      query: {
        op: 'url_encode',
        value: { op: 'input', pointer: '/query' },
      },
      numeric_id: {
        op: 'to_string',
        value: { op: 'input', pointer: '/numeric_id' },
      },
      signature: {
        op: 'hmac_sha256',
        key: { op: 'binding', name: 'secret' },
        value: {
          op: 'concat',
          values: [
            { op: 'literal', value: 'product:' },
            { op: 'input', pointer: '/id' },
          ],
        },
        encoding: 'hex',
      },
    },
  });
  const value = evaluateValueExpression(expression, {
    input: { id: '42', numeric_id: 42, query: 'tea & cake' },
    bindings: { secret: 'key' },
  });
  assert.deepEqual(value, {
    numeric_id: '42',
    query: 'tea%20%26%20cake',
    signature: '6616d0fabc2297046df65705e46f322046d6dddcc0dcc3a30558526febbc380c',
  });
});

test('value expressions reject executable shapes, bad pointers, and implicit coercion', () => {
  assert.throws(
    () => parseValueExpression({ op: 'eval', value: 'process.env' }),
    ValueExpressionError,
  );
  assert.throws(() => parseJsonPointer('#/id', 'pointer'), PublicContractError);
  const expression = parseValueExpression({ op: 'concat', values: [{ op: 'literal', value: 42 }] });
  assert.throws(
    () => evaluateValueExpression(expression, { input: null, bindings: {} }),
    ValueExpressionError,
  );
});

test('collection predicates use only declared JSON sources and exact structural values', () => {
  const argsOnly = new Set(['args']);
  const predicate = parseCollectionPredicate(
    {
      op: 'all',
      predicates: [
        {
          op: 'equals',
          left: { kind: 'ref', ref: { from: 'args', pointer: '/query' } },
          right: { kind: 'literal', value: 'chair' },
        },
        {
          op: 'array_length',
          ref: { from: 'args', pointer: '/ids' },
          relation: 'min',
          value: 2,
        },
      ],
    },
    'collection.mode',
    argsOnly,
  );
  assert.equal(
    evaluateCollectionPredicate(predicate, { args: { query: 'chair', ids: [1, 2] } }),
    true,
  );
  assert.equal(
    evaluateCollectionPredicate(predicate, { args: { query: 'chair', ids: [1] } }),
    false,
  );
  assert.equal(
    evaluateCollectionPredicate(predicate, { args: { query: 'chairs', ids: [1, 2] } }),
    false,
  );
  assert.throws(
    () =>
      parseCollectionPredicate(
        { op: 'exists', ref: { from: 'task_data', pointer: '/next' } },
        'collection.mode',
        argsOnly,
      ),
    PublicContractError,
  );
  assert.throws(
    () =>
      parseCollectionPredicate(
        {
          op: 'one_of',
          value: { kind: 'literal', value: 'x' },
          constants: ['x', 'x'],
        },
        'collection.mode',
        argsOnly,
      ),
    PublicContractError,
  );
});

test('semantic stops accept only exact typed cutoffs and compare calendar values without date guessing', () => {
  const [isoStop] = parseSemanticStops(
    [
      {
        id: 'published_since',
        kind: 'date_cutoff',
        bound_arg_pointer: '/since',
        item_value_pointer: '/published_at',
        comparator: { kind: 'iso_date', format: 'YYYY-MM-DD', timezone: 'UTC' },
        order: 'descending',
        inclusive: true,
        ordering_assertion_id: 'published_descending',
        invalid_item_value: 'item_invalid',
      },
    ],
    'collection.semantic_stops',
  );
  assert.ok(isoStop);
  const resolved = resolveSemanticStops([isoStop], { since: '2026-07-01' });
  assert.equal(resolved.length, 1);
  assert.equal(
    parseSemanticStopItemValue('2026-07-01', isoStop),
    resolved[0].bound,
  );
  assert.deepEqual(resolveSemanticStops([isoStop], {}), []);
  assert.throws(
    () => parseSemanticStopItemValue('2026-02-30', isoStop),
    /real proleptic Gregorian calendar date/,
  );
  assert.throws(
    () =>
      parseSemanticStops(
        [
          {
            id: 'published_since',
            kind: 'date_cutoff',
            bound_arg_pointer: '/since',
            item_value_pointer: '/published_at',
            comparator: { kind: 'iso_date', format: 'DD-MM-YYYY', timezone: 'UTC' },
            order: 'descending',
            inclusive: true,
            ordering_assertion_id: 'published_descending',
            invalid_item_value: 'item_invalid',
          },
        ],
        'collection.semantic_stops',
      ),
    /UTC YYYY-MM-DD comparator/,
  );
  const [instantStop] = parseSemanticStops(
    [
      {
        id: 'updated_after',
        kind: 'date_cutoff',
        bound_arg_pointer: '/after',
        item_value_pointer: '/updated_at',
        comparator: { kind: 'rfc3339_instant', require_explicit_offset: true },
        order: 'descending',
        inclusive: false,
        ordering_assertion_id: 'updated_descending',
        invalid_item_value: 'item_invalid',
      },
    ],
    'collection.semantic_stops',
  );
  assert.equal(
    parseSemanticStopItemValue('2026-07-01T10:00:00+02:00', instantStop),
    parseSemanticStopItemValue('2026-07-01T08:00:00Z', instantStop),
  );
  assert.throws(
    () => parseSemanticStopItemValue('2026-07-01T08:00:00', instantStop),
    /explicit offset/,
  );
});

test('scrape values project declared JSON sources without coercion or code', () => {
  const rawItemOnly = new Set(['raw_item']);
  const projection = parseScrapeValue(
    {
      op: 'object',
      entries: {
        id: { op: 'get', from: 'raw_item', pointer: '/id' },
        next_page: {
          op: 'add_integer',
          value: { op: 'get', from: 'raw_item', pointer: '/page' },
          amount: 1,
        },
      },
    },
    'collection.emit.projection',
    rawItemOnly,
  );
  assert.deepEqual(evaluateScrapeValue(projection, { raw_item: { id: '42', page: 2 } }), {
    id: '42',
    next_page: 3,
  });
  assert.throws(
    () => evaluateScrapeValue(projection, { raw_item: { id: '42', page: '2' } }),
    /safe integer/,
  );
  assert.throws(
    () =>
      parseScrapeValue(
        { op: 'get', from: 'args', pointer: '/secret' },
        'collection.emit.projection',
        rawItemOnly,
      ),
    PublicContractError,
  );
});

test('start URL templates bind only declared origins, route slots, and query keys', () => {
  const template = parseStartUrlTemplate(
    {
      id: 'search_root',
      origin: 'https://example.test',
      path: {
        segments: [
          { kind: 'literal', value: 'search' },
          { kind: 'slot', slot_id: 'query', min_utf8_bytes: 1, max_utf8_bytes: 32 },
        ],
        trailing_slash: 'forbidden',
      },
      query: [
        { key: 'page', max_values: 1, max_value_utf8_bytes: 3 },
        { key: 'sort', max_values: 1, max_value_utf8_bytes: 12 },
      ],
    },
    'collection.start_url_templates[0]',
  );
  assert.equal(
    validateStartUrl(
      template,
      'https://example.test/search/office%20chair?sort=top&page=2',
      'args.url',
    ),
    'https://example.test/search/office%20chair?page=2&sort=top',
  );
  assert.throws(
    () => validateStartUrl(template, 'https://other.test/search/chair?page=2', 'args.url'),
    PublicContractError,
  );
  assert.throws(
    () => validateStartUrl(template, 'https://example.test/search/a%2Fb?page=2', 'args.url'),
    /separators/,
  );
  assert.throws(
    () => validateStartUrl(template, 'https://example.test/search/chair?page=1&page=2', 'args.url'),
    /duplicated/,
  );
  assert.throws(
    () => validateStartUrl(template, 'https://example.test/search/chair?unknown=1', 'args.url'),
    /not declared/,
  );
});

test('scrape policies accept only explicit lower caller bounds and declared caller limits', () => {
  const policy = parseScrapeRunPolicy(
    {
      max_concurrency: 4,
      per_request_timeout_ms: 1_000,
      total_timeout_ms: 60_000,
      max_requests: 100,
      max_tasks: 100,
      max_pages: 50,
      max_items: 1_000,
      max_encoded_item_bytes: 512,
      max_output_bytes: 100_000,
      retry: {
        max_retries: 1,
        on: ['transport_failure'],
        base_delay_ms: 100,
        max_delay_ms: 100,
        jitter_ratio: 0,
        honor_structural_retry_after: true,
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
    'collection.run_policy',
  );
  const limits = [
    parseScrapeLimit({ id: 'per_seed', kind: 'caller', default: 5, maximum: 10 }, 'limits[0]'),
    parseScrapeLimit({ id: 'fixed_depth', kind: 'fixed', value: 2 }, 'limits[1]'),
  ];
  const effective = resolveEffectiveRunBounds(
    policy,
    limits,
    { max_items: 25, max_requests: 40, timeout_ms: 5_000, limits: { per_seed: 8 } },
    'run',
  );
  assert.equal(effective.policy.max_items, 25);
  assert.equal(effective.policy.max_requests, 40);
  assert.equal(effective.policy.total_timeout_ms, 5_000);
  assert.deepEqual(effective.named_limits, { per_seed: 8, fixed_depth: 2 });
  assert.throws(
    () => resolveEffectiveRunBounds(policy, limits, { max_pages: 51 }, 'run'),
    /from 1 to 50/,
  );
  assert.throws(
    () => resolveEffectiveRunBounds(policy, limits, { limits: { fixed_depth: 1 } }, 'run'),
    /fixed/,
  );
  assert.throws(
    () => resolveEffectiveRunBounds(policy, limits, { limits: { invented: 1 } }, 'run'),
    /declared/,
  );
  assert.throws(
    () => resolveEffectiveRunBounds(policy, limits, { max_items: 3_600_001 }, 'run'),
    /from 1 to 3600000/,
  );
  const oversizedLimits = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`limit_${index}`, 1]),
  );
  assert.throws(
    () => resolveEffectiveRunBounds(policy, limits, { limits: oversizedLimits }, 'run'),
    /at most 64 entries/,
  );
});

test('scrape input modes constrain roots to signed templates and declared data sources', () => {
  const templates = [
    parseStartUrlTemplate(
      {
        id: 'community_root',
        origin: 'https://example.test',
        path: {
          segments: [{ kind: 'literal', value: 'community' }],
          trailing_slash: 'forbidden',
        },
        query: [],
      },
      'templates[0]',
    ),
  ];
  const modes = parseScrapeInputModes(
    {
      ordered_mode_ids: ['communities'],
      conflict_policy: 'reject',
      modes: [
        {
          id: 'communities',
          populated_when: { op: 'exists', ref: { from: 'args', pointer: '/communities' } },
          roots: [
            {
              task_kind: 'list_posts',
              seed: {
                kind: 'for_each_input',
                array_pointer: '/communities',
                maximum: { id: 'community_count', kind: 'caller', default: 3, maximum: 10 },
                input: {
                  community: { op: 'get', from: 'seed', pointer: '' },
                  sort: { op: 'literal', value: 'top' },
                },
                start_url: {
                  source: { from: 'args', pointer: '/url' },
                  template_id: 'community_root',
                  bind_input: 'origin_url',
                },
              },
            },
          ],
        },
      ],
    },
    'collection.input_modes',
    templates,
  );
  assert.equal(modes.modes[0].roots[0].seed.kind, 'for_each_input');
  assert.throws(
    () =>
      parseScrapeInputModes(
        {
          ordered_mode_ids: ['one'],
          conflict_policy: 'reject',
          modes: [
            {
              id: 'one',
              populated_when: { op: 'exists', ref: { from: 'args', pointer: '/q' } },
              roots: [
                {
                  task_kind: 'list_posts',
                  seed: {
                    kind: 'once',
                    input: { origin_url: { op: 'literal', value: 'already-bound' } },
                    start_url: {
                      source: { from: 'args', pointer: '/url' },
                      template_id: 'missing_template',
                      bind_input: 'origin_url',
                    },
                  },
                },
              ],
            },
          ],
        },
        'collection.input_modes',
        templates,
      ),
    /declared start URL template/,
  );
  assert.throws(
    () =>
      parseScrapeInputModes(
        {
          ordered_mode_ids: ['one'],
          conflict_policy: 'reject',
          modes: [
            {
              id: 'one',
              populated_when: { op: 'exists', ref: { from: 'args', pointer: '/q' } },
              roots: [
                {
                  task_kind: 'list_posts',
                  seed: {
                    kind: 'once',
                    input: { value: { op: 'get', from: 'seed', pointer: '' } },
                    start_url: null,
                  },
                },
              ],
            },
          ],
        },
        'collection.input_modes',
        templates,
      ),
    /not available/,
  );
});

test('scrape task topology permits only structural pagination and acyclic parent-item fan-out', () => {
  const tasks = parseScrapeTaskKinds(
    [
      {
        id: 'list_posts',
        capability: 'list_posts',
        task_role: 'page',
        page_outcome_ids: ['page'],
        terminal_outcome_ids: ['empty'],
        emit: {
          items_pointer: '/items',
          cardinality: 'array',
          projection: { op: 'get', from: 'raw_item', pointer: '' },
          limit: null,
        },
        pagination: {
          contract: {
            kind: 'cursor',
            continue_when: { op: 'exists', ref: { from: 'task_data', pointer: '/next' } },
            exhausted_when: {
              op: 'not_exists',
              ref: { from: 'task_data', pointer: '/next' },
            },
            value_pointer: '/next',
            bind_input: 'cursor',
          },
          max_pages_per_chain: { id: 'page_cap', kind: 'fixed', value: 5 },
        },
        fanout: [
          {
            id: 'detail',
            child_task_kind: 'post_detail',
            when: null,
            input: { post_id: { op: 'get', from: 'parent_item', pointer: '/id' } },
            child_tasks_per_parent: 1,
          },
        ],
        on_failure: 'stop_run',
      },
      {
        id: 'post_detail',
        capability: 'post_detail',
        task_role: 'detail',
        page_outcome_ids: ['found'],
        terminal_outcome_ids: [],
        emit: {
          items_pointer: '',
          cardinality: 'one',
          projection: { op: 'get', from: 'raw_item', pointer: '' },
          limit: null,
        },
        pagination: null,
        fanout: [],
        on_failure: 'continue_independent',
      },
    ],
    'collection.task_kinds',
  );
  assert.equal(tasks[0].fanout[0].child_task_kind, 'post_detail');
  assert.throws(
    () =>
      parseScrapeTaskKinds(
        [
          {
            id: 'bad',
            capability: 'list_posts',
            task_role: 'detail',
            page_outcome_ids: ['page'],
            terminal_outcome_ids: [],
            emit: null,
            pagination: {
              contract: {
                kind: 'counter',
                continue_when: { op: 'exists', ref: { from: 'task_data', pointer: '/more' } },
                exhausted_when: {
                  op: 'not_exists',
                  ref: { from: 'task_data', pointer: '/more' },
                },
                bind_input: 'page',
                step: 1,
              },
              max_pages_per_chain: { id: 'cap', kind: 'fixed', value: 2 },
            },
            fanout: [],
            on_failure: 'stop_run',
          },
        ],
        'collection.task_kinds',
      ),
    /only allowed on a page task/,
  );
  assert.throws(
    () =>
      parseScrapeTaskKinds(
        [
          {
            id: 'loop',
            capability: 'list_posts',
            task_role: 'page',
            page_outcome_ids: ['page'],
            terminal_outcome_ids: [],
            emit: null,
            pagination: null,
            fanout: [
              {
                id: 'self',
                child_task_kind: 'loop',
                when: null,
                input: {},
                child_tasks_per_parent: 1,
              },
            ],
            on_failure: 'stop_run',
          },
        ],
        'collection.task_kinds',
      ),
    /acyclic/,
  );
});

test('JSON Schema subset is strict, bounded, and validates exact JSON shapes', () => {
  const schema = parseJsonSchema({
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 0 },
    },
    required: ['id'],
    additionalProperties: false,
    maxProperties: 2,
  });
  assert.deepEqual(validateJsonSchema({ id: 'item', count: 2 }, schema), { id: 'item', count: 2 });
  assert.throws(() => validateJsonSchema({ id: 'item', extra: true }, schema), PublicContractError);
  assert.throws(() => parseJsonSchema({ type: 'string', format: 'email' }), PublicContractError);
  assert.throws(() => parseJsonSchema({ $ref: 'https://example.com/schema' }), PublicContractError);
});

test('outcome contracts require structural success and verify the returned entity', () => {
  const success = parseOutcomeContract({
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
        strategy_ids: ['request'],
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
  });
  const response = {
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: { ok: true, item: { id: '42' } },
  };
  assert.equal(
    evaluateOutcomeContracts([success], 'request', response, { input: { id: '42' } }).kind,
    'outcome',
  );
  assert.equal(
    evaluateOutcomeContracts(
      [success],
      'request',
      { ...response, body: { ok: false, item: { id: '42' } } },
      { input: { id: '42' } },
    ).kind,
    'unclassified_response',
  );
  assert.equal(
    evaluateOutcomeContracts(
      [success],
      'request',
      { ...response, body: { ok: true, item: { id: 'other' } } },
      { input: { id: '42' } },
    ).kind,
    'verification_failed',
  );
  assert.equal(
    evaluateOutcomeContracts([success], 'request', response, {
      input: { id: '42' },
      maximum_output_bytes: 1,
    }).kind,
    'projection_failed',
  );
});

test('outcome assertions compare a closed input expression to the returned entity', () => {
  const success = parseOutcomeContract({
    outcome_id: 'success',
    class: 'success',
    output_schema: {
      type: 'object',
      properties: { full_name: { type: 'string' } },
      required: ['full_name'],
      additionalProperties: false,
    },
    cases: [
      {
        case_id: 'success_case',
        strategy_ids: ['request'],
        matcher: { op: 'status_in', values: [200] },
        projection: { kind: 'json_pointer', pointer: '/item' },
        assertions: [
          {
            assertion_id: 'returned_full_name',
            kind: 'input_output_expression_equal',
            input_expression: {
              op: 'concat',
              values: [
                { op: 'input', pointer: '/owner' },
                { op: 'literal', value: '/' },
                { op: 'input', pointer: '/repository' },
              ],
            },
            output_pointer: '/full_name',
          },
        ],
        retry_after: null,
      },
    ],
  });
  const context = { input: { owner: 'nodejs', repository: 'node' } };
  assert.equal(
    evaluateOutcomeContracts(
      [success],
      'request',
      {
        status: 200,
        headers: {},
        media_type: 'application/json',
        body_kind: 'json_object',
        body: { item: { full_name: 'nodejs/node' } },
      },
      context,
    ).kind,
    'outcome',
  );
  assert.equal(
    evaluateOutcomeContracts(
      [success],
      'request',
      {
        status: 200,
        headers: {},
        media_type: 'application/json',
        body_kind: 'json_object',
        body: { item: { full_name: 'nodejs/other' } },
      },
      context,
    ).kind,
    'verification_failed',
  );
  assert.throws(
    () =>
      parseOutcomeContract({
        outcome_id: 'invalid',
        class: 'success',
        output_schema: {
          type: 'object',
          properties: { full_name: { type: 'string' } },
          required: ['full_name'],
          additionalProperties: false,
        },
        cases: [
          {
            case_id: 'invalid_case',
            strategy_ids: ['request'],
            matcher: { op: 'status_in', values: [200] },
            projection: { kind: 'json_pointer', pointer: '/item' },
            assertions: [
              {
                assertion_id: 'binding_not_allowed',
                kind: 'input_output_expression_equal',
                input_expression: { op: 'binding', name: 'secret' },
                output_pointer: '/full_name',
              },
            ],
            retry_after: null,
          },
        ],
      }),
    PublicContractError,
  );
});

test('outcome contracts map declared JSON array entries without text inference', () => {
  const success = parseOutcomeContract({
    outcome_id: 'success',
    class: 'success',
    output_schema: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['id', 'name'],
        additionalProperties: false,
      },
    },
    cases: [
      {
        case_id: 'mapped_entries',
        strategy_ids: ['request'],
        matcher: {
          op: 'all',
          items: [
            { op: 'status_in', values: [200] },
            { op: 'body_kind', value: 'json_object' },
            {
              op: 'json_pointer',
              pointer: '/entries',
              test: 'type',
              value: null,
              expected_type: 'array',
            },
          ],
        },
        projection: {
          kind: 'json_array_map',
          items_pointer: '/entries',
          include_when: {
            op: 'equals',
            left: { kind: 'ref', ref: { from: 'raw_item', pointer: '/type' } },
            right: { kind: 'literal', value: 'PRODUCT' },
          },
          projection: {
            op: 'object',
            entries: {
              id: { op: 'get', from: 'raw_item', pointer: '/product/id' },
              name: { op: 'get', from: 'raw_item', pointer: '/product/name' },
            },
          },
        },
        assertions: [],
        retry_after: null,
      },
    ],
  });
  const response = {
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: {
      entries: [
        { type: 'CONTENT', content: { id: 'guide' } },
        { type: 'PRODUCT', product: { id: '42', name: 'Lamp' } },
      ],
    },
  };
  const classified = evaluateOutcomeContracts([success], 'request', response, { input: {} });
  assert.deepEqual(classified, {
    kind: 'outcome',
    outcome_id: 'success',
    outcome_class: 'success',
    case_id: 'mapped_entries',
    data: [{ id: '42', name: 'Lamp' }],
    retry_after_ms: null,
  });
  assert.equal(
    evaluateOutcomeContracts(
      [success],
      'request',
      {
        ...response,
        body: { entries: [{ type: 'CONTENT', content: { id: 'guide' } }] },
      },
      { input: {} },
    ).kind,
    'verification_failed',
  );
});

test('outcome contracts project a typed item page and structural cursor together', () => {
  const page = parseOutcomeContract({
    outcome_id: 'page',
    class: 'success',
    output_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['id', 'title'],
            additionalProperties: false,
          },
        },
        next_cursor: { type: 'string', minLength: 1 },
      },
      required: ['items', 'next_cursor'],
      additionalProperties: false,
    },
    cases: [
      {
        case_id: 'next_page',
        strategy_ids: ['request'],
        matcher: {
          op: 'all',
          items: [
            { op: 'status_in', values: [200] },
            { op: 'body_kind', value: 'json_object' },
            {
              op: 'json_pointer',
              pointer: '/data/children',
              test: 'type',
              value: null,
              expected_type: 'array',
            },
            {
              op: 'array_length',
              pointer: '/data/children',
              compare: 'gte',
              value: 1,
            },
            {
              op: 'json_pointer',
              pointer: '/data/after',
              test: 'type',
              value: null,
              expected_type: 'string',
            },
          ],
        },
        projection: {
          kind: 'json_object',
          entries: {
            items: {
              kind: 'json_array_map',
              items_pointer: '/data/children',
              include_when: null,
              projection: {
                op: 'object',
                entries: {
                  id: { op: 'get', from: 'raw_item', pointer: '/data/name' },
                  title: { op: 'get', from: 'raw_item', pointer: '/data/title' },
                },
              },
            },
            next_cursor: { kind: 'json_pointer', pointer: '/data/after' },
          },
        },
        assertions: [],
        retry_after: null,
      },
    ],
  });
  const classified = evaluateOutcomeContracts(
    [page],
    'request',
    {
      status: 200,
      headers: {},
      media_type: 'application/json',
      body_kind: 'json_object',
      body: {
        data: {
          after: 't3_next',
          children: [{ data: { name: 't3_a', title: 'A' } }],
        },
      },
    },
    { input: {} },
  );
  assert.deepEqual(classified, {
    kind: 'outcome',
    outcome_id: 'page',
    outcome_class: 'success',
    case_id: 'next_page',
    data: { items: [{ id: 't3_a', title: 'A' }], next_cursor: 't3_next' },
    retry_after_ms: null,
  });
});

test('outcome contracts extract retry-after only through their declared structural projection', () => {
  const rateLimited = parseOutcomeContract({
    outcome_id: 'rate_limited',
    class: 'rate_limited',
    output_schema: null,
    cases: [
      {
        case_id: 'limited',
        strategy_ids: ['request'],
        matcher: { op: 'status_in', values: [429] },
        projection: { kind: 'none' },
        assertions: [],
        retry_after: {
          kind: 'response_header_delta_seconds',
          header: 'retry-after',
          minimum_seconds: 1,
          maximum_seconds: 10,
        },
      },
    ],
  });
  const response = {
    status: 429,
    headers: { 'retry-after': '3' },
    media_type: 'application/json',
    body_kind: 'json_object',
    body: { retry_after: 'tomorrow' },
  };
  const classified = evaluateOutcomeContracts([rateLimited], 'request', response, { input: {} });
  assert.equal(classified.kind, 'outcome');
  assert.equal(classified.retry_after_ms, 3_000);
  const malformed = evaluateOutcomeContracts(
    [rateLimited],
    'request',
    { ...response, headers: { 'retry-after': '3 seconds' } },
    { input: {} },
  );
  assert.equal(malformed.kind, 'outcome');
  assert.equal(malformed.retry_after_ms, null);
});

test('login request-body accounting accepts only explicit bounded CDP representations', () => {
  assert.equal(
    measureBrowserRequestBodyBytes({ postData: 'grant=token', hasPostData: true }, 1_024),
    11,
  );
  assert.equal(
    measureBrowserRequestBodyBytes(
      { postDataEntries: [{ bytes: Buffer.from('token').toString('base64') }], hasPostData: true },
      1_024,
    ),
    5,
  );
  assert.equal(measureBrowserRequestBodyBytes({ hasPostData: true }, 1_024), null);
  assert.equal(measureBrowserRequestBodyBytes({ postDataEntries: [{}] }, 1_024), null);
  assert.equal(measureBrowserRequestBodyBytes({ postDataEntries: [{ bytes: 'token' }] }, 1_024), null);
  assert.equal(
    measureBrowserRequestBodyBytes(
      {
        postData: 'other',
        postDataEntries: [{ bytes: Buffer.from('token').toString('base64') }],
        hasPostData: true,
      },
      1_024,
    ),
    null,
  );
  assert.equal(
    measureBrowserRequestBodyBytes(
      {
        postData: 'token',
        postDataEntries: [{ bytes: Buffer.from('token').toString('base64') }],
        hasPostData: true,
      },
      1_024,
    ),
    5,
  );
  assert.equal(measureBrowserRequestBodyBytes({ postData: 'token', hasPostData: false }, 1_024), null);
  assert.equal(measureBrowserRequestBodyBytes({ postData: '1234' }, 3), 4);
});

test('public package parser binds the complete canonical manifest and data-only request surface', () => {
  const value = publicPackageValue();
  assert.equal(
    parsePublicToolPackage(value).capabilities.get_product.strategies[0].kind,
    'http_request',
  );
  value.capabilities.get_product.strategies[0].context = 'browser';
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(() => parsePublicToolPackage(value), PublicContractError);
});

test('public packages bind authentication realms to declared login sandboxes and structural checks', async () => {
  const value = authenticatedPackageValue();
  const parsed = parsePublicToolPackage(value);
  assert.deepEqual(parsed.capabilities.get_product.authentication, {
    mode: 'optional',
    authentication_contract_id: 'account',
  });
  assert.equal(
    parsed.authentication_contracts.account.login_url,
    'https://account.example.test/login',
  );
  assert.equal(
    parsed.authentication_contracts.account.browser_resources.egress_rules[1].methods[0],
    'POST',
  );

  const mixedLoginResourceTypes = authenticatedPackageValue();
  mixedLoginResourceTypes.authentication_contracts.account.browser_resources.egress_rules[0].resource_types = [
    'document',
    'script',
  ];
  mixedLoginResourceTypes.manifest_digest = calculatePublicToolPackageManifestDigest(
    mixedLoginResourceTypes,
  );
  assert.throws(() => parsePublicToolPackage(mixedLoginResourceTypes), /must not combine document/);

  const loginPing = authenticatedPackageValue();
  loginPing.authentication_contracts.account.browser_resources.egress_rules[0].resource_types = [
    'ping',
  ];
  loginPing.manifest_digest = calculatePublicToolPackageManifestDigest(loginPing);
  assert.throws(
    () => parsePublicToolPackage(loginPing),
    /may contain ping only for a resource rule/,
  );

  const multiStrategyCheck = authenticatedPackageValue();
  const secondaryCheckStrategy = structuredClone(
    multiStrategyCheck.capabilities.get_product.strategies[0],
  );
  secondaryCheckStrategy.request.strategy_id = 'second_check';
  multiStrategyCheck.capabilities.get_product.strategies = [
    multiStrategyCheck.capabilities.get_product.strategies[0],
    secondaryCheckStrategy,
  ];
  multiStrategyCheck.capabilities.get_product.outcomes[0].cases[0].strategy_ids = [
    'request',
    'second_check',
  ];
  multiStrategyCheck.manifest_digest = calculatePublicToolPackageManifestDigest(multiStrategyCheck);
  assert.throws(() => parsePublicToolPackage(multiStrategyCheck), /must declare exactly one strategy/);

  const retryingCheck = authenticatedPackageValue();
  retryingCheck.capabilities.get_product.call_retry_policy = {
    ...retryingCheck.capabilities.get_product.call_retry_policy,
    max_retries: 1,
    on: ['transport_failure'],
  };
  retryingCheck.capabilities.get_product.max_target_requests_per_call = 4;
  retryingCheck.manifest_digest = calculatePublicToolPackageManifestDigest(retryingCheck);
  assert.throws(() => parsePublicToolPackage(retryingCheck), /must not retry automatically/);

  value.capabilities.get_private_product = {
    ...value.capabilities.get_product,
    description: 'Get one private product.',
    authentication: { mode: 'required', authentication_contract_id: 'account' },
  };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  const requiredCapability = parsePublicToolPackage(value).capabilities.get_private_product;
  let dispatched = false;
  const caller = new PublicCallerV1(async () => {
    dispatched = true;
    throw new Error('must not dispatch without a selected session');
  });
  assert.deepEqual(await caller.call(requiredCapability, { id: 'desk' }), {
    kind: 'failure',
    code: 'session_required',
    attempts: 0,
  });
  assert.equal(dispatched, false);

  value.capabilities.get_private_product.authentication = {
    mode: 'optional',
    authentication_contract_id: 'missing',
  };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(() => parsePublicToolPackage(value), /does not name an authentication contract/);

  value.capabilities.get_private_product.authentication = {
    mode: 'required',
    authentication_contract_id: 'account',
  };
  value.capabilities.get_product.authentication = { mode: 'none' };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(() => parsePublicToolPackage(value), /optional mode/);

  value.capabilities.get_product.authentication = {
    mode: 'optional',
    authentication_contract_id: 'account',
  };
  value.authentication_contracts.account.check.authenticated_outcome_ids = ['missing'];
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(() => parsePublicToolPackage(value), /every success outcome/);
});

test('public packages admit declarative browser navigation only with a complete resource policy', async () => {
  const value = browserNavigationPackageValue();
  const capability = parsePublicToolPackage(value).capabilities.get_product;
  assert.equal(capability.strategies[0].kind, 'browser_navigation');
  assert.equal(capability.browser_resources?.egress_rules[0].rule_id, 'document');
  const browserOnlyCaller = new PublicCallerV1(undefined, undefined, async () => {
    throw new PublicHttpExecutionError('browser_unavailable', 'browser executable is unavailable');
  });
  assert.deepEqual(await browserOnlyCaller.call(capability, { id: 'desk' }), {
    kind: 'failure',
    code: 'browser_unavailable',
    attempts: 0,
  });
  const browserCaller = new PublicCallerV1(undefined, undefined, async () => ({
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: { id: 'desk' },
    target_requests: 1,
    html_selector_exists: (selector) => selector === 'main > h1',
  }));
  assert.deepEqual(await browserCaller.call(capability, { id: 'desk' }), {
    kind: 'outcome',
    outcome_id: 'success',
    outcome_class: 'success',
    case_id: 'success_case',
    data: { id: 'desk' },
    retry_after_ms: null,
    attempts: 1,
  });

  let storageState;
  const sessionCaller = new PublicCallerV1(
    undefined,
    undefined,
    async (_capability, _strategy, options) => {
      storageState = options.storage_state;
      return {
        status: 200,
        headers: {},
        media_type: 'application/json',
        body_kind: 'json_object',
        body: { id: 'desk' },
        target_requests: 1,
        html_selector_exists: (selector) => selector === 'main > h1',
      };
    },
  );
  assert.equal(
    (
      await sessionCaller.call(
        capability,
        { id: 'desk' },
        {
          browser_storage_state: { cookies: [{ name: 'session', value: 'opaque' }] },
        },
      )
    ).kind,
    'outcome',
  );
  assert.deepEqual(storageState, { cookies: [{ name: 'session', value: 'opaque' }] });

  value.capabilities.get_product.browser_resources = null;
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(() => parsePublicToolPackage(value), /required exactly/);
});

test('reviewed browser page scripts dispatch through structural outcomes and signed egress', async () => {
  const value = browserPageScriptPackageValue();
  const capability = parsePublicToolPackage(value).capabilities.get_product;
  assert.equal(capability.strategies[0].kind, 'browser_page_script');
  assert.deepEqual(getPublicCapabilityTransports(capability), ['browser_page_script']);
  let dispatched = 0;
  const caller = new PublicCallerV1(
    undefined,
    undefined,
    undefined,
    undefined,
    async (_capability, strategy, options) => {
      dispatched += 1;
      assert.equal(strategy.kind, 'browser_page_script');
      assert.deepEqual(options.input, { id: 'desk' });
      return {
        status: 200,
        headers: {},
        media_type: 'application/json',
        body_kind: 'json_object',
        body: { ok: true, message: 'failure text is not classification', item: { id: 'desk' } },
        target_requests: 2,
      };
    },
  );
  assert.deepEqual(await caller.call(capability, { id: 'desk' }), {
    kind: 'outcome',
    outcome_id: 'success',
    outcome_class: 'success',
    case_id: 'success_case',
    data: { id: 'desk' },
    retry_after_ms: null,
    attempts: 2,
  });
  assert.equal(dispatched, 1);
});

test('reviewed browser page-script contracts reject auth, cross-origin egress, and stale source', () => {
  const authenticated = browserPageScriptPackageValue();
  authenticated.capabilities.get_product.authentication = {
    mode: 'optional',
    authentication_contract_id: 'account',
  };
  authenticated.manifest_digest = calculatePublicToolPackageManifestDigest(authenticated);
  assert.throws(() => parsePublicToolPackage(authenticated), /must be none/);

  const multipleOrigins = browserPageScriptPackageValue();
  multipleOrigins.capabilities.get_product.navigation_origins.push('https://other.example.test');
  multipleOrigins.manifest_digest = calculatePublicToolPackageManifestDigest(multipleOrigins);
  assert.throws(() => parsePublicToolPackage(multipleOrigins), /exactly one origin/);

  const crossOrigin = browserPageScriptPackageValue();
  crossOrigin.capabilities.get_product.browser_resources.egress_rules[1].origin =
    'https://other.example.test';
  crossOrigin.manifest_digest = calculatePublicToolPackageManifestDigest(crossOrigin);
  assert.throws(() => parsePublicToolPackage(crossOrigin), /same-origin page_script rules/);

  const crossOriginNavigation = browserPageScriptPackageValue();
  crossOriginNavigation.capabilities.get_product.browser_resources.egress_rules[0].origin =
    'https://other.example.test';
  crossOriginNavigation.manifest_digest =
    calculatePublicToolPackageManifestDigest(crossOriginNavigation);
  assert.throws(
    () => parsePublicToolPackage(crossOriginNavigation),
    /every navigation rule.*sole reviewed page-script origin/,
  );

  const crossOriginPreparation = browserPageScriptPackageValue();
  crossOriginPreparation.capabilities.get_product.browser_resources.egress_rules.push({
    rule_id: 'prepare',
    phase: 'interaction',
    origin: 'https://other.example.test',
    methods: ['GET'],
    route: { path: { kind: 'exact', value: '/prepare' }, query: { kind: 'none' } },
    resource_types: ['fetch'],
    max_requests: 1,
    max_encoded_request_body_bytes: 0,
    max_encoded_response_bytes: 1024,
  });
  crossOriginPreparation.capabilities.get_product.strategies[0].interaction = {
    initial: [
      {
        action_id: 'prepare',
        kind: 'click',
        target: { frame: { kind: 'main' }, selector: 'button.prepare' },
        expect: {
          wait: null,
          egress_rule_ids: ['prepare'],
          minimum_matching_requests: 0,
          maximum_matching_requests: 1,
        },
      },
    ],
    repeat: null,
  };
  crossOriginPreparation.manifest_digest =
    calculatePublicToolPackageManifestDigest(crossOriginPreparation);
  assert.throws(
    () => parsePublicToolPackage(crossOriginPreparation),
    /same-origin interaction rules/,
  );

  const crossOriginFrame = browserPageScriptPackageValue();
  crossOriginFrame.capabilities.get_product.browser_resources.egress_rules.push({
    rule_id: 'embedded',
    phase: 'interaction',
    origin: 'https://other.example.test',
    methods: ['GET'],
    route: { path: { kind: 'exact', value: '/embedded' }, query: { kind: 'none' } },
    resource_types: ['fetch'],
    max_requests: 1,
    max_encoded_request_body_bytes: 0,
    max_encoded_response_bytes: 1024,
  });
  crossOriginFrame.capabilities.get_product.strategies[0].interaction = {
    initial: [
      {
        action_id: 'embedded',
        kind: 'fill',
        target: {
          frame: {
            kind: 'child',
            frame_selector: 'iframe.embedded',
            origin: 'https://other.example.test',
          },
          selector: 'input.search',
        },
        value: { op: 'input', pointer: '/id' },
        expect: {
          wait: null,
          egress_rule_ids: [],
          minimum_matching_requests: 0,
          maximum_matching_requests: 0,
        },
      },
    ],
    repeat: null,
  };
  crossOriginFrame.manifest_digest = calculatePublicToolPackageManifestDigest(crossOriginFrame);
  assert.throws(
    () => parsePublicToolPackage(crossOriginFrame),
    /target\.frame\.origin.*sole reviewed page-script origin/,
  );

  const excessiveGlobalBody = browserPageScriptPackageValue();
  excessiveGlobalBody.capabilities.get_product.strategies[0].program.request_body_limits = {
    max_encoded_request_body_bytes_per_script: 1,
    max_single_request_body_bytes: 1,
    max_encoded_request_body_bytes_by_rule: { product_script: 0 },
  };
  excessiveGlobalBody.manifest_digest =
    calculatePublicToolPackageManifestDigest(excessiveGlobalBody);
  assert.throws(
    () => parsePublicToolPackage(excessiveGlobalBody),
    /enclosing browser resource body limits/,
  );

  const excessiveSingleBody = browserPageScriptPackageValue();
  excessiveSingleBody.capabilities.get_product.browser_resources
    .max_encoded_request_body_bytes_per_browser_task = 2;
  excessiveSingleBody.capabilities.get_product.strategies[0].program.request_body_limits = {
    max_encoded_request_body_bytes_per_script: 2,
    max_single_request_body_bytes: 1,
    max_encoded_request_body_bytes_by_rule: { product_script: 0 },
  };
  excessiveSingleBody.manifest_digest =
    calculatePublicToolPackageManifestDigest(excessiveSingleBody);
  assert.throws(
    () => parsePublicToolPackage(excessiveSingleBody),
    /enclosing browser resource body limits/,
  );

  const excessiveRuleBody = browserPageScriptPackageValue();
  const excessiveRuleCapability = excessiveRuleBody.capabilities.get_product;
  excessiveRuleCapability.browser_resources.max_encoded_request_body_bytes_per_browser_task = 2;
  excessiveRuleCapability.browser_resources.max_single_request_body_bytes = 2;
  excessiveRuleCapability.browser_resources.egress_rules[1].methods = ['POST'];
  excessiveRuleCapability.browser_resources.egress_rules[1].max_encoded_request_body_bytes = 1;
  excessiveRuleCapability.strategies[0].program.request_body_limits = {
    max_encoded_request_body_bytes_per_script: 2,
    max_single_request_body_bytes: 2,
    max_encoded_request_body_bytes_by_rule: { product_script: 2 },
  };
  excessiveRuleBody.manifest_digest =
    calculatePublicToolPackageManifestDigest(excessiveRuleBody);
  assert.throws(
    () => parsePublicToolPackage(excessiveRuleBody),
    /must not exceed the enclosing browser egress rule body limit/,
  );

  const wrongPhase = browserPageScriptPackageValue();
  wrongPhase.capabilities.get_product.browser_resources.egress_rules[1].phase = 'interaction';
  wrongPhase.manifest_digest = calculatePublicToolPackageManifestDigest(wrongPhase);
  assert.throws(() => parsePublicToolPackage(wrongPhase), /page_script egress rule/);

  const broadResource = browserPageScriptPackageValue();
  broadResource.capabilities.get_product.browser_resources.egress_rules[1].resource_types = [
    'script',
  ];
  broadResource.manifest_digest = calculatePublicToolPackageManifestDigest(broadResource);
  assert.throws(() => parsePublicToolPackage(broadResource), /only fetch and xhr/);

  const insufficientBudget = browserPageScriptPackageValue();
  insufficientBudget.capabilities.get_product.max_target_requests_per_call = 1;
  insufficientBudget.manifest_digest =
    calculatePublicToolPackageManifestDigest(insufficientBudget);
  assert.throws(
    () => parsePublicToolPackage(insufficientBudget),
    /must cover navigation.*required page-script requests/,
  );

  const staleSource = browserPageScriptPackageValue();
  staleSource.capabilities.get_product.strategies[0].program.source += ' ';
  staleSource.manifest_digest = calculatePublicToolPackageManifestDigest(staleSource);
  assert.throws(() => parsePublicToolPackage(staleSource), /exact reviewed source bytes/);
});

test('public packages admit browser-context HTTP only through bootstrap and runtime-request rules', async () => {
  const value = browserHttpPackageValue();
  const capability = parsePublicToolPackage(value).capabilities.get_product;
  assert.equal(capability.strategies[0].kind, 'http_request');
  assert.equal(capability.strategies[0].context, 'browser');
  const browserHttpCaller = new PublicCallerV1(undefined, undefined, undefined, async () => ({
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: { ok: true, item: { id: 'desk' } },
    target_requests: 2,
  }));
  assert.deepEqual(await browserHttpCaller.call(capability, { id: 'desk' }), {
    kind: 'outcome',
    outcome_id: 'success',
    outcome_class: 'success',
    case_id: 'success_case',
    data: { id: 'desk' },
    retry_after_ms: null,
    attempts: 2,
  });

  value.capabilities.get_product.browser_resources.egress_rules.pop();
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(() => parsePublicToolPackage(value), /browser-context HTTP request/);
});

test('public browser interaction programs are declarative and bind only interaction egress rules', () => {
  const value = browserNavigationPackageValue();
  value.capabilities.get_product.browser_resources.egress_rules.push({
    rule_id: 'refresh',
    phase: 'interaction',
    origin: 'https://shop.example.test',
    methods: ['GET'],
    route: { path: { kind: 'exact', value: '/refresh' }, query: { kind: 'none' } },
    resource_types: ['fetch'],
    max_requests: 1,
    max_encoded_request_body_bytes: 0,
    max_encoded_response_bytes: 1024,
  });
  value.capabilities.get_product.strategies[0].interaction = {
    initial: [
      {
        action_id: 'refresh_products',
        kind: 'click',
        target: { frame: { kind: 'main' }, selector: 'button.refresh' },
        expect: {
          wait: null,
          egress_rule_ids: ['refresh'],
          minimum_matching_requests: 0,
          maximum_matching_requests: 1,
        },
      },
    ],
    repeat: null,
  };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  const capability = parsePublicToolPackage(value).capabilities.get_product;
  assert.equal(capability.strategies[0].kind, 'browser_navigation');
  assert.equal(capability.strategies[0].interaction?.initial[0]?.kind, 'click');

  value.capabilities.get_product.strategies[0].interaction.initial[0].expect.egress_rule_ids = [
    'document',
  ];
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(() => parsePublicToolPackage(value), /interaction egress rule/);
});

test('public package source compiler emits deterministic validated package bytes', () => {
  const packageValue = publicPackageValue();
  const { manifest_digest: ignoredManifest, ...sourcePackage } = packageValue;
  assert.equal(typeof ignoredManifest, 'string');
  const compiled = compilePublicPackageSource({
    package_source_schema_version: 1,
    package: sourcePackage,
  });
  assert.equal(compiled.manifest_digest, compiled.package.manifest_digest);
  assert.equal(
    compiled.bytes.toString('utf8'),
    canonicalJson({ ...sourcePackage, manifest_digest: compiled.manifest_digest }),
  );
  assert.deepEqual(
    parsePublicToolPackage(JSON.parse(compiled.bytes.toString('utf8'))),
    compiled.package,
  );
  assert.throws(
    () =>
      compilePublicPackageSource({
        package_source_schema_version: 1,
        package: packageValue,
      }),
    /manifest_digest.*not allowed/,
  );
});

test('public package compiler owns reviewed page-script source digests', () => {
  const packageValue = browserPageScriptPackageValue();
  const { manifest_digest: ignoredManifest, ...sourcePackage } = JSON.parse(
    canonicalJson(packageValue),
  );
  assert.equal(typeof ignoredManifest, 'string');
  const source = sourcePackage.capabilities.get_product.strategies[0].program.source;
  sourcePackage.capabilities.get_product.strategies[0].program.source_digest = null;
  const compiled = compilePublicPackageSource({
    package_source_schema_version: 1,
    package: sourcePackage,
  });
  assert.equal(
    compiled.package.capabilities.get_product.strategies[0].program.source_digest,
    sha256Digest(source),
  );

  sourcePackage.capabilities.get_product.strategies[0].program.source_digest = sha256Digest(source);
  assert.throws(
    () =>
      compilePublicPackageSource({
        package_source_schema_version: 1,
        package: sourcePackage,
      }),
    /source_digest.*must be null in source/,
  );
});

test('strict local js-eval export compiles into an installable reviewed page script', () => {
  const packageValue = browserPageScriptPackageValue();
  const publicStrategy = packageValue.capabilities.get_product.strategies[0];
  const localStrategy = {
    strategy: 'page-script',
    baseUrl: 'https://shop.example.test',
    endpoint: '/unused',
    method: 'GET',
    prerequisites: [
      {
        name: 'product_result',
        kind: 'js-eval',
        url: 'https://shop.example.test/product?id={{id}}',
        expression:
          '(async () => await (await fetch(`/products?id=${encodeURIComponent(args.id)}`)).json())()',
        binds: 'product_result',
        args_template: { id: '{{id}}', mode: 'product' },
        return_shape: { kind: 'object', required_keys: ['ok', 'item'] },
      },
    ],
    response: { from: 'product_result', format: 'json' },
  };
  const exported = exportReviewedLocalPageScriptStrategySource({
    local_strategy: localStrategy,
    input_schema: packageValue.capabilities.get_product.input_schema,
    strategy_id: publicStrategy.strategy_id,
    wait: publicStrategy.wait,
    interaction: publicStrategy.interaction,
    expect: publicStrategy.program.expect,
    request_body_limits: publicStrategy.program.request_body_limits,
    replay: publicStrategy.replay,
  });
  assert.equal(exported.kind, 'browser_page_script');
  assert.equal(exported.program.source_digest, null);
  assert.deepEqual(exported.program.result_shape, {
    kind: 'object',
    required_keys: ['item', 'ok'],
  });
  assert.deepEqual(exported.program.arguments, {
    op: 'object',
    fields: {
      id: { op: 'to_string', value: { op: 'input', pointer: '/id' } },
      mode: { op: 'literal', value: 'product' },
    },
  });
  assert.deepEqual(exported.url, {
    op: 'concat',
    values: [
      { op: 'literal', value: 'https://shop.example.test/product?id=' },
      { op: 'to_string', value: { op: 'input', pointer: '/id' } },
    ],
  });

  const { manifest_digest: ignoredManifest, ...sourcePackage } = JSON.parse(
    canonicalJson(packageValue),
  );
  assert.equal(typeof ignoredManifest, 'string');
  sourcePackage.capabilities.get_product.strategies = [exported];
  const compiled = compilePublicPackageSource({
    package_source_schema_version: 1,
    package: sourcePackage,
  });
  assert.equal(
    compiled.package.capabilities.get_product.strategies[0].program.source_digest,
    sha256Digest(exported.program.source),
  );
  assert.equal(
    parsePublicToolPackage(JSON.parse(compiled.bytes.toString('utf8'))).capabilities.get_product
      .strategies[0].kind,
    'browser_page_script',
  );

  const mismatched = JSON.parse(canonicalJson(localStrategy));
  mismatched.response.from = 'other_result';
  assert.throws(
    () =>
      exportReviewedLocalPageScriptStrategySource({
        local_strategy: mismatched,
        input_schema: packageValue.capabilities.get_product.input_schema,
        strategy_id: publicStrategy.strategy_id,
        wait: publicStrategy.wait,
        interaction: publicStrategy.interaction,
        expect: publicStrategy.program.expect,
        request_body_limits: publicStrategy.program.request_body_limits,
        replay: publicStrategy.replay,
      }),
    /must exactly equal the js-eval binds value/,
  );

  const chained = JSON.parse(canonicalJson(localStrategy));
  chained.prerequisites.unshift({
    name: 'bootstrap',
    kind: 'page-extract',
    url: 'https://shop.example.test/',
    vars: { title: { selector: 'title' } },
  });
  assert.throws(
    () =>
      exportReviewedLocalPageScriptStrategySource({
        local_strategy: chained,
        input_schema: packageValue.capabilities.get_product.input_schema,
        strategy_id: publicStrategy.strategy_id,
        wait: publicStrategy.wait,
        interaction: publicStrategy.interaction,
        expect: publicStrategy.program.expect,
        request_body_limits: publicStrategy.program.request_body_limits,
        replay: publicStrategy.replay,
      }),
    /exactly one js-eval prerequisite/,
  );

  const structuredInput = JSON.parse(canonicalJson(packageValue.capabilities.get_product.input_schema));
  structuredInput.properties.payload = {
    type: 'object',
    properties: { nested: { type: 'boolean' } },
    required: ['nested'],
    additionalProperties: false,
  };
  structuredInput.required.push('payload');
  const structuredTemplate = JSON.parse(canonicalJson(localStrategy));
  structuredTemplate.prerequisites[0].args_template.payload = '{{payload}}';
  assert.throws(
    () =>
      exportReviewedLocalPageScriptStrategySource({
        local_strategy: structuredTemplate,
        input_schema: structuredInput,
        strategy_id: publicStrategy.strategy_id,
        wait: publicStrategy.wait,
        interaction: publicStrategy.interaction,
        expect: publicStrategy.program.expect,
        request_body_limits: publicStrategy.program.request_body_limits,
        replay: publicStrategy.replay,
      }),
    /must resolve to a string, number, integer, or boolean/,
  );

  const optionalInput = JSON.parse(canonicalJson(packageValue.capabilities.get_product.input_schema));
  optionalInput.required = [];
  assert.throws(
    () =>
      exportReviewedLocalPageScriptStrategySource({
        local_strategy: localStrategy,
        input_schema: optionalInput,
        strategy_id: publicStrategy.strategy_id,
        wait: publicStrategy.wait,
        interaction: publicStrategy.interaction,
        expect: publicStrategy.program.expect,
        request_body_limits: publicStrategy.program.request_body_limits,
        replay: publicStrategy.replay,
      }),
    /must name a required declared input property/,
  );

  const nullInput = JSON.parse(canonicalJson(packageValue.capabilities.get_product.input_schema));
  nullInput.properties.nil = { type: 'null' };
  nullInput.required.push('nil');
  const nullTemplate = JSON.parse(canonicalJson(localStrategy));
  nullTemplate.prerequisites[0].args_template.nil = '{{nil}}';
  assert.throws(
    () =>
      exportReviewedLocalPageScriptStrategySource({
        local_strategy: nullTemplate,
        input_schema: nullInput,
        strategy_id: publicStrategy.strategy_id,
        wait: publicStrategy.wait,
        interaction: publicStrategy.interaction,
        expect: publicStrategy.program.expect,
        request_body_limits: publicStrategy.program.request_body_limits,
        replay: publicStrategy.replay,
      }),
    /must resolve to a string, number, integer, or boolean/,
  );
});

test('compiler derives only finite inline output bounds from the item schema', () => {
  const packageValue = semanticCutoffPackageValue();
  const { manifest_digest: ignoredManifest, ...sourcePackage } = JSON.parse(
    canonicalJson(packageValue),
  );
  assert.equal(typeof ignoredManifest, 'string');
  sourcePackage.capabilities.get_product.collection.inline_output_bound = null;
  const rawPackage = {
    ...sourcePackage,
    manifest_digest: calculatePublicToolPackageManifestDigest({
      ...sourcePackage,
      manifest_digest: '0'.repeat(64),
    }),
  };
  assert.throws(
    () => parsePublicToolPackage(rawPackage),
    /compiler-derived finite item bound/,
  );
  const compiled = compilePublicPackageSource({
    package_source_schema_version: 1,
    package: sourcePackage,
  });
  assert.deepEqual(
    compiled.package.capabilities.get_product.collection?.inline_output_bound,
    deriveInlineOutputBound(parseJsonSchema(packageValue.capabilities.get_product.collection.item_schema)),
  );
  assert.throws(
    () =>
      compilePublicPackageSource({
        package_source_schema_version: 1,
        package: (() => {
          const retained = JSON.parse(canonicalJson(sourcePackage));
          retained.capabilities.get_product.collection.inline_output_bound =
            packageValue.capabilities.get_product.collection.inline_output_bound;
          return retained;
        })(),
      }),
    /must be null in source/,
  );
});

test('registry release entry compiler derives the signed catalog projection from public package bytes', () => {
  const packageValue = publicPackageValue();
  const { manifest_digest: ignoredManifest, ...sourcePackage } = packageValue;
  assert.equal(typeof ignoredManifest, 'string');
  sourcePackage.capabilities.search_repositories_page = JSON.parse(
    JSON.stringify(sourcePackage.capabilities.get_product),
  );
  sourcePackage.capabilities.search_repositories_page.description =
    'Fetch one repository-results page.';
  sourcePackage.capabilities.search_repositories_page.visibility = 'internal';
  const compiled = compileRegistryReleaseEntry({
    registry_origin: 'https://registry.example.test',
    package_source: {
      package_source_schema_version: 1,
      package: sourcePackage,
    },
    catalog: {
      display_name: 'IKEA',
      description: 'Read products from IKEA.',
      domains: ['ikea.com'],
      tags: ['shopping'],
      state: 'installable',
      runtime_range: { minimum_inclusive: '1.0.0', maximum_exclusive: '2.0.0' },
    },
  });
  assert.equal(compiled.catalog.display_name, 'IKEA');
  assert.equal(compiled.registry_version.version, '1.0.0');
  assert.equal(compiled.registry_version.package_digest, sha256Digest(compiled.package.bytes));
  assert.equal(
    compiled.registry_version.package_url,
    `https://registry.example.test/v1/packages/${compiled.registry_version.package_digest}.json`,
  );
  assert.deepEqual(compiled.registry_version.capabilities.get_product, {
    description: 'Get one product.',
    run_supported: false,
    transports: ['http_node'],
  });
  assert.deepEqual(Object.keys(compiled.registry_version.capabilities), ['get_product']);
  assert.equal(compiled.package.package.capabilities.search_repositories_page.visibility, 'internal');
  const withdrawn = compileRegistryReleaseEntry({
    registry_origin: 'https://registry.example.test',
    package_source: {
      package_source_schema_version: 1,
      package: sourcePackage,
    },
    catalog: {
      display_name: 'IKEA',
      description: 'Read products from IKEA.',
      domains: ['ikea.com'],
      tags: ['shopping'],
      state: 'withdrawn',
      runtime_range: { minimum_inclusive: '1.0.0', maximum_exclusive: '2.0.0' },
    },
  });
  assert.equal(withdrawn.registry_version.state, 'withdrawn');
  assert.throws(
    () =>
      compileRegistryReleaseEntry({
        registry_origin: 'https://registry.example.test',
        package_source: {
          package_source_schema_version: 1,
          package: sourcePackage,
        },
        catalog: {
          display_name: 'IKEA',
          description: 'Read products from IKEA.',
          domains: ['ikea.com'],
          tags: ['shopping'],
          state: 'installable',
          runtime_range: { minimum_inclusive: '2.0.0', maximum_exclusive: '1.0.0' },
        },
      }),
    PublicContractError,
  );
});

test('static registry compiler assembles and signs only validated release entries', () => {
  const packageValue = publicPackageValue();
  const { manifest_digest: ignoredManifest, ...sourcePackage } = packageValue;
  assert.equal(typeof ignoredManifest, 'string');
  const entry = compileRegistryReleaseEntry({
    registry_origin: 'https://registry.example.test',
    package_source: {
      package_source_schema_version: 1,
      package: sourcePackage,
    },
    catalog: {
      display_name: 'IKEA',
      description: 'Read products from IKEA.',
      domains: ['ikea.com'],
      tags: ['shopping'],
      state: 'installable',
      runtime_range: { minimum_inclusive: '1.0.0', maximum_exclusive: '2.0.0' },
    },
  });
  const index = compileStaticRegistryIndex({
    generated_at: '2026-07-27T10:00:00Z',
    expires_at: '2026-07-28T10:00:00Z',
    packages: [{ stable_version: '1.0.0', entries: [entry] }],
  });
  assert.deepEqual(Object.keys(index.packages), ['ikea']);
  assert.equal(
    index.packages.ikea.versions['1.0.0'].package_digest,
    entry.registry_version.package_digest,
  );
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = signStaticRegistryIndex(index, privateKey);
  assert.deepEqual(verifySignedRegistryIndex(signed, publicKey), signed);
  assert.throws(
    () =>
      compileStaticRegistryIndex({
        generated_at: '2026-07-27T10:00:00Z',
        expires_at: '2026-07-28T10:00:00Z',
        packages: [
          { stable_version: '1.0.0', entries: [entry] },
          { stable_version: '1.0.0', entries: [entry] },
        ],
      }),
    PublicContractError,
  );
});

test('public packages bind a finite read collection to reviewed capabilities and outcomes', async () => {
  const value = publicPackageValue();
  value.capabilities.get_product.input_schema.properties.cursor = {
    type: 'string',
    minLength: 1,
  };
  value.capabilities.get_detail = JSON.parse(JSON.stringify(value.capabilities.get_product));
  value.capabilities.get_detail.description = 'Get one product detail.';
  value.capabilities.get_detail.visibility = 'internal';
  value.capabilities.get_product.collection = {
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
              task_kind: 'product_page',
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
    csv_columns: [{ name: 'id', pointer: '/id' }],
    task_kinds: [
      {
        id: 'product_page',
        capability: 'get_detail',
        task_role: 'page',
        page_outcome_ids: ['success'],
        terminal_outcome_ids: [],
        emit: {
          items_pointer: '/item',
          cardinality: 'one',
          projection: { op: 'get', from: 'raw_item', pointer: '' },
          limit: null,
        },
        pagination: {
          contract: {
            kind: 'cursor',
            continue_when: { op: 'exists', ref: { from: 'task_data', pointer: '/next' } },
            exhausted_when: {
              op: 'not_exists',
              ref: { from: 'task_data', pointer: '/next' },
            },
            value_pointer: '/next',
            bind_input: 'cursor',
          },
          max_pages_per_chain: { id: 'page_cap', kind: 'fixed', value: 2 },
        },
        fanout: [
          {
            id: 'detail',
            child_task_kind: 'product_detail',
            when: null,
            input: { id: { op: 'get', from: 'parent_item', pointer: '/id' } },
            child_tasks_per_parent: 1,
          },
        ],
        on_failure: 'stop_run',
      },
      {
        id: 'product_detail',
        capability: 'get_detail',
        task_role: 'detail',
        page_outcome_ids: ['success'],
        terminal_outcome_ids: [],
        emit: null,
        pagination: null,
        fanout: [],
        on_failure: 'continue_independent',
      },
    ],
    max_fanout_depth: 1,
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
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  const parsed = parsePublicToolPackage(value);
  assert.equal(parsed.capabilities.get_detail.visibility, 'internal');
  assert.equal(parsed.capabilities.get_product.collection.task_kinds[0].capability, 'get_detail');
  const { manifest_digest: ignoredManifestDigest, ...sourcePackage } = value;
  assert.equal(typeof ignoredManifestDigest, 'string');
  const encodedCollectionSource = Buffer.from(
    canonicalJson({ package_source_schema_version: 1, package: sourcePackage }),
    'utf8',
  );
  assert.throws(
    () =>
      parseStrictJson(
        encodedCollectionSource,
        'collection_source',
        PUBLIC_CONTRACT_LIMITS.packageBytes,
        PUBLIC_CONTRACT_LIMITS.maxDepth,
      ),
    /exceeds maximum depth 12/,
  );
  const compiledCollection = compilePublicPackageSource(
    parseStrictJson(
      encodedCollectionSource,
      'collection_source',
      PUBLIC_CONTRACT_LIMITS.packageBytes,
      PUBLIC_CONTRACT_LIMITS.maxPackageDepth,
    ),
  );
  assert.deepEqual(compiledCollection.package, parsed);
  assert.equal(compiledCollection.bytes.toString('utf8'), canonicalJson(value));
  const mixedRealmCollection = authenticatedCollectionPackageValue();
  mixedRealmCollection.capabilities.get_detail = JSON.parse(
    JSON.stringify(mixedRealmCollection.capabilities.get_product),
  );
  mixedRealmCollection.capabilities.get_detail.collection = null;
  mixedRealmCollection.capabilities.get_detail.authentication = { mode: 'none' };
  mixedRealmCollection.capabilities.get_product.collection.task_kinds.push({
    id: 'unreachable_detail',
    capability: 'get_detail',
    task_role: 'detail',
    page_outcome_ids: ['success'],
    terminal_outcome_ids: [],
    emit: null,
    pagination: null,
    fanout: [],
    on_failure: 'continue_independent',
  });
  mixedRealmCollection.manifest_digest = calculatePublicToolPackageManifestDigest(
    mixedRealmCollection,
  );
  assert.throws(
    () => parsePublicToolPackage(mixedRealmCollection),
    /same authentication realm/,
  );
  const duplicateColumnPackage = JSON.parse(JSON.stringify(value));
  duplicateColumnPackage.capabilities.get_product.collection.csv_columns = [
    { name: 'id', pointer: '/id' },
    { name: 'id', pointer: '/id' },
  ];
  duplicateColumnPackage.manifest_digest =
    calculatePublicToolPackageManifestDigest(duplicateColumnPackage);
  assert.throws(() => parsePublicToolPackage(duplicateColumnPackage), /must not be duplicated/);
  const plan = planScrapeRun(
    parsed.capabilities.get_product,
    parsed.capabilities,
    { id: '42' },
    {},
  );
  assert.equal(
    planScrapeRun(parsed.capabilities.get_product, parsed.capabilities, { id: '42' }, {}, 'by_id')
      .selected_input_mode_id,
    'by_id',
  );
  assert.throws(
    () =>
      planScrapeRun(parsed.capabilities.get_product, parsed.capabilities, { id: '42' }, {}, 'none'),
    /not declared/,
  );
  assert.deepEqual(plan.roots, [
    {
      task_kind_id: 'product_page',
      capability: 'get_detail',
      input: { id: '42' },
      root_ordinal: 0,
      seed_ordinal: null,
    },
  ]);
  const runHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-service-'));
  try {
    const inputs = [];
    const browserStorageStates = [];
    const runSession = {
      reference: {
        authentication_contract_id: 'account',
        session_name: 'default',
        generation: 4,
        state_digest: 'd'.repeat(64),
        authentication_contract_digest: 'e'.repeat(64),
      },
      browser_storage_state: { cookies: [{ name: 'session', value: 'private-run-cookie' }] },
    };
    const caller = {
      call: async (_capability, runInput, options) => {
        inputs.push(runInput);
        browserStorageStates.push(options.browser_storage_state);
        return inputs.length === 1
          ? {
              kind: 'outcome',
              outcome_id: 'success',
              outcome_class: 'success',
              case_id: 'success_case',
              data: { item: { id: '42' }, next: 'cursor-2' },
              retry_after_ms: null,
              attempts: 1,
            }
          : {
              kind: 'outcome',
              outcome_id: 'success',
              outcome_class: 'success',
              case_id: 'success_case',
              data: { item: { id: '42' } },
              retry_after_ms: null,
              attempts: 1,
            };
      },
    };
    const blockedOutputPath = path.join(runHome, 'already-present.ndjson');
    writeFileSync(blockedOutputPath, 'taken');
    assert.throws(
      () =>
        new ScrapeRunServiceV1(new RunStoreV1(runHome), caller).startDetached({
          artifact: {
            package_id: 'ikea',
            version: '1.0.0',
            package_digest: 'a'.repeat(64),
            capability: 'get_product',
            runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
          },
          owner: parsed.capabilities.get_product,
          capabilities: parsed.capabilities,
          input: { id: '42' },
          caller_bounds: {},
          output: {
            kind: 'file',
            requested_path: blockedOutputPath,
            format: 'ndjson',
          },
        }),
      /output path already exists/,
    );
    assert.deepEqual(inputs, []);
    const requestedOutputPath = path.join(runHome, 'requested-output.ndjson');
    const run = await new ScrapeRunServiceV1(new RunStoreV1(runHome), caller).start({
      artifact: {
        package_id: 'ikea',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_product',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner: parsed.capabilities.get_product,
      capabilities: parsed.capabilities,
      input: { id: '42' },
      caller_bounds: {},
      output: {
        kind: 'file',
        requested_path: requestedOutputPath,
        format: 'ndjson',
      },
      session: runSession,
    });
    assert.deepEqual(run, {
      kind: 'scrape_outcome',
      run_id: run.run_id,
      stop: { kind: 'source_exhausted' },
      summary: {
        items_emitted: 1,
        items_duplicate: 1,
        tasks_completed: 3,
        tasks_failed: 0,
        target_requests: 3,
      },
    });
    // The declared frame floor must hold for what a run actually appends,
    // or a package could pass the parser and still exhaust its own journal.
    const appendedJournal = readJournal(
      readFileSync(new RunStoreV1(runHome).journalPath(run.run_id)),
      run.run_id,
    );
    const appendedFrames = appendedJournal.frames.length;
    for (const frame of appendedJournal.frames) {
      const bytes = frame.end_offset - frame.offset;
      assert.ok(
        bytes <= JOURNAL_ORDINARY_FRAME_BYTES_V1,
        `${frame.body.event.kind} frame encodes to ${bytes} bytes, above the per-frame allowance`,
      );
    }
    assert.ok(
      appendedFrames <=
        JOURNAL_FRAMES_FIXED_V1 +
          JOURNAL_FRAMES_PER_TASK_V1 * run.summary.tasks_completed +
          JOURNAL_FRAMES_PER_ITEM_V1 * (run.summary.items_emitted + run.summary.items_duplicate),
      `run appended ${appendedFrames} journal frames, above the declared per-task and per-item accounting`,
    );
    const storedRunMeta = new RunStoreV1(runHome).read(run.run_id).payload;
    assert.deepEqual(storedRunMeta.output, {
      kind: 'file',
      requested_path: requestedOutputPath,
      format: 'ndjson',
    });
    assert.deepEqual(storedRunMeta.session, runSession.reference);
    assert.equal(
      readFileSync(new RunStoreV1(runHome).journalPath(run.run_id).replace(/journal\.log$/, 'meta.json'), 'utf8').includes(
        'private-run-cookie',
      ),
      false,
    );
    assert.equal(readFileSync(requestedOutputPath, 'utf8'), '{"id":"42"}\n');
    assert.deepEqual(readCommittedRunItems(new RunStoreV1(runHome), run.run_id), [{ id: '42' }]);
    const itemPage = readCommittedRunItemsPage(new RunStoreV1(runHome), run.run_id, {
      limit: 1,
    });
    assert.deepEqual(
      itemPage.items.map((entry) => entry.item),
      [{ id: '42' }],
    );
    assert.equal(itemPage.next_after_sequence, null);
    assert.ok(itemPage.items[0]?.sequence > 0);
    assert.deepEqual(
      new ConsumerRunServiceV1(new PackageStoreV1(runHome)).items(run.run_id, {
        after_sequence: 0,
        limit: 1,
      }),
      itemPage,
    );
    const streamedItems = [];
    for await (const event of new ConsumerRunServiceV1(
      new PackageStoreV1(runHome),
    ).followItems(run.run_id)) {
      streamedItems.push(event);
    }
    assert.deepEqual(streamedItems, [
      { kind: 'item', item: itemPage.items[0] },
      {
        kind: 'end',
        lifecycle: 'terminal',
        last_sequence: itemPage.items[0].sequence,
      },
    ]);
    assert.deepEqual(
      readCommittedRunItemsPage(new RunStoreV1(runHome), run.run_id, {
        after_sequence: itemPage.items[0]?.sequence,
      }).items,
      [],
    );
    const inspected = inspectStoredRun(new RunStoreV1(runHome), run.run_id);
    assert.deepEqual(inspected.lifecycle, {
      kind: 'terminal',
      result_kind: 'scrape_outcome',
      stop: { kind: 'source_exhausted' },
      sequence: 22,
    });
    assert.equal(inspected.committed_item_count, 1);
    assert.equal(inspected.state_version, 22);
    assert.deepEqual(new RunStoreV1(runHome).listRunIds(), [run.run_id]);
    const runService = new ConsumerRunServiceV1(new PackageStoreV1(runHome));
    assert.deepEqual(runService.discard(run.run_id), {
      kind: 'not_quarantined',
      run_id: run.run_id,
    });
    assert.equal(existsSync(new RunStoreV1(runHome).journalPath(run.run_id)), true);
    const nodeFrames = recoverJournalFile(
      new RunStoreV1(runHome).journalPath(run.run_id),
      run.run_id,
    ).frames;
    const sinkFrames = nodeFrames.filter((frame) => frame.body.event.kind === 'sink_committed');
    assert.equal(sinkFrames.length, 1);
    const sinkFrame = sinkFrames[0];
    if (!sinkFrame || sinkFrame.body.event.kind !== 'sink_committed') {
      throw new Error('expected one sink commit');
    }
    assert.equal(sinkFrame.body.event.through_item_sequence < sinkFrame.body.sequence, true);
    assert.equal(sinkFrame.body.event.byte_offset, Buffer.byteLength('{"id":"42"}\n', 'utf8'));
    assert.deepEqual(recoverRunState(new RunStoreV1(runHome), run.run_id).last_sink_commit, {
      through_item_sequence: sinkFrame.body.event.through_item_sequence,
      byte_offset: sinkFrame.body.event.byte_offset,
      prefix_digest: sinkFrame.body.event.prefix_digest,
    });
    const runCreated = nodeFrames[0]?.body.event;
    if (!runCreated || runCreated.kind !== 'run_created' || !runCreated.initial_nodes) {
      throw new Error('expected recoverable initial root nodes');
    }
    const initialNodes = runCreated.initial_nodes.map((reference) =>
      readDataBlob(new RunStoreV1(runHome).dataSpoolPath(run.run_id), reference),
    );
    assert.equal(initialNodes.length, 1);
    const nodeEnqueueFrames = nodeFrames.filter(
      (frame) => frame.body.event.kind === 'node_enqueued',
    );
    assert.equal(nodeEnqueueFrames.length, 1);
    for (const frame of nodeEnqueueFrames) {
      const event = frame.body.event;
      if (event.kind !== 'node_enqueued') throw new Error('expected node event');
      const node = readDataBlob(
        new RunStoreV1(runHome).dataSpoolPath(run.run_id),
        event.node_state,
      );
      assert.equal(node.node_id, event.node_id);
      assert.equal(sha256Digest(canonicalJson(node.logical_key)), event.logical_key_digest);
    }
    const rootNode = initialNodes[0];
    if (!rootNode || typeof rootNode !== 'object' || Array.isArray(rootNode)) {
      throw new Error('expected root node state');
    }
    const rootNodeId = rootNode.node_id;
    if (typeof rootNodeId !== 'string') throw new Error('expected root node id');
    assert.deepEqual(
      readCommittedNodeItems(new RunStoreV1(runHome), run.run_id, rootNodeId),
      [{ id: '42' }],
    );
    const nodeIds = new Set(
      [
        rootNodeId,
        ...nodeEnqueueFrames.map((frame) => {
          const event = frame.body.event;
          if (event.kind !== 'node_enqueued') throw new Error('expected node event');
          return event.node_id;
        }),
      ],
    );
    const lifecycleFrames = recoverJournalFile(
      new RunStoreV1(runHome).journalPath(run.run_id),
      run.run_id,
    ).frames;
    assert.equal(
      lifecycleFrames.filter((frame) => frame.body.event.kind === 'node_completed').length,
      2,
    );
    assert.equal(
      lifecycleFrames.filter((frame) => frame.body.event.kind === 'task_completed').length,
      3,
    );
    assert.equal(
      lifecycleFrames.filter((frame) => frame.body.event.kind === 'item_duplicate').length,
      1,
    );
    for (const frame of lifecycleFrames) {
      const event = frame.body.event;
      if (event.kind === 'attempt_intent' || event.kind === 'attempt_observed') {
        assert.equal(nodeIds.has(event.node_id), true);
      }
    }
    const progressFrame = lifecycleFrames.find(
      (frame) => frame.body.event.kind === 'node_progressed',
    );
    assert.ok(progressFrame);
    if (progressFrame?.body.event.kind === 'node_progressed') {
      assert.deepEqual(
        readDataBlob(
          new RunStoreV1(runHome).dataSpoolPath(run.run_id),
          progressFrame.body.event.node_state,
        ),
        {
          node_id: rootNodeId,
          logical_key: { kind: 'root', root_ordinal: 0, seed_ordinal: null },
          task_kind_id: 'product_page',
          capability: 'get_detail',
          input: { id: '42', cursor: 'cursor-2' },
          root_ordinal: 0,
          seed_ordinal: null,
          depth: 0,
          output_ordinal: 0,
          seen_input_digests: [
            sha256Digest(canonicalJson({ id: '42' })),
            sha256Digest(canonicalJson({ id: '42', cursor: 'cursor-2' })),
          ],
          pages_started_in_chain: 1,
        },
      );
    }
    const recoveredRun = recoverRunState(new RunStoreV1(runHome), run.run_id);
    assert.deepEqual(
      recoveredRun.nodes.map((recovered) => recovered.state),
      ['completed', 'completed'],
    );
    assert.deepEqual(recoveredRun.resume, { allowed: false, reason: 'already_terminal' });
    assert.equal(recoveredRun.last_execution_epoch, 0);
    assert.equal(recoveredRun.last_frame_digest, lifecycleFrames.at(-1)?.digest ?? null);
    const spoolPath = new RunStoreV1(runHome).dataSpoolPath(run.run_id);
    const acceptedSpoolLength = readFileSync(spoolPath).byteLength;
    writeFileSync(
      spoolPath,
      Buffer.concat([readFileSync(spoolPath), Buffer.from('{"orphan":true}', 'utf8')]),
    );
    recoverRunState(new RunStoreV1(runHome), run.run_id);
    assert.equal(readFileSync(spoolPath).byteLength, acceptedSpoolLength);
    const listed = new ConsumerRunServiceV1(new PackageStoreV1(runHome)).listPage({
      limit: 100,
    }).items;
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0]?.lifecycle, inspected.lifecycle);
    const outputPath = path.join(runHome, 'items.ndjson');
    const exported = exportCommittedRunItemsNdjson(new RunStoreV1(runHome), run.run_id, outputPath);
    assert.deepEqual(exported, {
      run_id: run.run_id,
      items_written: 1,
      bytes_written: Buffer.byteLength('{"id":"42"}\n', 'utf8'),
      path: outputPath,
    });
    assert.equal(readFileSync(outputPath, 'utf8'), '{"id":"42"}\n');
    const jsonOutputPath = path.join(runHome, 'items.json');
    const jsonExport = exportCommittedRunItems(
      new RunStoreV1(runHome),
      run.run_id,
      jsonOutputPath,
      {
        format: 'json',
        csv_columns: null,
      },
    );
    assert.deepEqual(jsonExport, {
      run_id: run.run_id,
      items_written: 1,
      bytes_written: Buffer.byteLength('[{"id":"42"}]', 'utf8'),
      path: jsonOutputPath,
    });
    assert.equal(readFileSync(jsonOutputPath, 'utf8'), '[{"id":"42"}]');
    const csvOutputPath = path.join(runHome, 'items.csv');
    const csvExport = exportCommittedRunItems(new RunStoreV1(runHome), run.run_id, csvOutputPath, {
      format: 'csv',
      csv_columns: parsed.capabilities.get_product.collection.csv_columns,
    });
    assert.deepEqual(csvExport, {
      run_id: run.run_id,
      items_written: 1,
      bytes_written: Buffer.byteLength('"id"\n"42"\n', 'utf8'),
      path: csvOutputPath,
    });
    assert.equal(readFileSync(csvOutputPath, 'utf8'), '"id"\n"42"\n');
    assert.throws(
      () =>
        exportCommittedRunItems(
          new RunStoreV1(runHome),
          run.run_id,
          path.join(runHome, 'bad.csv'),
          {
            format: 'csv',
            csv_columns: null,
          },
        ),
      /requires declared collection columns/,
    );
    assert.throws(
      () => exportCommittedRunItemsNdjson(new RunStoreV1(runHome), run.run_id, outputPath),
      /already exists/,
    );
    assert.deepEqual(inputs, [{ id: '42' }, { id: '42', cursor: 'cursor-2' }, { id: '42' }]);
    assert.deepEqual(browserStorageStates, [
      runSession.browser_storage_state,
      runSession.browser_storage_state,
      runSession.browser_storage_state,
    ]);
    const resumeHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-resume-'));
    try {
      const resumedOutputPath = path.join(resumeHome, 'resumed-output.ndjson');
      const interrupted = await new ScrapeRunServiceV1(new RunStoreV1(resumeHome), {
        call: async (_capability, runInput) =>
          'cursor' in runInput
            ? {
                kind: 'outcome',
                outcome_id: 'success',
                outcome_class: 'success',
                case_id: 'success_case',
                data: { item: { id: '42' } },
                retry_after_ms: null,
                attempts: 1,
              }
            : {
                kind: 'outcome',
                outcome_id: 'success',
                outcome_class: 'success',
                case_id: 'success_case',
                data: { item: { id: '42' }, next: 'cursor-2' },
                retry_after_ms: null,
                attempts: 1,
              },
      }).start({
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
        },
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
        input: { id: '42' },
        caller_bounds: {},
        output: {
          kind: 'file',
          requested_path: resumedOutputPath,
          format: 'ndjson',
        },
      });
      const interruptedStore = new RunStoreV1(resumeHome);
      const interruptedFrames = recoverJournalFile(
        interruptedStore.journalPath(interrupted.run_id),
        interrupted.run_id,
      ).frames;
      const progress = interruptedFrames.find(
        (frame) => frame.body.event.kind === 'node_progressed',
      );
      assert.ok(progress);
      unlinkSync(resumedOutputPath);
      writeFileSync(
        interruptedStore.journalPath(interrupted.run_id),
        readFileSync(interruptedStore.journalPath(interrupted.run_id)).subarray(
          0,
          progress.end_offset,
        ),
      );
      assert.deepEqual(recoverRunState(interruptedStore, interrupted.run_id).resume, {
        allowed: false,
        reason: 'not_interrupted',
      });
      assert.deepEqual(interruptUnfinishedRunsAtStartup(resumeHome), [
        { run_id: interrupted.run_id, kind: 'interrupted' },
      ]);
      assert.deepEqual(recoverRunState(interruptedStore, interrupted.run_id).resume, {
        allowed: true,
        pending_node_ids: [
          (() => {
            const event = interruptedFrames[0]?.body.event;
            if (!event || event.kind !== 'run_created' || !event.initial_nodes) {
              throw new Error('expected recoverable root node');
            }
            const node = readDataBlob(
              interruptedStore.dataSpoolPath(interrupted.run_id),
              event.initial_nodes[0],
            );
            if (!node || typeof node !== 'object' || Array.isArray(node)) {
              throw new Error('expected root node state');
            }
            if (typeof node.node_id !== 'string') throw new Error('expected root node id');
            return node.node_id;
          })(),
        ],
      });
      const resumedInputs = [];
      const resumedStorageStates = [];
      const resumed = await new ScrapeRunServiceV1(interruptedStore, {
        call: async (_capability, runInput, options) => {
          resumedInputs.push(runInput);
          resumedStorageStates.push(options.browser_storage_state);
          return {
            kind: 'outcome',
            outcome_id: 'success',
            outcome_class: 'success',
            case_id: 'success_case',
            data: { item: { id: '42' } },
            retry_after_ms: null,
            attempts: 1,
          };
        },
      }).resume({
        run_id: interrupted.run_id,
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: interruptedStore.read(interrupted.run_id).payload.artifact.runtime_range,
          collection_contract_digest: interruptedStore.read(interrupted.run_id).payload.artifact
            .collection_contract_digest,
        },
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
        session: runSession,
      });
      assert.deepEqual(resumed, {
        kind: 'scrape_outcome',
        run_id: interrupted.run_id,
        stop: { kind: 'source_exhausted' },
        summary: {
          items_emitted: 1,
          items_duplicate: 1,
          tasks_completed: 3,
          tasks_failed: 0,
          target_requests: 3,
        },
      });
      assert.deepEqual(resumedInputs, [{ id: '42', cursor: 'cursor-2' }, { id: '42' }]);
      assert.deepEqual(resumedStorageStates, [
        runSession.browser_storage_state,
        runSession.browser_storage_state,
      ]);
      assert.equal(readFileSync(resumedOutputPath, 'utf8'), '{"id":"42"}\n');
      assert.deepEqual(readCommittedRunItems(interruptedStore, interrupted.run_id), [{ id: '42' }]);
      const resumedFrames = recoverJournalFile(
        interruptedStore.journalPath(interrupted.run_id),
        interrupted.run_id,
      ).frames;
      assert.equal(resumedFrames.at(-1)?.body.execution_epoch, 1);
      assert.deepEqual(
        resumedFrames.find((frame) => frame.body.execution_epoch === 1)?.body.event,
        {
          kind: 'state_changed',
          state: { kind: 'running', execution_epoch: 1, current_node_id: null },
        },
      );
    } finally {
      rmSync(resumeHome, { recursive: true, force: true });
    }
    const replayHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-safe-read-replay-'));
    try {
      const replayOutputPath = path.join(replayHome, 'safe-read-replay.ndjson');
      let initialCalls = 0;
      const interrupted = await new ScrapeRunServiceV1(new RunStoreV1(replayHome), {
        call: async () => {
          initialCalls += 1;
          return {
            kind: 'outcome',
            outcome_id: 'success',
            outcome_class: 'success',
            case_id: 'success_case',
            data: { item: { id: '42' } },
            retry_after_ms: null,
            attempts: 1,
          };
        },
      }).start({
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
        },
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
        input: { id: '42' },
        caller_bounds: {},
        output: {
          kind: 'file',
          requested_path: replayOutputPath,
          format: 'ndjson',
        },
      });
      assert.equal(initialCalls, 2);
      unlinkSync(replayOutputPath);
      const replayStore = new RunStoreV1(replayHome);
      const completedFrames = recoverJournalFile(
        replayStore.journalPath(interrupted.run_id),
        interrupted.run_id,
      ).frames;
      const buffered = completedFrames.find((frame) => frame.body.event.kind === 'item_buffered');
      assert.ok(buffered);
      writeFileSync(
        replayStore.journalPath(interrupted.run_id),
        readFileSync(replayStore.journalPath(interrupted.run_id)).subarray(0, buffered.end_offset),
      );
      assert.deepEqual(interruptUnfinishedRunsAtStartup(replayHome), [
        { run_id: interrupted.run_id, kind: 'interrupted' },
      ]);
      assert.deepEqual(recoverRunState(replayStore, interrupted.run_id).resume, {
        allowed: false,
        reason: 'unknown_attempt',
      });
      let replayCalls = 0;
      const resumed = await new ScrapeRunServiceV1(replayStore, {
        call: async () => {
          replayCalls += 1;
          return {
            kind: 'outcome',
            outcome_id: 'success',
            outcome_class: 'success',
            case_id: 'success_case',
            data: { item: { id: '42' } },
            retry_after_ms: null,
            attempts: 1,
          };
        },
      }).resume({
        run_id: interrupted.run_id,
        artifact: replayStore.read(interrupted.run_id).payload.artifact,
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
      });
      assert.equal(replayCalls, 2);
      assert.deepEqual(resumed, {
        kind: 'scrape_outcome',
        run_id: interrupted.run_id,
        stop: { kind: 'source_exhausted' },
        summary: {
          items_emitted: 1,
          items_duplicate: 0,
          tasks_completed: 2,
          tasks_failed: 0,
          target_requests: 3,
        },
      });
      const replayFrames = recoverJournalFile(
        replayStore.journalPath(interrupted.run_id),
        interrupted.run_id,
      ).frames;
      const replayAuthorization = replayFrames.findIndex(
        (frame) => frame.body.event.kind === 'node_replay_authorized',
      );
      const replayAttempt = replayFrames.findIndex(
        (frame, index) =>
          index > replayAuthorization && frame.body.event.kind === 'attempt_intent',
      );
      assert.ok(replayAuthorization > 0);
      assert.ok(replayAttempt > replayAuthorization);
      assert.equal(replayFrames[replayAuthorization - 1]?.body.event.kind, 'state_changed');

      const unsafeHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-unsafe-replay-'));
      try {
        const unsafeOutputPath = path.join(unsafeHome, 'unsafe-replay.ndjson');
        const unsafeInterrupted = await new ScrapeRunServiceV1(new RunStoreV1(unsafeHome), {
          call: async () => ({
            kind: 'outcome',
            outcome_id: 'success',
            outcome_class: 'success',
            case_id: 'success_case',
            data: { item: { id: '42' } },
            retry_after_ms: null,
            attempts: 1,
          }),
        }).start({
          artifact: {
            package_id: 'ikea',
            version: '1.0.0',
            package_digest: 'a'.repeat(64),
            capability: 'get_product',
            runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
          },
          owner: parsed.capabilities.get_product,
          capabilities: parsed.capabilities,
          input: { id: '42' },
          caller_bounds: {},
          output: {
            kind: 'file',
            requested_path: unsafeOutputPath,
            format: 'ndjson',
          },
        });
        unlinkSync(unsafeOutputPath);
        const unsafeStore = new RunStoreV1(unsafeHome);
        const unsafeObserved = recoverJournalFile(
          unsafeStore.journalPath(unsafeInterrupted.run_id),
          unsafeInterrupted.run_id,
        ).frames.find((frame) => frame.body.event.kind === 'attempt_observed');
        assert.ok(unsafeObserved);
        writeFileSync(
          unsafeStore.journalPath(unsafeInterrupted.run_id),
          readFileSync(unsafeStore.journalPath(unsafeInterrupted.run_id)).subarray(
            0,
            unsafeObserved.end_offset,
          ),
        );
        interruptUnfinishedRunsAtStartup(unsafeHome);
        const unsafePage = {
          ...parsed.capabilities.get_detail,
          strategies: parsed.capabilities.get_detail.strategies.map((strategy) => ({
            ...strategy,
            replay: 'indeterminate',
          })),
        };
        let unsafeReplayCalls = 0;
        await assert.rejects(
          () =>
            new ScrapeRunServiceV1(unsafeStore, {
              call: async () => {
                unsafeReplayCalls += 1;
                throw new Error('must not send traffic');
              },
            }).resume({
              run_id: unsafeInterrupted.run_id,
              artifact: unsafeStore.read(unsafeInterrupted.run_id).payload.artifact,
              owner: parsed.capabilities.get_product,
              capabilities: { ...parsed.capabilities, get_detail: unsafePage },
            }),
          /does not declare safe_read replay/,
        );
        assert.equal(unsafeReplayCalls, 0);
      } finally {
        rmSync(unsafeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(replayHome, { recursive: true, force: true });
    }
    const bootstrapHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-bootstrap-recovery-'));
    try {
      const bootstrapOutputPath = path.join(bootstrapHome, 'bootstrap.ndjson');
      const bootstrap = await new ScrapeRunServiceV1(new RunStoreV1(bootstrapHome), {
        call: async () => ({
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: '42' } },
          retry_after_ms: null,
          attempts: 1,
        }),
      }).start({
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
        },
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
        input: { id: '42' },
        caller_bounds: {},
        output: { kind: 'file', requested_path: bootstrapOutputPath, format: 'ndjson' },
      });
      const bootstrapStore = new RunStoreV1(bootstrapHome);
      const bootstrapFrames = recoverJournalFile(
        bootstrapStore.journalPath(bootstrap.run_id),
        bootstrap.run_id,
      ).frames;
      const bootstrapCreated = bootstrapFrames[0];
      assert.ok(bootstrapCreated);
      if (!bootstrapCreated || bootstrapCreated.body.event.kind !== 'run_created') {
        throw new Error('expected initial run frame');
      }
      assert.equal(bootstrapCreated.body.event.initial_nodes?.length, 1);
      unlinkSync(bootstrapOutputPath);
      writeFileSync(
        bootstrapStore.journalPath(bootstrap.run_id),
        readFileSync(bootstrapStore.journalPath(bootstrap.run_id)).subarray(
          0,
          bootstrapCreated.end_offset,
        ),
      );
      assert.deepEqual(interruptUnfinishedRunsAtStartup(bootstrapHome), [
        { run_id: bootstrap.run_id, kind: 'interrupted' },
      ]);
      const bootstrapResumeCalls = [];
      const resumedBootstrap = await new ScrapeRunServiceV1(bootstrapStore, {
        call: async (_capability, runInput) => {
          bootstrapResumeCalls.push(runInput);
          return {
            kind: 'outcome',
            outcome_id: 'success',
            outcome_class: 'success',
            case_id: 'success_case',
            data: { item: { id: '42' } },
            retry_after_ms: null,
            attempts: 1,
          };
        },
      }).resume({
        run_id: bootstrap.run_id,
        artifact: bootstrapStore.read(bootstrap.run_id).payload.artifact,
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
      });
      assert.equal(resumedBootstrap.kind, 'scrape_outcome');
      assert.deepEqual(bootstrapResumeCalls, [{ id: '42' }, { id: '42' }]);
      assert.deepEqual(readCommittedRunItems(bootstrapStore, bootstrap.run_id), [{ id: '42' }]);
    } finally {
      rmSync(bootstrapHome, { recursive: true, force: true });
    }
    const fanoutHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-fanout-recovery-'));
    try {
      const fanoutOutputPath = path.join(fanoutHome, 'fanout.ndjson');
      const fanout = await new ScrapeRunServiceV1(new RunStoreV1(fanoutHome), {
        call: async () => ({
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: '42' } },
          retry_after_ms: null,
          attempts: 1,
        }),
      }).start({
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
        },
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
        input: { id: '42' },
        caller_bounds: {},
        output: { kind: 'file', requested_path: fanoutOutputPath, format: 'ndjson' },
      });
      const fanoutStore = new RunStoreV1(fanoutHome);
      const fanoutFrames = recoverJournalFile(
        fanoutStore.journalPath(fanout.run_id),
        fanout.run_id,
      ).frames;
      const childEnqueued = fanoutFrames.find(
        (frame) => frame.body.event.kind === 'node_enqueued',
      );
      assert.ok(childEnqueued);
      unlinkSync(fanoutOutputPath);
      writeFileSync(
        fanoutStore.journalPath(fanout.run_id),
        readFileSync(fanoutStore.journalPath(fanout.run_id)).subarray(0, childEnqueued.end_offset),
      );
      assert.deepEqual(interruptUnfinishedRunsAtStartup(fanoutHome), [
        { run_id: fanout.run_id, kind: 'interrupted' },
      ]);
      const resumedFanout = await new ScrapeRunServiceV1(fanoutStore, {
        call: async () => ({
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: '42' } },
          retry_after_ms: null,
          attempts: 1,
        }),
      }).resume({
        run_id: fanout.run_id,
        artifact: fanoutStore.read(fanout.run_id).payload.artifact,
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
      });
      assert.equal(resumedFanout.kind, 'scrape_outcome');
      assert.equal(
        recoverJournalFile(fanoutStore.journalPath(fanout.run_id), fanout.run_id).frames.filter(
          (frame) => frame.body.event.kind === 'node_enqueued',
        ).length,
        1,
      );
      assert.deepEqual(readCommittedRunItems(fanoutStore, fanout.run_id), [{ id: '42' }]);
    } finally {
      rmSync(fanoutHome, { recursive: true, force: true });
    }
    const boundedInputs = [];
    const bounded = await new ScrapeRunServiceV1(new RunStoreV1(runHome), {
      call: async (_capability, runInput) => {
        boundedInputs.push(runInput);
        return {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: '42' }, next: `cursor-${boundedInputs.length + 1}` },
          retry_after_ms: null,
          attempts: 1,
        };
      },
    }).start({
      artifact: {
        package_id: 'ikea',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_product',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner: parsed.capabilities.get_product,
      capabilities: parsed.capabilities,
      input: { id: '42' },
      caller_bounds: {},
      output: {
        kind: 'file',
        requested_path: path.join(runHome, 'bounded-output.ndjson'),
        format: 'ndjson',
      },
    });
    assert.equal(bounded.kind, 'scrape_partial');
    assert.equal(bounded.stop, 'run_budget_exhausted');
    assert.equal(bounded.summary.tasks_completed, 2);
    assert.deepEqual(boundedInputs, [{ id: '42' }, { id: '42', cursor: 'cursor-2' }]);
    const allRunIds = runService.listPage({ limit: 100 }).items.map((entry) => entry.run_id);
    const firstRunPage = runService.listPage({ limit: 1 });
    assert.deepEqual(
      firstRunPage.items.map((entry) => entry.run_id),
      allRunIds.slice(0, 1),
    );
    assert.ok(firstRunPage.next_cursor);
    const secondRunPage = runService.listPage({
      cursor: firstRunPage.next_cursor ?? undefined,
      limit: 1,
    });
    assert.deepEqual(
      secondRunPage.items.map((entry) => entry.run_id),
      allRunIds.slice(1, 2),
    );
    assert.equal(secondRunPage.next_cursor, null);
    assert.throws(
      () => runService.listPage({ cursor: 'not/a/cursor' }),
      (error) => error?.code === 'cursor_invalid',
    );
    assert.throws(
      () => runService.listPage({ limit: 101 }),
      (error) => error?.code === 'invalid_options',
    );
    writeFileSync(new RunStoreV1(runHome).journalPath(bounded.run_id), Buffer.alloc(0));
    const listedWithCorruptRun = runService.listPage({ limit: 100 }).items;
    assert.equal(listedWithCorruptRun.length, 2);
    assert.deepEqual(
      listedWithCorruptRun.find((entry) => entry.run_id === bounded.run_id),
      {
        kind: 'quarantined_run',
        run_id: bounded.run_id,
        created_at: new RunStoreV1(runHome).read(bounded.run_id).payload.created_at,
        code: 'journal_corrupt',
      },
    );
    assert.equal(
      listedWithCorruptRun.find((entry) => entry.run_id === run.run_id)?.committed_item_count,
      1,
    );
    assert.deepEqual(runService.discard(bounded.run_id), {
      kind: 'discarded',
      run_id: bounded.run_id,
    });
    assert.deepEqual(
      runService.listPage({ limit: 100 }).items.map((entry) => entry.run_id),
      [run.run_id],
    );
    const budgetValue = JSON.parse(JSON.stringify(value));
    budgetValue.capabilities.get_product.collection.run_policy.max_output_bytes = 1;
    budgetValue.manifest_digest = calculatePublicToolPackageManifestDigest(budgetValue);
    const budgetPackage = parsePublicToolPackage(budgetValue);
    const budgetHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-budget-'));
    try {
      const budgeted = await new ScrapeRunServiceV1(new RunStoreV1(budgetHome), {
        call: async () => ({
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: '42' } },
          retry_after_ms: null,
          attempts: 1,
        }),
      }).start({
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
        },
        owner: budgetPackage.capabilities.get_product,
        capabilities: budgetPackage.capabilities,
        input: { id: '42' },
        caller_bounds: {},
        output: {
          kind: 'file',
          requested_path: path.join(budgetHome, 'budget-output.ndjson'),
          format: 'ndjson',
        },
      });
      assert.equal(budgeted.kind, 'scrape_failure');
      assert.equal(budgeted.stop, 'run_budget_exhausted');
      assert.deepEqual(readCommittedRunItems(new RunStoreV1(budgetHome), budgeted.run_id), []);
    } finally {
      rmSync(budgetHome, { recursive: true, force: true });
    }
    // The parser refuses a frame budget below what the declared ceilings need,
    // so the runtime's own reserve check is exercised on the parsed policy.
    const journalPackage = parsePublicToolPackage(JSON.parse(JSON.stringify(value)));
    journalPackage.capabilities.get_product.collection.run_policy.durable.max_journal_frames = 6;
    const journalHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-journal-budget-'));
    try {
      let dispatched = false;
      const journalBound = await new ScrapeRunServiceV1(new RunStoreV1(journalHome), {
        call: async () => {
          dispatched = true;
          throw new Error('journal reserve should stop before target dispatch');
        },
      }).start({
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
        },
        owner: journalPackage.capabilities.get_product,
        capabilities: journalPackage.capabilities,
        input: { id: '42' },
        caller_bounds: {},
        output: {
          kind: 'file',
          requested_path: path.join(journalHome, 'journal-output.ndjson'),
          format: 'ndjson',
        },
      });
      assert.equal(journalBound.kind, 'scrape_failure');
      assert.equal(journalBound.stop, 'run_budget_exhausted');
      assert.equal(dispatched, false);
    } finally {
      rmSync(journalHome, { recursive: true, force: true });
    }
    const cancelledHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-cancelled-'));
    try {
      const controller = new AbortController();
      controller.abort();
      let dispatched = false;
      const cancelled = await new ScrapeRunServiceV1(new RunStoreV1(cancelledHome), {
        call: async () => {
          dispatched = true;
          throw new Error('cancelled run must not dispatch target traffic');
        },
      }).start({
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
        },
        owner: parsed.capabilities.get_product,
        capabilities: parsed.capabilities,
        input: { id: '42' },
        caller_bounds: {},
        output: {
          kind: 'file',
          requested_path: path.join(cancelledHome, 'cancelled-output.ndjson'),
          format: 'ndjson',
        },
        signal: controller.signal,
      });
      assert.equal(cancelled.kind, 'scrape_failure');
      assert.equal(cancelled.stop, 'cancelled');
      assert.equal(dispatched, false);
      assert.equal(
        inspectStoredRun(new RunStoreV1(cancelledHome), cancelled.run_id).lifecycle.stop,
        'cancelled',
      );
      const cancelledFrames = recoverJournalFile(
        new RunStoreV1(cancelledHome).journalPath(cancelled.run_id),
        cancelled.run_id,
      ).frames;
      assert.deepEqual(cancelledFrames.at(-2)?.body.event, {
        kind: 'cancel_requested',
        source: 'sdk_cancel',
      });
    } finally {
      rmSync(cancelledHome, { recursive: true, force: true });
    }
    const deadlineValue = JSON.parse(JSON.stringify(value));
    deadlineValue.capabilities.get_product.collection.run_policy.total_timeout_ms = 1_000;
    deadlineValue.manifest_digest = calculatePublicToolPackageManifestDigest(deadlineValue);
    const deadlinePackage = parsePublicToolPackage(deadlineValue);
    const deadlineHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-deadline-'));
    try {
      let aborted = false;
      const deadline = await new ScrapeRunServiceV1(new RunStoreV1(deadlineHome), {
        call: async (_capability, _input, options) =>
          new Promise((resolve) => {
            options.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve({ kind: 'failure', code: 'cancelled', attempts: 1 });
              },
              { once: true },
            );
          }),
      }).start({
        artifact: {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
        },
        owner: deadlinePackage.capabilities.get_product,
        capabilities: deadlinePackage.capabilities,
        input: { id: '42' },
        caller_bounds: {},
        output: {
          kind: 'file',
          requested_path: path.join(deadlineHome, 'deadline-output.ndjson'),
          format: 'ndjson',
        },
      });
      assert.equal(deadline.kind, 'scrape_failure');
      assert.equal(deadline.stop, 'deadline_exhausted');
      assert.equal(aborted, true);
      assert.equal(
        inspectStoredRun(new RunStoreV1(deadlineHome), deadline.run_id).lifecycle.stop,
        'deadline_exhausted',
      );
    } finally {
      rmSync(deadlineHome, { recursive: true, force: true });
    }
    const waitHome = mkdtempSync(path.join(os.tmpdir(), 'klura-run-wait-'));
    try {
      const pendingRunId = createRunId();
      const pendingStore = new RunStoreV1(waitHome);
      const pendingMeta = pendingStore.create({
        ...storedRunMeta,
        run_id: pendingRunId,
        created_at: '2026-07-28T10:00:00Z',
      });
      const createdFrame = appendJournalFrame(
        pendingStore.journalPath(pendingRunId),
        {
          frame_schema_version: 1,
          run_id: pendingRunId,
          sequence: 1,
          execution_epoch: 0,
          previous_frame_digest: null,
          event: { kind: 'run_created', meta_digest: pendingMeta.meta_digest },
        },
        1_000_000,
      );
      const pendingRunService = new ConsumerRunServiceV1(new PackageStoreV1(waitHome));
      const stateWait = pendingRunService.waitState(pendingRunId, {
        after_state_version: 1,
        wait_timeout_ms: 500,
      });
      await new Promise((resolve) => setImmediate(resolve));
      appendJournalFrame(
        pendingStore.journalPath(pendingRunId),
        {
          frame_schema_version: 1,
          run_id: pendingRunId,
          sequence: 2,
          execution_epoch: 0,
          previous_frame_digest: createdFrame.digest,
          event: { kind: 'state_changed', state: { kind: 'queued' } },
        },
        1_000_000,
      );
      const changedState = await stateWait;
      assert.equal(changedState.changed, true);
      assert.equal(changedState.snapshot.state_version, 2);
      assert.deepEqual(
        await pendingRunService.waitState(pendingRunId, {
          after_state_version: 2,
          wait_timeout_ms: 0,
        }),
        {
          changed: false,
          snapshot: changedState.snapshot,
        },
      );
    } finally {
      rmSync(waitHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(runHome, { recursive: true, force: true });
  }
  value.capabilities.get_product.collection.task_kinds[0].page_outcome_ids = ['unknown'];
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(() => parsePublicToolPackage(value), /success outcomes/);
});

test('semantic cutoffs retain only a verified ordered prefix and stop before another page', async () => {
  const parsed = parsePublicToolPackage(semanticCutoffPackageValue());
  const owner = parsed.capabilities.get_product;
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-semantic-cutoff-'));
  try {
    const inputs = [];
    const completed = await new ScrapeRunServiceV1(new RunStoreV1(home), {
      call: async (_capability, input) => {
        inputs.push(input);
        return {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: {
            items: [
              { id: 'newer', published_at: '2026-07-03' },
              { id: 'cutoff', published_at: '2026-07-02' },
              { id: 'older', published_at: '2026-07-01' },
            ],
            next: 'must-not-run',
          },
          retry_after_ms: null,
          attempts: 1,
        };
      },
    }).start({
      artifact: {
        package_id: 'ikea',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_product',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner,
      capabilities: parsed.capabilities,
      input: { id: '42', since: '2026-07-02' },
      caller_bounds: {},
    });
    assert.deepEqual(completed, {
      kind: 'scrape_outcome',
      run_id: completed.run_id,
      stop: { kind: 'date_cutoff_reached', semantic_stop_id: 'published_since' },
      summary: {
        items_emitted: 2,
        items_duplicate: 0,
        tasks_completed: 1,
        tasks_failed: 0,
        target_requests: 1,
      },
    });
    assert.deepEqual(inputs, [{ id: '42' }]);
    assert.deepEqual(readCommittedRunItems(new RunStoreV1(home), completed.run_id), [
      { id: 'newer', published_at: '2026-07-03' },
      { id: 'cutoff', published_at: '2026-07-02' },
    ]);
    assert.deepEqual(inspectStoredRun(new RunStoreV1(home), completed.run_id).lifecycle, {
      kind: 'terminal',
      result_kind: 'scrape_outcome',
      stop: { kind: 'date_cutoff_reached', semantic_stop_id: 'published_since' },
      sequence: 10,
    });

    const invalid = await new ScrapeRunServiceV1(new RunStoreV1(home), {
      call: async () => ({
        kind: 'outcome',
        outcome_id: 'success',
        outcome_class: 'success',
        case_id: 'success_case',
        data: {
          items: [
            { id: 'first', published_at: '2026-07-03' },
            { id: 'out_of_order', published_at: '2026-07-04' },
          ],
        },
        retry_after_ms: null,
        attempts: 1,
      }),
    }).start({
      artifact: {
        package_id: 'ikea',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_product',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      },
      owner,
      capabilities: parsed.capabilities,
      input: { id: '42', since: '2026-07-02' },
      caller_bounds: {},
    });
    assert.deepEqual(invalid, {
      kind: 'scrape_partial',
      run_id: invalid.run_id,
      stop: 'item_invalid',
      summary: {
        items_emitted: 1,
        items_duplicate: 0,
        tasks_completed: 1,
        tasks_failed: 0,
        target_requests: 1,
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('inline runs require a compiler proof and fit the active adapter before run creation', () => {
  const parsed = parsePublicToolPackage(semanticCutoffPackageValue());
  const collection = parsed.capabilities.get_product.collection;
  assert.ok(collection);
  assert.doesNotThrow(() =>
    preflightInlineRunOutput(
      { kind: 'inline' },
      collection,
      collection.run_policy.max_items,
    ),
  );
  assert.throws(
    () => preflightInlineRunOutput({ kind: 'inline' }, collection, 101),
    (error) => error instanceof RunOutputError && error.code === 'output_sink_required',
  );
  assert.throws(
    () => preflightInlineRunOutput({ kind: 'inline' }, collection, 1, 1),
    (error) => error instanceof RunOutputError && error.code === 'output_sink_required',
  );
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-inline-preflight-'));
  try {
    const store = new RunStoreV1(home);
    let calls = 0;
    assert.throws(
      () =>
        new ScrapeRunServiceV1(store, {
          call: async () => {
            calls += 1;
            throw new Error('must not call target');
          },
        }).startDetached({
          artifact: {
            package_id: 'ikea',
            version: '1.0.0',
            package_digest: 'a'.repeat(64),
            capability: 'get_product',
            runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
          },
          owner: parsed.capabilities.get_product,
          capabilities: parsed.capabilities,
          input: { id: '42', since: '2026-07-02' },
          caller_bounds: {},
          inline_output_max_bytes: 1,
        }),
      (error) => error instanceof RunOutputError && error.code === 'output_sink_required',
    );
    assert.equal(calls, 0);
    assert.deepEqual(store.listRunIds(), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('public node HTTP execution blocks every non-global DNS answer before dispatch', async () => {
  const parsed = parsePublicToolPackage(publicPackageValue());
  const capability = parsed.capabilities.get_product;
  const strategy = capability.strategies[0];
  const blockedAddresses = [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::c000:201',
    '100::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ];
  for (const address of blockedAddresses) {
    await assert.rejects(
      () =>
        executeNodeHttpStrategy(capability, strategy, {
          input: { id: '42' },
          bindings: {},
          timeout_ms: 5_000,
          max_target_requests: 1,
          scheduler: new OriginSchedulerV1(),
          resolve_host: async () => [address],
        }),
      (error) => error instanceof PublicHttpExecutionError && error.code === 'request_blocked',
      address,
    );
  }
});

test('public node HTTP execution applies its deadline while DNS is pending', async () => {
  const capability = parsePublicToolPackage(publicPackageValue()).capabilities.get_product;
  const strategy = capability.strategies[0];
  await assert.rejects(
    () =>
      executeNodeHttpStrategy(capability, strategy, {
        input: { id: '42' },
        bindings: {},
        timeout_ms: 20,
        max_target_requests: 1,
        scheduler: new OriginSchedulerV1(),
        resolve_host: async () => new Promise(() => undefined),
      }),
    (error) =>
      error instanceof PublicHttpExecutionError &&
      error.code === 'request_timeout' &&
      error.target_requests === 0,
  );
});

test('origin scheduler serializes admissions and opens a structural circuit after transient failures', async () => {
  const basePolicy =
    parsePublicToolPackage(publicPackageValue()).capabilities.get_product
      .origin_traffic_policies[0];
  const policy = {
    ...basePolicy,
    circuit_breaker: { ...basePolicy.circuit_breaker, transient_failure_threshold: 1 },
  };
  const scheduler = new OriginSchedulerV1();
  const first = await scheduler.acquire(policy);
  let secondAdmitted = false;
  const second = scheduler.acquire(policy).then((permit) => {
    secondAdmitted = true;
    return permit;
  });
  await Promise.resolve();
  assert.equal(secondAdmitted, false);
  assert.deepEqual(scheduler.snapshot(), {
    scheduler_snapshot_schema_version: 1,
    origins: [
      {
        origin: 'https://api.example.test',
        active_requests: 1,
        queued_requests: 1,
        queued_workloads: 1,
        blocker: 'concurrency',
        next_admission_at_ms: null,
        circuit_open_until_ms: null,
      },
    ],
  });
  first.release('success');
  const secondPermit = await second;
  secondPermit.release('transient_failure');
  const circuit = scheduler.snapshot();
  assert.equal(circuit.origins[0]?.blocker, 'circuit_open');
  assert.equal(circuit.origins[0]?.active_requests, 0);
  assert.equal(circuit.origins[0]?.queued_requests, 0);
  assert.equal(typeof circuit.origins[0]?.circuit_open_until_ms, 'number');
  await assert.rejects(
    () => scheduler.acquire(policy),
    (error) => error.code === 'origin_circuit_open',
  );
});

test('origin scheduler keeps FIFO order within one workload and round-robins concurrent workloads', async () => {
  const basePolicy =
    parsePublicToolPackage(publicPackageValue()).capabilities.get_product
      .origin_traffic_policies[0];
  const policy = { ...basePolicy, max_concurrency: 1, min_delay_ms: 0, burst: 4 };
  const scheduler = new OriginSchedulerV1();
  const held = await scheduler.acquire(policy, { workload_id: 'seed' });
  const admitted = [];
  const queue = (workloadId, label) =>
    scheduler.acquire(policy, { workload_id: workloadId }).then((permit) => {
      admitted.push(label);
      return permit;
    });
  const firstA = queue('run-a', 'a1');
  const secondA = queue('run-a', 'a2');
  const firstB = queue('run-b', 'b1');
  held.release('success');
  const permits = [];
  permits.push(await firstA);
  permits.at(-1).release('success');
  permits.push(await firstB);
  permits.at(-1).release('success');
  permits.push(await secondA);
  permits.at(-1).release('success');
  assert.deepEqual(admitted, ['a1', 'b1', 'a2']);
});

test('origin scheduler retains a circuit cooldown across a local daemon restart', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-scheduler-state-'));
  try {
    const statePath = path.join(home, 'scheduler-state.json');
    const basePolicy =
      parsePublicToolPackage(publicPackageValue()).capabilities.get_product
        .origin_traffic_policies[0];
    const policy = {
      ...basePolicy,
      circuit_breaker: {
        ...basePolicy.circuit_breaker,
        transient_failure_threshold: 1,
        cooldown_ms: 1_000,
      },
    };
    let now = 1_000_000;
    const scheduler = new OriginSchedulerV1({ state_path: statePath, now: () => now });
    const permit = await scheduler.acquire(policy, { workload_id: 'run-a' });
    permit.release('transient_failure');
    assert.equal(existsSync(statePath), true);
    const restarted = new OriginSchedulerV1({ state_path: statePath, now: () => now });
    await assert.rejects(
      () => restarted.acquire(policy, { workload_id: 'run-b' }),
      (error) => error instanceof Error && error.code === 'origin_circuit_open',
    );
    now += 1_000;
    const recovered = await restarted.acquire(policy, { workload_id: 'run-b' });
    recovered.release('success');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('origin scheduler retains transient failure counts across a local daemon restart', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-scheduler-state-'));
  try {
    const statePath = path.join(home, 'scheduler-state.json');
    const basePolicy =
      parsePublicToolPackage(publicPackageValue()).capabilities.get_product
        .origin_traffic_policies[0];
    const policy = {
      ...basePolicy,
      circuit_breaker: {
        ...basePolicy.circuit_breaker,
        transient_failure_threshold: 2,
        cooldown_ms: 1_000,
      },
    };
    let now = 1_000_000;
    const scheduler = new OriginSchedulerV1({ state_path: statePath, now: () => now });
    const first = await scheduler.acquire(policy, { workload_id: 'run-a' });
    first.release('transient_failure');
    const restarted = new OriginSchedulerV1({ state_path: statePath, now: () => now });
    const second = await restarted.acquire(policy, { workload_id: 'run-b' });
    second.release('transient_failure');
    const afterCircuitOpens = new OriginSchedulerV1({ state_path: statePath, now: () => now });
    await assert.rejects(
      () => afterCircuitOpens.acquire(policy, { workload_id: 'run-c' }),
      (error) => error instanceof Error && error.code === 'origin_circuit_open',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('public caller retries only a declared transient failure and returns the structurally verified outcome', async () => {
  const capability = parsePublicToolPackage(publicPackageValue()).capabilities.get_product;
  capability.call_retry_policy = {
    ...capability.call_retry_policy,
    max_retries: 1,
    on: ['transport_failure'],
  };
  capability.max_target_requests_per_call = 2;
  let invocations = 0;
  const caller = new PublicCallerV1(async () => {
    invocations += 1;
    if (invocations === 1) throw new PublicHttpExecutionError('transport_failure', 'offline');
    return {
      status: 200,
      headers: {},
      media_type: 'application/json',
      body_kind: 'json_object',
      body: { ok: true, item: { id: '42' } },
      target_requests: 1,
    };
  });
  const result = await caller.call(capability, { id: '42' });
  assert.equal(result.kind, 'outcome');
  assert.equal(result.outcome_class, 'success');
  assert.equal(result.attempts, 2);
});

test('public caller gives each executor only the remaining target-request budget', async () => {
  const capability = parsePublicToolPackage(publicPackageValue()).capabilities.get_product;
  capability.max_target_requests_per_call = 2;
  const budgets = [];
  const caller = new PublicCallerV1(async (_capability, _strategy, options) => {
    budgets.push(options.max_target_requests);
    if (budgets.length === 1) {
      throw new PublicHttpExecutionError('transport_failure', 'offline', 1);
    }
    return {
      status: 200,
      headers: {},
      media_type: 'application/json',
      body_kind: 'json_object',
      body: { ok: true, item: { id: '42' } },
      target_requests: 1,
    };
  });
  capability.call_retry_policy = {
    ...capability.call_retry_policy,
    max_retries: 1,
    on: ['transport_failure'],
  };
  const result = await caller.call(capability, { id: '42' });
  assert.equal(result.kind, 'outcome');
  assert.deepEqual(budgets, [2, 1]);
  assert.equal(result.attempts, 2);
});

test('local session storage encrypts immutable generations and protects a run lease', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-session-store-'));
  const store = new SessionStoreV1(home);
  const selector = {
    package_id: 'ikea',
    authentication_contract_id: 'account',
    session_name: 'default',
  };
  try {
    const first = store.commit({
      ...selector,
      authentication_contract_digest: 'a'.repeat(64),
      state: { cookies: [{ name: 'session', value: 'secret-cookie-value' }] },
    });
    assert.equal(first.generation, 1);
    assert.equal(first.lease, null);
    assert.deepEqual(store.read(selector), {
      pointer: first,
      state: { cookies: [{ name: 'session', value: 'secret-cookie-value' }] },
    });
    const generation = readFileSync(
      path.join(home, 'sessions', 'ikea', 'account', 'default', 'generation-1.json'),
      'utf8',
    );
    assert.equal(generation.includes('secret-cookie-value'), false);

    const second = store.commit({
      ...selector,
      authentication_contract_digest: 'a'.repeat(64),
      state: { cookies: [{ name: 'session', value: 'rotated-cookie-value' }] },
    });
    assert.equal(second.generation, 2);
    assert.equal(
      existsSync(path.join(home, 'sessions', 'ikea', 'account', 'default', 'generation-1.json')),
      true,
    );
    assert.deepEqual(store.listAuthenticationContractIds('ikea', 'default'), ['account']);

    const tamperedSelector = { ...selector, session_name: 'tampered' };
    store.commit({
      ...tamperedSelector,
      authentication_contract_digest: 'a'.repeat(64),
      state: { cookies: [{ name: 'session', value: 'tampered-cookie-value' }] },
    });
    writeFileSync(
      path.join(home, 'sessions', 'ikea', 'account', 'tampered', 'generation-1.json'),
      '{}',
      { mode: 0o600 },
    );
    assert.throws(
      () => store.read(tamperedSelector),
      (error) => error instanceof SessionStoreError && error.code === 'local_state_invalid',
    );
    assert.throws(
      () => store.clear(tamperedSelector),
      (error) => error instanceof SessionStoreError && error.code === 'local_state_invalid',
    );

    const leased = store.claimRunLease(selector, 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(leased.lease, {
      owner_kind: 'run',
      owner_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      base_generation: 2,
    });
    assert.throws(
      () =>
        store.commit({
          ...selector,
          authentication_contract_digest: 'a'.repeat(64),
          state: { cookies: [] },
        }),
      (error) => error instanceof SessionStoreError && error.code === 'session_in_use',
    );
    assert.throws(
      () => store.clear(selector),
      (error) => error instanceof SessionStoreError && error.code === 'session_in_use',
    );
    store.releaseRunLease(selector, 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    store.claimRunLease(selector, 'run_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const reclaimed = store.claimRunLease(
      selector,
      'run_v1_cccccccccccccccccccccccccccccccc',
    );
    assert.deepEqual(reclaimed.lease, {
      owner_kind: 'run',
      owner_id: 'run_v1_cccccccccccccccccccccccccccccccc',
      base_generation: 2,
    });
    store.releaseRunLease(selector, 'run_v1_cccccccccccccccccccccccccccccccc');
    assert.equal(store.clear(selector), true);
    assert.equal(store.clear(selector), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer scrape runs pin one encrypted session generation until their terminal result', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-session-run-'));
  try {
    const value = authenticatedCollectionPackageValue();
    const bytes = Buffer.from(canonicalJson(value), 'utf8');
    const packageDigest = sha256Digest(bytes);
    const store = new PackageStoreV1(home);
    store.putVerifiedPackage({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      package_bytes: bytes.byteLength,
      bytes,
    });
    store.activate({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      provenance: { kind: 'registry', source_index_digest: 'c'.repeat(64) },
      runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      installed_at: '2026-07-27T12:00:00Z',
    });
    const parsed = parsePublicToolPackage(value);
    const sessionStore = new SessionStoreV1(home);
    const sessionState = { cookies: [{ name: 'session', value: 'private-run-cookie' }] };
    const pointer = sessionStore.commit({
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      authentication_contract_digest: calculateAuthenticationContractDigest(
        parsed.authentication_contracts.account,
      ),
      state: sessionState,
    });
    let releaseCall;
    let observeCall;
    const callObserved = new Promise((resolve) => {
      observeCall = resolve;
    });
    const storageStates = [];
    const service = new ConsumerScrapeRunServiceV1(store, '0.6.2', {
      call: async (_capability, _input, options) => {
        storageStates.push(options.browser_storage_state);
        observeCall();
        await new Promise((resolve) => {
          releaseCall = resolve;
        });
        return {
          kind: 'outcome',
          outcome_id: 'success',
          outcome_class: 'success',
          case_id: 'success_case',
          data: { item: { id: 'desk' } },
          retry_after_ms: null,
          attempts: 1,
        };
      },
    });
    assert.throws(
      () =>
        service.startDetached({
          package_id: 'ikea',
          capability: 'get_product',
          input: { id: 'desk' },
          caller_bounds: {},
        }),
      (error) => error?.code === 'session_required',
    );
    const started = service.startDetached({
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: 'desk' },
      caller_bounds: {},
      session_name: 'default',
      output: {
        kind: 'file',
        requested_path: path.join(home, 'session-run.ndjson'),
        format: 'ndjson',
      },
    });
    await callObserved;
    assert.deepEqual(storageStates, [sessionState]);
    assert.deepEqual(
      sessionStore.getPointer({
        package_id: 'ikea',
        authentication_contract_id: 'account',
        session_name: 'default',
      })?.lease,
      { owner_kind: 'run', owner_id: started.run_id, base_generation: pointer.generation },
    );
    const metaPath = path.join(home, 'runs', started.run_id, 'meta.json');
    const meta = new RunStoreV1(home).read(started.run_id).payload;
    assert.deepEqual(meta.session, {
      authentication_contract_id: 'account',
      session_name: 'default',
      generation: pointer.generation,
      state_digest: pointer.state_digest,
      authentication_contract_digest: pointer.authentication_contract_digest,
    });
    assert.equal(readFileSync(metaPath, 'utf8').includes('private-run-cookie'), false);
    releaseCall();
    const result = await started.completion;
    assert.equal(result.result.kind, 'scrape_outcome');
    assert.equal(
      sessionStore.getPointer({
        package_id: 'ikea',
        authentication_contract_id: 'account',
        session_name: 'default',
      })?.lease,
      null,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('package store preserves verified bytes and makes installed state an active pointer only', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-store-'));
  try {
    const value = publicPackageValue();
    value.capabilities.search_repositories_page = JSON.parse(
      JSON.stringify(value.capabilities.get_product),
    );
    value.capabilities.search_repositories_page.visibility = 'internal';
    value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
    const bytes = Buffer.from(canonicalJson(value), 'utf8');
    const packageDigest = sha256Digest(bytes);
    const installed = {
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      provenance: { kind: 'registry', source_index_digest: 'c'.repeat(64) },
      runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      installed_at: '2026-07-27T12:00:00Z',
    };
    const store = new PackageStoreV1(home);
    const artifactPath = store.putVerifiedPackage({
      ...installed,
      package_bytes: bytes.byteLength,
      bytes,
    });
    assert.equal(store.readArtifact(packageDigest).toString('utf8'), bytes.toString('utf8'));
    assert.equal(store.activate(installed).packages.ikea.package_digest, packageDigest);

    const reloaded = new PackageStoreV1(home);
    assert.equal(reloaded.getInstalled('ikea').version, '1.0.0');
    assert.ok(artifactPath.endsWith(`${packageDigest}${path.sep}package.json`));
    assert.equal(reloaded.remove('ikea').removed, true);
    assert.equal(reloaded.getInstalled('ikea'), null);
    assert.equal(reloaded.readArtifact(packageDigest).toString('utf8'), bytes.toString('utf8'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('package store serializes installed-pointer changes through a fail-closed activation lock', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-store-'));
  try {
    const { value, bytes } = publicPackageBytes();
    const packageDigest = sha256Digest(bytes);
    const store = new PackageStoreV1(home);
    store.putVerifiedPackage({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      package_bytes: bytes.byteLength,
      bytes,
    });
    writeFileSync(path.join(home, 'activation.lock'), 'held', { mode: 0o600 });
    assert.throws(
      () =>
        store.activate({
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: packageDigest,
          manifest_digest: value.manifest_digest,
          provenance: { kind: 'registry', source_index_digest: 'c'.repeat(64) },
          runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
          installed_at: '2026-07-27T12:00:00Z',
        }),
      (error) => error instanceof PublicContractError && error.field === 'activation_lock',
    );
    unlinkSync(path.join(home, 'activation.lock'));
    assert.equal(store.getInstalled('ikea'), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installed resolver rechecks the immutable pointer and signed runtime range before a call', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-store-'));
  try {
    const { value, bytes } = publicPackageBytes();
    const packageDigest = sha256Digest(bytes);
    const store = new PackageStoreV1(home);
    store.putVerifiedPackage({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      package_bytes: bytes.byteLength,
      bytes,
    });
    store.activate({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      provenance: { kind: 'registry', source_index_digest: 'c'.repeat(64) },
      runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      installed_at: '2026-07-27T12:00:00Z',
    });

    const resolved = new InstalledPackageResolverV1(store, '0.6.2').resolveCapability(
      'ikea',
      'get_product',
    );
    assert.equal(resolved.installed.package_digest, packageDigest);
    assert.equal(resolved.capability.description, 'Get one product.');
    assert.throws(
      () =>
        new InstalledPackageResolverV1(store, '0.6.2').resolveCapability(
          'ikea',
          'search_repositories_page',
        ),
      (error) => error instanceof InstalledPackageError && error.code === 'capability_not_found',
    );
    assert.throws(
      () => new InstalledPackageResolverV1(store, '1.0.0').resolveCapability('ikea', 'get_product'),
      (error) => error instanceof InstalledPackageError && error.code === 'runtime_incompatible',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer daemon routes validate their closed inputs and preserve request cancellation', async (t) => {
  const calls = [];
  const clearSessions = [];
  const detachedInputs = [];
  let completeDetached;
  let detachedCancelled = false;
  let detachedCancelSource;
  let completeResume;
  let resumeSignal;
  const operationHome = mkdtempSync(path.join(os.tmpdir(), 'klura-route-operations-'));
  t.after(() => rmSync(operationHome, { recursive: true, force: true }));
  const routes = new ConsumerDaemonRoutesV1({
    call: async (input) => {
      calls.push(input);
      return {
        package_id: 'ikea',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_product',
        result: { kind: 'failure', code: 'cancelled', attempts: 0 },
      };
    },
    clearSession: (input) => {
      clearSessions.push(input);
      return {
        kind: 'session_not_found',
        package_id: 'ikea',
        authentication_contract_id: 'account',
        session_name: 'default',
      };
    },
    openLogin: async () => ({
      kind: 'login_opened',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      interaction_id: 'login_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    completeLogin: async () => ({
      kind: 'login_completed',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      generation: 1,
      state_digest: 'b'.repeat(64),
    }),
    start: async () => {
      throw new Error('not used');
    },
    startDetached: (input) => {
      if (input.session_name === 'missing') {
        throw new ConsumerRunSessionError('session_required', 'test session is missing');
      }
      detachedInputs.push(input);
      return {
        package_id: 'ikea',
        version: '1.0.0',
        package_digest: 'a'.repeat(64),
        capability: 'get_product',
        run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        completion: new Promise((resolve) => {
          completeDetached = resolve;
        }),
        cancel: (source) => {
          detachedCancelled = true;
          detachedCancelSource = source;
          return true;
        },
      };
    },
    resume: async (input) => {
      resumeSignal = input.signal;
      return new Promise((resolve) => {
        completeResume = resolve;
      });
    },
  }, undefined, undefined, undefined, null, undefined, new RunOperationStoreV1(operationHome));
  const controller = new AbortController();
  const result = await routes.invoke(
    'POST',
    '/consumer/call',
    {
        package_id: 'ikea',
        capability: 'get_product',
        input: { id: '42' },
        session_name: 'default',
        timeout_ms: 5_000,
    },
    controller.signal,
  );
  assert.equal(result.package_id, 'ikea');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout_ms, 5_000);
  assert.equal(calls[0].options.session_name, 'default');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/session/clear', {
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    }),
    {
      kind: 'session_not_found',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    },
  );
  assert.deepEqual(clearSessions, [
    {
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    },
  ]);
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/login/open', {
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    }),
    {
      kind: 'login_opened',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      interaction_id: 'login_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/login/complete', {
      interaction_id: 'login_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    {
      kind: 'login_completed',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      generation: 1,
      state_digest: 'b'.repeat(64),
    },
  );
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/search', {
      query: null,
      cursor: null,
      limit: null,
    }),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'search',
      code: 'registry_unavailable',
      retryable: true,
      package_id: null,
    },
  );
  await assert.rejects(
    () =>
      routes.invoke('POST', '/consumer/search', {
        query: null,
        cursor: null,
        limit: null,
        unexpected: true,
      }),
    (error) => error instanceof PublicContractError && error.field === 'consumer.search.unexpected',
  );
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/run', {
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: '42' },
      caller_bounds: {},
      input_mode_id: null,
      output: null,
      inline_output_max_bytes: 1_048_576,
      session_name: 'missing',
      detach: true,
      operation_id: 'op_v1_11111111111111111111111111111111',
    }),
    { kind: 'consumer_run_session_failure', code: 'session_required' },
  );
  await assert.rejects(
    () =>
      routes.invoke('POST', '/consumer/run', {
        package_id: 'ikea',
        capability: 'get_product',
        input: { id: '42' },
        caller_bounds: {},
        input_mode_id: null,
        output: { kind: 'file', requested_path: 'relative.ndjson', format: 'ndjson' },
        inline_output_max_bytes: 1_048_576,
        session_name: null,
        detach: true,
        operation_id: 'op_v1_22222222222222222222222222222222',
      }),
    /absolute path/,
  );
  assert.equal(detachedInputs.length, 0);
  const detached = await routes.invoke('POST', '/consumer/run', {
    package_id: 'ikea',
    capability: 'get_product',
    input: { id: '42' },
    caller_bounds: {},
    input_mode_id: null,
    output: {
      kind: 'file',
      requested_path: '/private/tmp/klura-route-output.ndjson',
      format: 'ndjson',
    },
    inline_output_max_bytes: 1_048_576,
    session_name: null,
    detach: true,
    operation_id: 'op_v1_33333333333333333333333333333333',
  });
  assert.deepEqual(detachedInputs[0]?.output, {
    kind: 'file',
    requested_path: '/private/tmp/klura-route-output.ndjson',
    format: 'ndjson',
  });
  assert.deepEqual(detached, {
    kind: 'run_accepted',
    operation_id: 'op_v1_33333333333333333333333333333333',
    package_id: 'ikea',
    version: '1.0.0',
    package_digest: 'a'.repeat(64),
    capability: 'get_product',
    run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(routes.activeRunCount(), 1);
  let waitSettled = false;
  const wait = routes
    .invoke('POST', '/consumer/runs/wait', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    .then((value) => {
      waitSettled = true;
      return value;
    });
  await Promise.resolve();
  assert.equal(waitSettled, false);
  assert.equal(detachedCancelled, false);
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/runs/cancel', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      source: 'cli_cancel',
      operation_id: 'op_v1_44444444444444444444444444444444',
    }),
    {
      kind: 'run_cancellation_requested',
      operation_id: 'op_v1_44444444444444444444444444444444',
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.equal(detachedCancelled, true);
  assert.equal(detachedCancelSource, 'cli_cancel');
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/runs/cancel', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      source: 'sdk_cancel',
      operation_id: 'op_v1_55555555555555555555555555555555',
    }),
    {
      kind: 'run_cancellation_requested',
      operation_id: 'op_v1_55555555555555555555555555555555',
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.equal(detachedCancelSource, 'sdk_cancel');
  completeDetached?.({
    package_id: 'ikea',
    version: '1.0.0',
    package_digest: 'a'.repeat(64),
    capability: 'get_product',
    result: {
      kind: 'scrape_outcome',
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      stop: { kind: 'source_exhausted' },
      summary: {
        items_emitted: 0,
        items_duplicate: 0,
        tasks_completed: 0,
        tasks_failed: 0,
        target_requests: 0,
      },
    },
  });
  assert.deepEqual(await wait, {
    package_id: 'ikea',
    version: '1.0.0',
    package_digest: 'a'.repeat(64),
    capability: 'get_product',
    result: {
      kind: 'scrape_outcome',
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      stop: { kind: 'source_exhausted' },
      summary: {
        items_emitted: 0,
        items_duplicate: 0,
        tasks_completed: 0,
        tasks_failed: 0,
        target_requests: 0,
      },
    },
  });
  assert.equal(waitSettled, true);
  assert.equal(routes.activeRunCount(), 0);
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/runs/cancel', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      source: 'cli_cancel',
      operation_id: 'op_v1_66666666666666666666666666666666',
    }),
    {
      kind: 'run_not_active',
      operation_id: 'op_v1_66666666666666666666666666666666',
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/runs/resume', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operation_id: 'op_v1_77777777777777777777777777777777',
    }),
    {
      kind: 'run_resume_accepted',
      operation_id: 'op_v1_77777777777777777777777777777777',
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.equal(routes.activeRunCount(), 1);
  assert.equal(resumeSignal?.aborted, false);
  assert.deepEqual(
    await routes.invoke('POST', '/consumer/runs/cancel', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      source: 'foreground_sigint',
      operation_id: 'op_v1_88888888888888888888888888888888',
    }),
    {
      kind: 'run_cancellation_requested',
      operation_id: 'op_v1_88888888888888888888888888888888',
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.equal(resumeSignal?.aborted, true);
  completeResume?.({
    package_id: 'ikea',
    version: '1.0.0',
    package_digest: 'a'.repeat(64),
    capability: 'get_product',
    result: {
      kind: 'scrape_failure',
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      summary: {
        items_emitted: 0,
        items_duplicate: 0,
        tasks_completed: 0,
        tasks_failed: 0,
        target_requests: 0,
      },
      stop: 'cancelled',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(routes.activeRunCount(), 0);
  const listInputs = [];
  const listRoutes = new ConsumerDaemonRoutesV1(
    {},
    {
      listPage(input) {
        listInputs.push(input);
        if (input.cursor === 'invalid') {
          throw new RunListError('cursor_invalid', 'cursor is not valid');
        }
        return { items: [], next_cursor: null };
      },
    },
    undefined,
    undefined,
    null,
    undefined,
    new RunOperationStoreV1(operationHome),
  );
  assert.deepEqual(
    await listRoutes.invoke('POST', '/consumer/runs/list', { cursor: null, limit: 2 }),
    { items: [], next_cursor: null },
  );
  assert.deepEqual(listInputs, [{ limit: 2 }]);
  assert.deepEqual(
    await listRoutes.invoke('POST', '/consumer/runs/list', { cursor: 'invalid', limit: null }),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'list_runs',
      code: 'cursor_invalid',
      retryable: false,
      package_id: null,
    },
  );
  const runFailureRoutes = new ConsumerDaemonRoutesV1(
    {},
    {
      show() {
        throw new PublicContractError('run_id', 'is not found');
      },
      items() {
        throw new PublicContractError('run.journal', 'is corrupt');
      },
      discard() {
        throw new PublicContractError('run_id', 'is not found');
      },
    },
    undefined,
    undefined,
    null,
    undefined,
    new RunOperationStoreV1(operationHome),
  );
  assert.deepEqual(
    await runFailureRoutes.invoke('POST', '/consumer/runs/show', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'get_run',
      code: 'run_not_found',
      retryable: false,
      package_id: null,
    },
  );
  assert.deepEqual(
    await runFailureRoutes.invoke('POST', '/consumer/runs/items', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      after_sequence: null,
      limit: null,
    }),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'list_run_items',
      code: 'local_state_invalid',
      retryable: false,
      package_id: null,
    },
  );
  assert.deepEqual(
    await runFailureRoutes.invoke('POST', '/consumer/runs/wait', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'wait_run',
      code: 'run_not_found',
      retryable: false,
      package_id: null,
    },
  );
  assert.deepEqual(
    await runFailureRoutes.invoke('POST', '/consumer/runs/discard', {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operation_id: 'op_v1_99999999999999999999999999999999',
    }),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'discard_run',
      code: 'run_not_found',
      retryable: false,
      package_id: null,
    },
  );
  await assert.rejects(
    () =>
      routes.invoke('POST', '/consumer/call', {
        package_id: 'ikea',
        capability: 'get_product',
        input: { id: '42' },
        session_name: null,
        timeout_ms: null,
        unexpected: true,
      }),
    (error) => error instanceof PublicContractError && error.field === 'consumer.call.unexpected',
  );
});

test('consumer SDK keeps selectors structural and routes execution through the local daemon', async () => {
  const requests = [];
  const client = new KluraConsumerClientV1({
    invoke_daemon: async (route, body) => {
      requests.push({ route, body });
      if (route === '/consumer/call') {
        return {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          result: { kind: 'failure', code: 'cancelled', attempts: 0 },
        };
      }
      if (route === '/consumer/session/clear') {
        return {
          kind: 'session_not_found',
          package_id: 'ikea',
          authentication_contract_id: 'account',
          session_name: 'default',
        };
      }
      if (route === '/consumer/login/open') {
        return {
          kind: 'login_opened',
          package_id: 'ikea',
          authentication_contract_id: 'account',
          session_name: 'default',
          interaction_id: 'login_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        };
      }
      if (route === '/consumer/login/complete') {
        return {
          kind: 'login_completed',
          package_id: 'ikea',
          authentication_contract_id: 'account',
          session_name: 'default',
          generation: 1,
          state_digest: 'b'.repeat(64),
        };
      }
      if (route === '/consumer/run') {
        return {
          kind: 'run_accepted',
          operation_id: 'op_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        };
      }
      if (route === '/consumer/runs/cancel') {
        return {
          kind: 'run_cancellation_requested',
          operation_id: 'op_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        };
      }
      if (route === '/consumer/search') {
        return {
          result_schema_version: 1,
          kind: 'consumer_failure',
          operation: 'search',
          code: 'registry_unavailable',
          retryable: true,
          package_id: null,
        };
      }
      if (route === '/consumer/installed') {
        return {
          result_schema_version: 1,
          kind: 'installed_packages',
          items: [],
          next_cursor: null,
        };
      }
      if (route === '/consumer/runs/list') return { items: [], next_cursor: null };
      if (route === '/consumer/runs/show') {
        return runFailure('get_run', 'run_not_found');
      }
      if (route === '/consumer/runs/items') {
        return runFailure('list_run_items', 'local_state_invalid');
      }
      if (route === '/consumer/runs/wait') {
        return runFailure('wait_run', 'run_not_found');
      }
      if (route === '/consumer/runs/wait-state') {
        return {
          changed: false,
          snapshot: {
            run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            meta: {},
            state_version: 7,
            lifecycle: { kind: 'nonterminal', last_sequence: 7 },
            committed_item_count: 0,
          },
        };
      }
      if (route === '/consumer/runs/discard') {
        return runFailure('discard_run', 'run_not_found');
      }
      throw new Error(`unexpected route ${route}`);
    },
  });
  assert.deepEqual(
    await client.call(
      { package_id: 'ikea', capability: 'get_product' },
      { id: '42' },
      { session_name: 'default', timeout_ms: 5_000 },
    ),
    {
      result_schema_version: 1,
      kind: 'call_result',
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: 'a'.repeat(64),
      capability: 'get_product',
      result: { kind: 'failure', code: 'cancelled', attempts: 0 },
    },
  );
  assert.deepEqual(requests[0], {
    route: '/consumer/call',
    body: {
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: '42' },
      session_name: 'default',
      timeout_ms: 5_000,
    },
  });

  assert.deepEqual(await client.search(), {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'search',
    code: 'registry_unavailable',
    retryable: true,
    package_id: null,
  });
  assert.deepEqual(requests[1], {
    route: '/consumer/search',
    body: { query: null, cursor: null, limit: null },
  });
  assert.deepEqual(await client.installed(), {
    result_schema_version: 1,
    kind: 'installed_packages',
    items: [],
    next_cursor: null,
  });
  assert.deepEqual(requests[2], {
    route: '/consumer/installed',
    body: { cursor: null, limit: null },
  });
  assert.deepEqual(await client.listRuns(), {
    result_schema_version: 1,
    kind: 'runs',
    items: [],
    next_cursor: null,
  });
  assert.deepEqual(requests[3], {
    route: '/consumer/runs/list',
    body: { cursor: null, limit: null },
  });

  const started = await client.startRun(
    { package_id: 'ikea', capability: 'get_product' },
    { id: '42' },
    {
      input_mode_id: 'by_product',
      session_name: 'default',
      max_items: 10,
      limits: { product_limit: 2 },
      output: { kind: 'file', path: 'artifacts/ikea.ndjson', format: 'ndjson' },
      operation_id: 'op_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.equal(started.kind, 'run_accepted');
  assert.deepEqual(requests[4], {
    route: '/consumer/run',
    body: {
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: '42' },
      caller_bounds: { max_items: 10, limits: { product_limit: 2 } },
      input_mode_id: 'by_product',
      output: {
        kind: 'file',
        requested_path: path.resolve('artifacts/ikea.ndjson'),
        format: 'ndjson',
      },
      inline_output_max_bytes: 1_048_576,
      session_name: 'default',
      detach: true,
      operation_id: 'op_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  });
  assert.deepEqual(
    await client.cancelRun('run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sdk_cancel', {
      operation_id: 'op_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
    {
    result_schema_version: 1,
    kind: 'run_cancellation_requested',
    operation_id: 'op_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.deepEqual(requests[5], {
    route: '/consumer/runs/cancel',
    body: {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      source: 'sdk_cancel',
      operation_id: 'op_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  });
  assert.deepEqual(await client.getRun('run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'get_run',
    code: 'run_not_found',
    retryable: false,
    package_id: null,
  });
  assert.deepEqual(requests[6], {
    route: '/consumer/runs/show',
    body: { run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  });
  assert.deepEqual(await client.listRunItems('run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'list_run_items',
    code: 'local_state_invalid',
    retryable: false,
    package_id: null,
  });
  assert.deepEqual(requests[7], {
    route: '/consumer/runs/items',
    body: {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      after_sequence: null,
      limit: null,
    },
  });
  assert.deepEqual(
    await client.discardRun('run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      operation_id: 'op_v1_cccccccccccccccccccccccccccccccc',
    }),
    {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'discard_run',
    code: 'run_not_found',
    retryable: false,
    package_id: null,
    },
  );
  assert.deepEqual(requests[8], {
    route: '/consumer/runs/discard',
    body: {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operation_id: 'op_v1_cccccccccccccccccccccccccccccccc',
    },
  });
  assert.deepEqual(await client.waitRun('run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'wait_run',
    code: 'run_not_found',
    retryable: false,
    package_id: null,
  });
  assert.deepEqual(requests[9], {
    route: '/consumer/runs/wait',
    body: { run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  });
  assert.deepEqual(
    await client.listRunItems('run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { limit: 101 }),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'list_run_items',
      code: 'invalid_options',
      retryable: false,
      package_id: null,
    },
  );
  assert.deepEqual(
    await client.clearSession('ikea', {
      authentication_contract_id: 'account',
      session_name: 'default',
    }),
    {
      result_schema_version: 1,
      kind: 'session_not_found',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    },
  );
  assert.deepEqual(requests[10], {
    route: '/consumer/session/clear',
    body: {
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    },
  });
  assert.deepEqual(
    await client.openLogin('ikea', {
      authentication_contract_id: 'account',
      session_name: 'default',
    }),
    {
      result_schema_version: 1,
      kind: 'login_opened',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      interaction_id: 'login_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  );
  assert.deepEqual(requests[11], {
    route: '/consumer/login/open',
    body: {
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    },
  });
  assert.deepEqual(
    await client.completeLogin('login_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    {
      result_schema_version: 1,
      kind: 'login_completed',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      generation: 1,
      state_digest: 'b'.repeat(64),
    },
  );
  assert.deepEqual(requests[12], {
    route: '/consumer/login/complete',
    body: { interaction_id: 'login_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  });
  assert.deepEqual(
    await client.waitRunState('run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      after_state_version: 7,
      wait_timeout_ms: 0,
    }),
    {
      result_schema_version: 1,
      kind: 'run_state',
      changed: false,
      snapshot: {
        run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        meta: {},
        state_version: 7,
        lifecycle: { kind: 'nonterminal', last_sequence: 7 },
        committed_item_count: 0,
      },
    },
  );
  assert.deepEqual(requests[13], {
    route: '/consumer/runs/wait-state',
    body: {
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      after_state_version: 7,
      wait_timeout_ms: 0,
    },
  });
  assert.deepEqual(
    await client.call({ package_id: 'ikea', capability: 'get_product', extra: true }, { id: '42' }),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'call',
      code: 'invalid_options',
      retryable: false,
      package_id: 'ikea',
    },
  );
  assert.deepEqual(
    await client.startRun(
      { package_id: 'ikea', capability: 'get_product' },
      { id: '42' },
      { max_items: 5_000_000 },
    ),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'start_run',
      code: 'invalid_options',
      retryable: false,
      package_id: 'ikea',
    },
  );
  assert.deepEqual(
    await client.startRun(
      { package_id: 'ikea', capability: 'get_product' },
      { id: '42' },
      { limits: { product_limit: 1_000_001 } },
    ),
    {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'start_run',
      code: 'invalid_options',
      retryable: false,
      package_id: 'ikea',
    },
  );
  assert.equal(requests.length, 14);
});

function runFailure(operation, code) {
  return {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation,
    code,
    retryable: false,
    package_id: null,
  };
}

test('consumer call service checks a selected local browser session before an authenticated call', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-authenticated-call-'));
  try {
    const value = authenticatedPackageValue();
    const bytes = Buffer.from(canonicalJson(value), 'utf8');
    const packageDigest = sha256Digest(bytes);
    const store = new PackageStoreV1(home);
    store.putVerifiedPackage({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      package_bytes: bytes.byteLength,
      bytes,
    });
    store.activate({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      provenance: { kind: 'registry', source_index_digest: 'c'.repeat(64) },
      runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      installed_at: '2026-07-27T12:00:00Z',
    });
    const parsed = parsePublicToolPackage(value);
    const sessionStore = new SessionStoreV1(home);
    sessionStore.commit({
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      authentication_contract_digest: calculateAuthenticationContractDigest(
        parsed.authentication_contracts.account,
      ),
      state: { cookies: [{ name: 'session', value: 'opaque-cookie' }] },
    });
    const calls = [];
    const caller = new PublicCallerV1(
      undefined,
      undefined,
      undefined,
      async (_capability, _strategy, options) => {
        calls.push({ input: options.input, storage_state: options.storage_state });
        return {
          status: 200,
          headers: {},
          media_type: 'application/json',
          body_kind: 'json_object',
          body: { ok: true, item: { id: options.input.id } },
          target_requests: 2,
        };
      },
    );
    const service = new ConsumerCallServiceV1(store, '0.6.2', caller);
    const result = await service.call({
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: 'desk' },
      options: { session_name: 'default' },
    });
    assert.equal(result.result.kind, 'outcome');
    assert.deepEqual(calls, [
      {
        input: { id: 'session' },
        storage_state: { cookies: [{ name: 'session', value: 'opaque-cookie' }] },
      },
      {
        input: { id: 'desk' },
        storage_state: { cookies: [{ name: 'session', value: 'opaque-cookie' }] },
      },
    ]);

    sessionStore.commit({
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'stale',
      authentication_contract_digest: 'b'.repeat(64),
      state: { cookies: [{ name: 'session', value: 'stale-cookie' }] },
    });
    const stale = await service.call({
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: 'desk' },
      options: { session_name: 'stale' },
    });
    assert.deepEqual(stale.result, { kind: 'failure', code: 'session_invalid', attempts: 0 });
    assert.equal(calls.length, 2);

    const sessions = new ConsumerSessionServiceV1(store, '0.6.2');
    assert.deepEqual(sessions.clear({ package_id: 'ikea' }), {
      kind: 'session_cleared',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    });
    assert.deepEqual(sessions.clear({ package_id: 'ikea' }), {
      kind: 'session_not_found',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    });
    sessionStore.claimRunLease(
      {
        package_id: 'ikea',
        authentication_contract_id: 'account',
        session_name: 'stale',
      },
      'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    assert.deepEqual(sessions.clear({ package_id: 'ikea', session_name: 'stale' }), {
      kind: 'session_in_use',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'stale',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer login commits browser state only after the declared structural check', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-login-service-'));
  try {
    const value = authenticatedPackageValue();
    const bytes = Buffer.from(canonicalJson(value), 'utf8');
    const packageDigest = sha256Digest(bytes);
    const store = new PackageStoreV1(home);
    store.putVerifiedPackage({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      package_bytes: bytes.byteLength,
      bytes,
    });
    store.activate({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      provenance: { kind: 'registry', source_index_digest: 'c'.repeat(64) },
      runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      installed_at: '2026-07-27T12:00:00Z',
    });
    let closed = 0;
    let checked = 0;
    const state = { cookies: [{ name: 'session', value: 'opaque-cookie' }] };
    const service = new ConsumerLoginServiceV1(store, '0.6.2', {
      open_browser: async () => ({
        page: {},
        assertHealthy: () => undefined,
        completeCheck: async () => {
          checked += 1;
          return {
            result: { kind: 'outcome', outcome_id: 'success', outcome_class: 'success', attempts: 2 },
            state,
          };
        },
        close: async () => {
          closed += 1;
        },
      }),
    });
    const opened = await service.open({ package_id: 'ikea' });
    assert.equal(opened.kind, 'login_opened');
    if (opened.kind !== 'login_opened') throw new Error('login did not open');
    assert.match(opened.interaction_id, /^login_v1_[0-9a-f]{32}$/);
    assert.deepEqual(await service.complete({ interaction_id: opened.interaction_id }), {
      kind: 'login_completed',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
      generation: 1,
      state_digest: sha256Digest(canonicalJson(state)),
    });
    assert.equal(checked, 1);
    assert.equal(closed, 1);
    assert.deepEqual(
      new SessionStoreV1(home).read({
        package_id: 'ikea',
        authentication_contract_id: 'account',
        session_name: 'default',
      }).state,
      { cookies: [{ name: 'session', value: 'opaque-cookie' }] },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer call service binds a result to the installed immutable artifact', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-store-'));
  try {
    const { value, bytes } = publicPackageBytes();
    const packageDigest = sha256Digest(bytes);
    const store = new PackageStoreV1(home);
    store.putVerifiedPackage({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      package_bytes: bytes.byteLength,
      bytes,
    });
    store.activate({
      package_id: 'ikea',
      version: '1.0.0',
      package_digest: packageDigest,
      manifest_digest: value.manifest_digest,
      provenance: { kind: 'registry', source_index_digest: 'c'.repeat(64) },
      runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
      installed_at: '2026-07-27T12:00:00Z',
    });
    const schedulers = [];
    const caller = new PublicCallerV1(async (_capability, _strategy, options) => {
      schedulers.push(options.scheduler);
      return {
        status: 200,
        headers: {},
        media_type: 'application/json',
        body_kind: 'json_object',
        body: { ok: true, item: { id: '42' } },
        target_requests: 1,
      };
    });
    const service = new ConsumerCallServiceV1(store, '0.6.2', caller);
    const result = await service.call({
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: '42' },
    });
    assert.equal(result.package_id, 'ikea');
    assert.equal(result.version, '1.0.0');
    assert.equal(result.package_digest, packageDigest);
    assert.equal(result.capability, 'get_product');
    assert.equal(result.result.kind, 'outcome');
    await new ConsumerCallServiceV1(store, '0.6.2', caller).call({
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: '42' },
    });
    assert.equal(schedulers.length, 2);
    assert.equal(schedulers[0], schedulers[1]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('package store rejects unverified or non-JSON bytes before activation', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-store-'));
  try {
    const { bytes } = publicPackageBytes();
    const store = new PackageStoreV1(home);
    assert.throws(
      () =>
        store.putVerifiedPackage({
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          manifest_digest: 'b'.repeat(64),
          package_bytes: bytes.byteLength,
          bytes,
        }),
      PublicContractError,
    );
    assert.throws(
      () =>
        store.putVerifiedPackage({
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: sha256Digest(Buffer.from('not JSON')),
          manifest_digest: 'b'.repeat(64),
          package_bytes: 8,
          bytes: Buffer.from('not JSON'),
        }),
      PublicContractError,
    );
    assert.equal(store.getInstalled('ikea'), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a package cannot place a non-string input in an endpoint, query, or header slot', () => {
  const value = publicPackageValue();
  const capability = value.capabilities.get_product;
  capability.input_schema.properties.id = { type: 'integer', minimum: 1 };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(
    () => parsePublicToolPackage(value),
    (error) =>
      error instanceof PublicContractError &&
      error.field === 'package.capabilities.get_product.strategies[0].request.query.id' &&
      /declared integer/.test(error.message) &&
      /to_string/.test(error.message),
  );
  capability.strategies[0].request.query.id = {
    op: 'to_string',
    value: { op: 'input', pointer: '/id' },
  };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.equal(parsePublicToolPackage(value).capabilities.get_product.input_schema.properties.id.type, 'integer');
  capability.strategies[0].request.headers['x-page'] = { op: 'literal', value: 2 };
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(
    () => parsePublicToolPackage(value),
    (error) =>
      error instanceof PublicContractError &&
      error.field === 'package.capabilities.get_product.strategies[0].request.headers.x-page',
  );
});

test('outgoing target requests identify the runtime unless the package labels itself', () => {
  const url = new URL('https://api.example.test/products?id=1');
  const defaulted = outgoingRequestHeaders({ headers: { accept: 'application/json' }, url });
  assert.match(defaulted['user-agent'], /^klura\/\d+\.\d+\.\d+$/);
  assert.equal(defaulted.accept, 'application/json');
  assert.equal(defaulted.host, 'api.example.test');
  const declared = outgoingRequestHeaders({ headers: { 'user-agent': 'acme-tool/2' }, url });
  assert.equal(declared['user-agent'], 'acme-tool/2');
});

test('a collection cannot declare a journal frame budget its own ceilings would exhaust', () => {
  const value = authenticatedCollectionPackageValue();
  const policy = value.capabilities.get_product.collection.run_policy;
  policy.max_items = 10;
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(
    () => parsePublicToolPackage(value),
    (error) =>
      error instanceof PublicContractError &&
      error.field ===
        'package.capabilities.get_product.collection.run_policy.durable.max_journal_frames' &&
      /need at least 44/.test(error.message),
  );
  assert.equal(minimumJournalFrames({ max_tasks: policy.max_tasks, max_items: 10 }), 44);
  policy.durable.max_journal_frames = 44;
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.equal(
    parsePublicToolPackage(value).capabilities.get_product.collection.run_policy.durable
      .max_journal_frames,
    44,
  );
  policy.max_items = 100;
  policy.durable.max_journal_frames = minimumJournalFrames({ max_tasks: policy.max_tasks, max_items: 100 });
  policy.durable.max_journal_bytes = 393_432;
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.throws(
    () => parsePublicToolPackage(value),
    (error) =>
      error instanceof PublicContractError &&
      error.field ===
        'package.capabilities.get_product.collection.run_policy.durable.max_journal_bytes' &&
      /reserved for emergency frames/.test(error.message),
  );
  policy.durable.max_journal_bytes = minimumJournalBytes({ max_tasks: policy.max_tasks, max_items: 100 });
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  assert.equal(
    parsePublicToolPackage(value).capabilities.get_product.collection.run_policy.durable
      .max_journal_bytes,
    JOURNAL_EMERGENCY_BYTE_RESERVE_V1 + JOURNAL_ORDINARY_FRAME_BYTES_V1 * (9 + 5 * policy.max_tasks + 300),
  );
});

test('a json_array_map projection caps the rows a call returns when it declares a limit', () => {
  const contract = (limit) =>
    parseOutcomeContract(
      {
        outcome_id: 'rows',
        class: 'success',
        output_schema: {
          type: 'array',
          minItems: 0,
          maxItems: 10,
          items: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1, maxLength: 8 } },
            required: ['id'],
            additionalProperties: false,
          },
        },
        cases: [
          {
            case_id: 'rows_read',
            strategy_ids: ['request'],
            matcher: { op: 'all', items: [{ op: 'status_in', values: [200] }] },
            projection: {
              kind: 'json_array_map',
              items_pointer: '/entries',
              include_when: {
                op: 'equals',
                left: { kind: 'ref', ref: { from: 'raw_item', pointer: '/keep' } },
                right: { kind: 'literal', value: true },
              },
              projection: {
                op: 'object',
                entries: { id: { op: 'get', from: 'raw_item', pointer: '/id' } },
              },
              ...(limit === undefined ? {} : { limit }),
            },
            assertions: [],
            retry_after: null,
          },
        ],
      },
      'outcome',
      ['request'],
    );
  const response = {
    status: 200,
    headers: {},
    media_type: 'application/json',
    body_kind: 'json_object',
    body: {
      entries: [
        { id: 'a', keep: true },
        { id: 'b', keep: false },
        { id: 'c', keep: true },
        { id: 'd', keep: true },
      ],
    },
  };
  assert.equal(contract().cases[0].projection.limit, null);
  assert.deepEqual(
    evaluateOutcomeContracts([contract()], 'request', response, { input: {} }).data,
    [{ id: 'a' }, { id: 'c' }, { id: 'd' }],
  );
  assert.deepEqual(
    evaluateOutcomeContracts([contract(2)], 'request', response, { input: {} }).data,
    [{ id: 'a' }, { id: 'c' }],
  );
  assert.throws(
    () => contract(0),
    (error) => error instanceof PublicContractError && /limit/.test(error.field),
  );
});
