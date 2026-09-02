import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PACKAGE_SOURCE_FILE_NAME,
  parseRegistryCatalogManifest,
  parseRegistryCatalogManifestBytes,
  parseRegistryReleaseSourcePath,
  projectRegistryReleaseCatalog,
  REGISTRY_CATALOG_LIMITS,
  REGISTRY_RELEASE_CATALOG_KEYS,
} = require('../dist/public/contracts/registry-catalog.js');
const {
  isAllowedToolsPackageFile,
  isAllowedToolsRepositoryPath,
  TOOLS_PACKAGE_LAYOUT_V1,
} = require('../dist/factory/public-package/tools-layout.js');
const {
  buildPackageReviewSnapshot,
  projectCapabilityForReview,
  projectPackageForReview,
  projectStrategyForReview,
  REVIEW_PROJECTION_OMITTED_KEYS,
  REVIEW_PROJECTION_SCHEMA_VERSION,
} = require('../dist/consumer/registry/review-projection.js');
const {
  calculatePublicToolPackageManifestDigest,
  parsePublicToolPackage,
} = require('../dist/public/contracts/package.js');
const { parseRegistryIndex } = require('../dist/public/contracts/registry-index.js');
const { sha256Digest } = require('../dist/public/contracts/common.js');
const { canonicalJson } = require('../dist/public/contracts/json.js');
const { deriveInlineOutputBound } = require('../dist/public/contracts/inline-output-bound.js');
const { parseJsonSchema } = require('../dist/public/contracts/json-schema.js');

const PAGE_SCRIPT_SOURCE =
  'async (args) => await (await fetch(`/products?id=${encodeURIComponent(args.id)}`)).json()';

function catalogManifestValue() {
  return {
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
        runtime_range: { minimum_inclusive: '0.6.3', maximum_exclusive: '0.7.0' },
      },
      {
        source: 'releases/0.9.0/package.source.json',
        state: 'withdrawn',
        runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '0.6.3' },
      },
    ],
  };
}

test('registry catalog manifests round-trip their exact typed shape', () => {
  const manifest = parseRegistryCatalogManifest(catalogManifestValue(), 'registry.json');
  assert.deepEqual(manifest, catalogManifestValue());
  assert.deepEqual(
    parseRegistryCatalogManifestBytes(
      Buffer.from(`${JSON.stringify(catalogManifestValue(), null, 2)}\n`),
      'registry.json',
    ),
    catalogManifestValue(),
  );
});

test('registry catalog manifests reject structural drift with exact field paths', () => {
  const cases = [
    [(value) => (value.registry_catalog_schema_version = 2), /registry_catalog_schema_version/],
    [(value) => (value.unexpected = true), /unexpected/],
    [(value) => delete value.stable_version, /stable_version/],
    [(value) => (value.releases = []), /releases/],
    [(value) => (value.display_name = ''), /display_name.*must not be empty/],
    [(value) => (value.domains = ['a.test', 'a.test']), /domains\[1\].*duplicates/],
    [(value) => (value.releases[0].state = 'published'), /state.*installable or withdrawn/],
    [
      (value) =>
        (value.releases[0].runtime_range = {
          minimum_inclusive: '2.0.0',
          maximum_exclusive: '1.0.0',
        }),
      /runtime_range/,
    ],
    [(value) => (value.releases[1].source = 'package.source.json'), /must not be duplicated/],
    [(value) => (value.releases[0].source = '../escape/package.source.json'), /source/],
  ];
  for (const [mutate, expected] of cases) {
    const value = catalogManifestValue();
    mutate(value);
    assert.throws(() => parseRegistryCatalogManifest(value, 'registry.json'), expected);
  }
});

test('registry catalog manifest bytes stay inside the shared byte bound', () => {
  const value = catalogManifestValue();
  value.description = 'x'.repeat(REGISTRY_CATALOG_LIMITS.maximumBytes);
  assert.throws(
    () => parseRegistryCatalogManifestBytes(Buffer.from(JSON.stringify(value)), 'registry.json'),
    /registry\.json/,
  );
});

test('release source paths bind stable and immutable release files to the grammar', () => {
  assert.deepEqual(parseRegistryReleaseSourcePath('package.source.json', 'source'), {
    kind: 'stable',
  });
  assert.deepEqual(parseRegistryReleaseSourcePath('releases/1.2.3/package.source.json', 'source'), {
    kind: 'release',
    version: '1.2.3',
  });
  for (const invalid of [
    'releases/1.2.3/other.json',
    'releases/not-a-version/package.source.json',
    'releases/1.2.3/extra/package.source.json',
    '../package.source.json',
    '/package.source.json',
    'package.source.json/',
    '',
  ]) {
    assert.throws(() => parseRegistryReleaseSourcePath(invalid, 'source'), /source/);
  }
});

test('release catalog projection carries exactly the compiler catalog key set', () => {
  const manifest = parseRegistryCatalogManifest(catalogManifestValue(), 'registry.json');
  const catalog = projectRegistryReleaseCatalog(manifest, manifest.releases[1]);
  assert.deepEqual(Object.keys(catalog).sort(), [...REGISTRY_RELEASE_CATALOG_KEYS].sort());
  assert.equal(catalog.state, 'withdrawn');
  assert.deepEqual(catalog.runtime_range, manifest.releases[1].runtime_range);
  assert.equal(catalog.display_name, manifest.display_name);
});

test('the tools package layout admits exactly the reviewable file grammar', () => {
  assert.equal(TOOLS_PACKAGE_LAYOUT_V1.packageSourceFileName, PACKAGE_SOURCE_FILE_NAME);
  for (const allowed of [
    'tools/ikea/registry.json',
    'tools/ikea/package.source.json',
    'tools/ikea/releases/1.0.0/package.source.json',
    'tools/ikea/fixtures/product-found.call.json',
    'tools/ikea/fixtures/search-stories.no-results.run.json',
  ]) {
    assert.equal(isAllowedToolsRepositoryPath(allowed), true, allowed);
  }
  for (const disallowed of [
    '.github/workflows/tool-pr-checks.yml',
    'scripts/build-static-registry.js',
    'tools/ikea/README.md',
    'tools/ikea/fixtures/nested/product-found.call.json',
    'tools/ikea/fixtures/product-found.json',
    'tools/ikea/releases/1.0.0/notes.json',
    'tools/ikea/releases/not-a-version/package.source.json',
    'tools/Not_A_Package/registry.json',
    'tools/registry.json',
  ]) {
    assert.equal(isAllowedToolsRepositoryPath(disallowed), false, disallowed);
  }
  assert.equal(isAllowedToolsPackageFile('registry.json'), true);
  assert.equal(isAllowedToolsPackageFile('fixtures/lookup.call.json'), true);
  assert.equal(isAllowedToolsPackageFile('fixtures/lookup.json'), false);
});

function httpPackageValue() {
  const value = {
    package_schema_version: 1,
    package_id: 'demo',
    version: '1.0.0',
    manifest_digest: '0'.repeat(64),
    authentication_contracts: {},
    capabilities: {
      get_product: {
        description: 'This catalog copy must not appear in review output.',
        visibility: 'public',
        effect: 'read',
        authentication: { mode: 'none' },
        request_origins: ['https://api.example.test'],
        navigation_origins: [],
        origin_traffic_policies: [trafficPolicy('https://api.example.test')],
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

function trafficPolicy(origin) {
  return {
    origin,
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
  };
}

function browserNavigationPackageValue() {
  const value = httpPackageValue();
  const capability = value.capabilities.get_product;
  capability.request_origins = [];
  capability.navigation_origins = ['https://shop.example.test'];
  capability.origin_traffic_policies = [trafficPolicy('https://shop.example.test')];
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
        source: PAGE_SCRIPT_SOURCE,
        source_digest: sha256Digest(PAGE_SCRIPT_SOURCE),
        arguments: { op: 'object', fields: { id: { op: 'input', pointer: '/id' } } },
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
      { op: 'json_pointer', pointer: '/ok', test: 'equals', value: true, expected_type: null },
    ],
  };
  capability.outcomes[0].cases[0].projection = { kind: 'json_pointer', pointer: '/item' };
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

function parsedCapability(packageValue) {
  return parsePublicToolPackage(packageValue).capabilities.get_product;
}

function parsedRegistryVersion(packageValue) {
  const toolPackage = parsePublicToolPackage(packageValue);
  const bytes = Buffer.from(canonicalJson(packageValue));
  const index = parseRegistryIndex({
    registry_schema_version: 1,
    generated_at: '2026-07-27T00:00:00Z',
    expires_at: '2026-07-28T00:00:00Z',
    packages: {
      [toolPackage.package_id]: {
        package_id: toolPackage.package_id,
        display_name: 'Demo',
        description: 'A demo package.',
        domains: ['example.test'],
        tags: ['demo'],
        stable_version: toolPackage.version,
        versions: {
          [toolPackage.version]: {
            version: toolPackage.version,
            state: 'installable',
            package_url: `https://registry.example.test/v1/packages/${sha256Digest(bytes)}.json`,
            package_bytes: bytes.byteLength,
            package_digest: sha256Digest(bytes),
            manifest_digest: toolPackage.manifest_digest,
            runtime_range: { minimum_inclusive: '0.6.3', maximum_exclusive: '0.7.0' },
            capabilities: {
              get_product: {
                description: 'Get one product.',
                run_supported: false,
                transports: ['http_node'],
              },
            },
          },
        },
      },
    },
  });
  const registryPackage = index.packages[toolPackage.package_id];
  return {
    index,
    toolPackage,
    registryPackage,
    registryVersion: registryPackage.versions[toolPackage.version],
  };
}

test('every strategy tier projects every parsed contract field for review', () => {
  const strategies = [
    parsedCapability(httpPackageValue()).strategies[0],
    parsedCapability(browserNavigationPackageValue()).strategies[0],
    parsedCapability(browserPageScriptPackageValue()).strategies[0],
  ];
  assert.deepEqual(
    strategies.map((strategy) => strategy.kind),
    ['http_request', 'browser_navigation', 'browser_page_script'],
  );
  for (const strategy of strategies) {
    const projected = projectStrategyForReview(strategy);
    assert.deepEqual(
      Object.keys(projected).sort(),
      Object.keys(strategy).sort(),
      `${strategy.kind} projection must carry every contract field`,
    );
    if (strategy.kind === 'browser_page_script') {
      assert.deepEqual(
        Object.keys(projected.program).sort(),
        Object.keys(strategy.program).sort(),
        'page-script program projection must carry every program field',
      );
    }
  }
  assert.deepEqual(REVIEW_PROJECTION_OMITTED_KEYS.strategy, []);
});

test('a page-script program surfaces verbatim in the review projection', () => {
  const capability = parsedCapability(browserPageScriptPackageValue());
  const projected = projectStrategyForReview(capability.strategies[0]);
  assert.equal(projected.program.source, PAGE_SCRIPT_SOURCE);
  assert.equal(projected.program.source_digest, sha256Digest(PAGE_SCRIPT_SOURCE));
  assert.deepEqual(projected.program.expect.egress_rule_ids, ['product_script']);
  assert.deepEqual(projected.program.request_body_limits.max_encoded_request_body_bytes_by_rule, {
    product_script: 0,
  });
});

test('an unknown strategy kind fails projection instead of projecting a subset', () => {
  assert.throws(
    () => projectStrategyForReview({ kind: 'browser_teleport' }),
    /is not a projectable strategy kind/,
  );
});

test('capability projection covers every contract key except the documented omissions', () => {
  const capability = parsedCapability(browserPageScriptPackageValue());
  const projected = projectCapabilityForReview(capability);
  const covered = new Set([
    ...Object.keys(projected),
    ...Object.keys(projected.request_budget),
    ...REVIEW_PROJECTION_OMITTED_KEYS.capability,
  ]);
  for (const key of Object.keys(capability)) {
    assert.equal(covered.has(key), true, `capability contract key ${key} needs a projection decision`);
  }
  assert.equal(Object.hasOwn(projected, 'description'), false);
  assert.equal(Object.hasOwn(projected, 'input_schema'), true);
  assert.equal(Object.hasOwn(projected, 'outcomes'), true);
  assert.equal(Object.hasOwn(projected, 'visibility'), true);
});

test('collection contracts project every parsed field', () => {
  const value = httpPackageValue();
  const capability = value.capabilities.get_product;
  capability.input_schema.properties.cursor = { type: 'string', minLength: 1 };
  capability.collection = collectionContractValue();
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  const parsed = parsedCapability(value);
  const projected = projectCapabilityForReview(parsed);
  assert.deepEqual(
    Object.keys(projected.collection).sort(),
    Object.keys(parsed.collection).sort(),
    'collection projection must carry every contract field',
  );
  assert.ok(projected.collection.item_schema);
  assert.ok(projected.collection.item_identity);
});

function collectionContractValue() {
  const itemSchema = {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['id'],
    additionalProperties: false,
  };
  return {
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
    item_schema: itemSchema,
    item_identity: { pointers: ['/id'] },
    inline_output_bound: deriveInlineOutputBound(parseJsonSchema(itemSchema, 'item_schema')),
    semantic_stops: [],
    csv_columns: null,
    task_kinds: [
      {
        id: 'list_page',
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
}

test('package projection covers the package and index entry minus documented omissions', () => {
  const { toolPackage, registryVersion } = parsedRegistryVersion(browserPageScriptPackageValue());
  const projected = projectPackageForReview(toolPackage, registryVersion);
  const projectedKeys = new Set(Object.keys(projected));
  for (const key of Object.keys(toolPackage)) {
    const decided =
      projectedKeys.has(key) ||
      REVIEW_PROJECTION_OMITTED_KEYS.package.includes(key) ||
      key === 'manifest_digest';
    assert.equal(decided, true, `package contract key ${key} needs a projection decision`);
  }
  for (const key of Object.keys(registryVersion)) {
    const decided =
      projectedKeys.has(key) || REVIEW_PROJECTION_OMITTED_KEYS.registry_version.includes(key);
    assert.equal(decided, true, `registry version key ${key} needs a projection decision`);
  }
});

test('the review snapshot binds the schema version and carries page-script code, not prose', () => {
  const packageValue = browserPageScriptPackageValue();
  const { index, toolPackage } = parsedRegistryVersion(packageValue);
  const snapshot = buildPackageReviewSnapshot(index, () => toolPackage);
  assert.equal(snapshot.review_schema_version, REVIEW_PROJECTION_SCHEMA_VERSION);
  const rendered = JSON.stringify(snapshot);
  assert.equal(rendered.includes('This catalog copy must not appear in review output.'), false);
  assert.equal(
    rendered.includes(JSON.stringify(PAGE_SCRIPT_SOURCE).slice(1, -1)),
    true,
    'the review snapshot must contain the exact page-script source',
  );
});
