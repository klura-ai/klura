// End-to-end for the fetch tier: a reviewed capability with an `http` block,
// through parseCapabilityReview → buildCapabilitySource → the package compiler.
//
// The unit tests cover the projection in isolation, which is not the same claim
// as "a fetch capability can ship". The compiler enforces constraints the
// projection never sees — chiefly that `base_url` must be a declared
// request_origin — so only this path proves the tier actually packages.

import test from 'node:test';
import assert from 'node:assert';

import {
  parseCapabilityReview,
  buildCapabilitySource,
} from '../dist/factory/public-package/capability-review.js';
import { compilePublicPackageSource } from '../dist/factory/public-package/compiler.js';

const ORIGIN = 'https://api.example.test';

const localFetchStrategy = {
  strategy: 'fetch',
  method: 'GET',
  baseUrl: ORIGIN,
  endpoint: '/products/{{id}}',
  params: { locale: 'en', limit: 24 },
  headers: { accept: 'application/json' },
  notes: { params: { id: { description: 'product id', example: 'p-1', source: 'caller' } } },
};

function contract(over = {}) {
  return {
    description: 'Get one product.',
    visibility: 'public',
    effect: 'read',
    authentication: { mode: 'none' },
    request_origins: [ORIGIN],
    navigation_origins: [],
    origin_traffic_policies: [
      {
        origin: ORIGIN,
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
            matcher: { op: 'all', items: [{ op: 'status_in', values: [200] }] },
            projection: { kind: 'json_pointer', pointer: '/item' },
            assertions: [],
            retry_after: null,
          },
        ],
      },
    ],
    control: null,
    collection: null,
    ...over,
  };
}

const httpReview = (over = {}) => ({
  contract: contract(over.contract),
  http: {
    tier: 'fetch',
    strategy_id: 'request',
    context: 'node',
    replay: 'safe_read',
    response_body_limit_bytes: 65_536,
    ...over.http,
  },
  fixtures: [{ fixture_id: 'basic', kind: 'call', input: { id: 'p-1' } }],
});

const parse = (review) =>
  parseCapabilityReview(review, {
    field_prefix: 'review.capabilities',
    capability_id: 'get_product',
    seen_fixture_ids: new Set(),
  });

const packageAround = (capabilitySource) => ({
  package_source_schema_version: 1,
  package: {
    package_schema_version: 1,
    package_id: 'acme',
    version: '1.0.0',
    authentication_contracts: {},
    capabilities: { get_product: capabilitySource },
  },
});

test('a reviewed http capability parses, projects and compiles', () => {
  const parsed = parse(httpReview());
  assert.equal(parsed.http.tier, 'fetch');
  assert.equal(parsed.page_script, null);

  const source = buildCapabilitySource(localFetchStrategy, parsed);
  const [strategy] = source.strategies;
  assert.equal(strategy.kind, 'http_request');
  assert.equal(strategy.request.base_url, ORIGIN);
  // The caller argument survives as an input read, and the static param as a literal.
  assert.equal(strategy.request.endpoint.op, 'concat');
  assert.deepEqual(strategy.request.query.limit, { op: 'literal', value: 24 });

  const compiled = compilePublicPackageSource(packageAround(source));
  assert.ok(compiled, 'package did not compile');
});

test('a base_url outside the declared request origins is rejected by the compiler', () => {
  // The projection cannot see this: request_origins lives on the reviewed
  // contract, base_url on the saved strategy. Only the compiler holds both.
  const parsed = parse(httpReview({ contract: { request_origins: ['https://other.example'] } }));
  const source = buildCapabilitySource(localFetchStrategy, parsed);
  assert.throws(() => compilePublicPackageSource(packageAround(source)), /request origin/i);
});

test('a review declaring both blocks is rejected', () => {
  const review = httpReview();
  review.page_script = { tier: 'page-script', strategy_id: 'x' };
  assert.throws(() => parse(review), /either page_script or http, not both/);
});

test('a review declaring neither block is rejected', () => {
  const review = httpReview();
  delete review.http;
  assert.throws(() => parse(review), /either a page_script or an http/);
});

test('an http review over a page-script local strategy is refused', () => {
  // The reviewed tier and the saved strategy must agree; the export audit
  // selects by reviewed tier, so a mismatch here means a mis-declared review.
  const parsed = parse(httpReview());
  assert.throws(
    () => buildCapabilitySource({ ...localFetchStrategy, strategy: 'page-script' }, parsed),
    /must be fetch/,
  );
});
