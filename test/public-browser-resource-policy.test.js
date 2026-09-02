import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  matchBrowserEgressRule,
  matchBrowserPreflightEgressRule,
  parseBrowserResourcePolicy,
} = require('../dist/consumer/execution/public-browser/resource-policy.js');

function browserResourcePolicy() {
  return {
    egress_rules: [
      {
        rule_id: 'asset',
        phase: 'resource',
        origin: 'https://cdn.example.test',
        methods: ['GET'],
        route: { path: { kind: 'prefix', value: '/assets/' }, query: { kind: 'none' } },
        resource_types: ['image', 'script'],
        max_requests: 4,
        max_encoded_request_body_bytes: 0,
        max_encoded_response_bytes: 1024,
      },
      {
        rule_id: 'page',
        phase: 'navigation',
        origin: 'https://example.test',
        methods: ['GET', 'HEAD'],
        route: {
          path: { kind: 'exact', value: '/search' },
          query: { kind: 'keys', required: ['q'], allowed: ['page', 'q'] },
        },
        resource_types: ['document'],
        max_requests: 2,
        max_encoded_request_body_bytes: 0,
        max_encoded_response_bytes: 2048,
      },
    ],
    max_requests_per_browser_task: 6,
    max_encoded_request_body_bytes_per_browser_task: 0,
    max_encoded_response_bytes_per_browser_task: 4096,
    max_proxy_wire_bytes_per_browser_task: 8192,
    max_single_request_body_bytes: 0,
    max_single_response_bytes: 2048,
    service_workers: 'block',
    downloads: 'block',
    popups: 'block',
    websockets: 'block',
    webtransport: 'block',
    webrtc_direct_egress: 'block',
    browser_cache: 'block',
  };
}

test('browser egress rules match exact phase, origin, method, resource type, path, and query shape', () => {
  const policy = parseBrowserResourcePolicy(browserResourcePolicy(), 'browser_resources');
  assert.equal(
    matchBrowserEgressRule(policy, {
      phase: 'navigation',
      url: 'https://example.test/search?page=2&q=desk',
      method: 'GET',
      resource_type: 'document',
    })?.rule_id,
    'page',
  );
  for (const candidate of [
    {
      phase: 'navigation',
      url: 'https://example.test/search?q=desk&extra=x',
      method: 'GET',
      resource_type: 'document',
    },
    {
      phase: 'navigation',
      url: 'https://example.test/search?q=desk',
      method: 'POST',
      resource_type: 'document',
    },
    {
      phase: 'resource',
      url: 'https://cdn.example.test/assets/app.js',
      method: 'GET',
      resource_type: 'stylesheet',
    },
  ]) {
    assert.equal(matchBrowserEgressRule(policy, candidate), null);
  }
});

test('browser egress policies reject overlapping rules and noncanonical route declarations', () => {
  const overlapping = browserResourcePolicy();
  overlapping.egress_rules.push({
    rule_id: 'page_prefix',
    phase: 'navigation',
    origin: 'https://example.test',
    methods: ['GET'],
    route: { path: { kind: 'prefix', value: '/' }, query: { kind: 'keys', required: [], allowed: ['q'] } },
    resource_types: ['document'],
    max_requests: 1,
    max_encoded_request_body_bytes: 0,
    max_encoded_response_bytes: 1024,
  });
  assert.throws(
    () => parseBrowserResourcePolicy(overlapping, 'browser_resources'),
    /overlap/,
  );
  const noncanonical = browserResourcePolicy();
  noncanonical.egress_rules[0].route.path.value = '/assets/../secret';
  assert.throws(
    () => parseBrowserResourcePolicy(noncanonical, 'browser_resources'),
    /canonical URL path normalization/,
  );
});

test('runtime-owned browser HTTP permits only its exact fetch POST rule', () => {
  const value = browserResourcePolicy();
  value.egress_rules.push({
    rule_id: 'runtime_search',
    phase: 'runtime_request',
    origin: 'https://example.test',
    methods: ['POST'],
    route: { path: { kind: 'exact', value: '/api/search' }, query: { kind: 'none' } },
    resource_types: ['fetch'],
    max_requests: 1,
    max_encoded_request_body_bytes: 512,
    max_encoded_response_bytes: 1024,
  });
  value.max_encoded_request_body_bytes_per_browser_task = 512;
  value.max_single_request_body_bytes = 512;
  const policy = parseBrowserResourcePolicy(value, 'browser_resources');
  assert.equal(
    matchBrowserEgressRule(policy, {
      phase: 'runtime_request',
      url: 'https://example.test/api/search',
      method: 'POST',
      resource_type: 'fetch',
    })?.rule_id,
    'runtime_search',
  );
  assert.equal(
    matchBrowserEgressRule(policy, {
      phase: 'resource',
      url: 'https://example.test/api/search',
      method: 'POST',
      resource_type: 'fetch',
    }),
    null,
  );
  value.egress_rules.at(-1).resource_types = ['xhr'];
  assert.throws(
    () => parseBrowserResourcePolicy(value, 'browser_resources'),
    /exactly fetch/,
  );
});

test('resource POST rules require explicit request-body ceilings', () => {
  const value = browserResourcePolicy();
  value.egress_rules.push({
    rule_id: 'background_post',
    phase: 'resource',
    origin: 'https://example.test',
    methods: ['POST'],
    route: { path: { kind: 'exact', value: '/telemetry' }, query: { kind: 'none' } },
    resource_types: ['fetch'],
    max_requests: 2,
    max_encoded_request_body_bytes: 512,
    max_encoded_response_bytes: 1024,
  });
  value.max_requests_per_browser_task = 8;
  value.max_encoded_request_body_bytes_per_browser_task = 512;
  value.max_single_request_body_bytes = 512;
  const policy = parseBrowserResourcePolicy(value, 'browser_resources');
  assert.equal(
    matchBrowserEgressRule(policy, {
      phase: 'resource',
      url: 'https://example.test/telemetry',
      method: 'POST',
      resource_type: 'fetch',
    })?.rule_id,
    'background_post',
  );
  const missingLimit = browserResourcePolicy();
  missingLimit.egress_rules[0].max_encoded_request_body_bytes = 1;
  missingLimit.max_encoded_request_body_bytes_per_browser_task = 1;
  missingLimit.max_single_request_body_bytes = 1;
  assert.throws(
    () => parseBrowserResourcePolicy(missingLimit, 'browser_resources'),
    /must be zero when POST is not declared/,
  );
  const navigationPost = browserResourcePolicy();
  navigationPost.egress_rules[1].methods = ['POST'];
  assert.throws(
    () => parseBrowserResourcePolicy(navigationPost, 'browser_resources'),
    /must be GET or HEAD/,
  );
  const interactionPost = browserResourcePolicy();
  interactionPost.egress_rules.push({
    rule_id: 'interaction_post',
    phase: 'interaction',
    origin: 'https://example.test',
    methods: ['POST'],
    route: { path: { kind: 'exact', value: '/search' }, query: { kind: 'none' } },
    resource_types: ['xhr'],
    max_requests: 1,
    max_encoded_request_body_bytes: 1,
    max_encoded_response_bytes: 1024,
  });
  interactionPost.max_encoded_request_body_bytes_per_browser_task = 1;
  interactionPost.max_single_request_body_bytes = 1;
  assert.throws(
    () => parseBrowserResourcePolicy(interactionPost, 'browser_resources'),
    /must be GET or HEAD/,
  );
});

test('ping is an exact resource-phase type and Other remains outside the public schema', () => {
  const value = browserResourcePolicy();
  value.egress_rules.push({
    rule_id: 'beacon',
    phase: 'resource',
    origin: 'https://example.test',
    methods: ['POST'],
    route: { path: { kind: 'exact', value: '/beacon' }, query: { kind: 'none' } },
    resource_types: ['ping'],
    max_requests: 1,
    max_encoded_request_body_bytes: 64,
    max_encoded_response_bytes: 1024,
  });
  value.max_requests_per_browser_task = 7;
  value.max_encoded_request_body_bytes_per_browser_task = 64;
  value.max_single_request_body_bytes = 64;
  const policy = parseBrowserResourcePolicy(value, 'browser_resources');
  assert.equal(
    matchBrowserEgressRule(policy, {
      phase: 'resource',
      url: 'https://example.test/beacon',
      method: 'POST',
      resource_type: 'ping',
    })?.rule_id,
    'beacon',
  );
  assert.equal(
    matchBrowserEgressRule(policy, {
      phase: 'resource',
      url: 'https://example.test/beacon',
      method: 'POST',
      resource_type: 'other',
    }),
    null,
  );
  for (const phase of ['navigation', 'interaction', 'runtime_request', 'page_script']) {
    const invalid = structuredClone(value);
    invalid.egress_rules.at(-1).phase = phase;
    assert.throws(
      () => parseBrowserResourcePolicy(invalid, 'browser_resources'),
      /may contain ping only for a resource rule/,
    );
  }
});

test('CORS preflight derives one exact signed fetch or XHR rule', () => {
  const value = browserResourcePolicy();
  value.egress_rules.push({
    rule_id: 'cors_post',
    phase: 'resource',
    origin: 'https://api.example.test',
    methods: ['POST'],
    route: {
      path: { kind: 'exact', value: '/items' },
      query: { kind: 'keys', required: ['page'], allowed: ['page'] },
    },
    resource_types: ['fetch'],
    max_requests: 2,
    max_encoded_request_body_bytes: 512,
    max_encoded_response_bytes: 1024,
  });
  value.max_requests_per_browser_task = 8;
  value.max_encoded_request_body_bytes_per_browser_task = 512;
  value.max_single_request_body_bytes = 512;
  const policy = parseBrowserResourcePolicy(value, 'browser_resources');
  const candidate = {
    phase: 'resource',
    url: 'https://api.example.test/items?page=2',
    method: 'OPTIONS',
    resource_type: 'preflight',
    requested_method: 'POST',
  };
  assert.equal(matchBrowserPreflightEgressRule(policy, candidate)?.rule_id, 'cors_post');
  for (const override of [
    { requested_method: 'post' },
    { requested_method: ' POST ' },
    { requested_method: 'PUT' },
    { resource_type: 'fetch' },
    { method: 'POST' },
    { url: 'https://api.example.test/items?page=2&extra=1' },
    { url: 'https://other.example.test/items?page=2' },
    { phase: 'interaction' },
  ]) {
    assert.equal(matchBrowserPreflightEgressRule(policy, { ...candidate, ...override }), null);
  }

  const ambiguous = browserResourcePolicy();
  ambiguous.egress_rules.push(
    {
      rule_id: 'cors_fetch',
      phase: 'resource',
      origin: 'https://api.example.test',
      methods: ['POST'],
      route: { path: { kind: 'exact', value: '/items' }, query: { kind: 'none' } },
      resource_types: ['fetch'],
      max_requests: 2,
      max_encoded_request_body_bytes: 64,
      max_encoded_response_bytes: 1024,
    },
    {
      rule_id: 'cors_xhr',
      phase: 'resource',
      origin: 'https://api.example.test',
      methods: ['POST'],
      route: { path: { kind: 'exact', value: '/items' }, query: { kind: 'none' } },
      resource_types: ['xhr'],
      max_requests: 2,
      max_encoded_request_body_bytes: 64,
      max_encoded_response_bytes: 1024,
    },
  );
  ambiguous.max_requests_per_browser_task = 10;
  ambiguous.max_encoded_request_body_bytes_per_browser_task = 128;
  ambiguous.max_single_request_body_bytes = 64;
  assert.throws(
    () => parseBrowserResourcePolicy(ambiguous, 'browser_resources'),
    /overlap/,
  );
});
