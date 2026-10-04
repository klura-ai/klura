import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const {
  executeBrowserNavigationStrategy,
  installBrowserNetworkBoundary,
} = require('../dist/consumer/execution/public-browser/executor.js');
const {
  executeBrowserPageScriptStrategyInBoundedPage,
  executeReviewedPageProgram,
  installReviewedPageProgramRunner,
} = require('../dist/consumer/execution/public-browser/page-script-executor.js');
const {
  installPublicSinglePageGuard,
} = require('../dist/consumer/execution/public-browser/context.js');
const { OriginSchedulerV1 } = require('../dist/consumer/execution/origin-scheduler.js');
const {
  parseBrowserResourcePolicy,
} = require('../dist/consumer/execution/public-browser/resource-policy.js');
const { parseJsonSchema } = require('../dist/public/contracts/json-schema.js');

test('public browser navigation has no direct loopback fallback when the proxy rejects DNS', async () => {
  let connections = 0;
  const target = net.createServer(() => {
    connections += 1;
  });
  await listen(target);
  const address = target.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `https://127.0.0.1:${address.port}`;
  const strategy = {
    kind: 'browser_navigation',
    strategy_id: 'page',
    url: { op: 'literal', value: `${origin}/products` },
    wait: { kind: 'dom_content_loaded' },
    interaction: null,
    projection: {
      item_selector: 'main',
      cardinality: 'one',
      fields: { id: { kind: 'text', selector: null, required: true } },
    },
    prerequisites: [],
    replay: 'safe_read',
  };
  const capability = {
    strategies: [strategy],
    browser_resources: parseBrowserResourcePolicy(
      {
        egress_rules: [
          {
            rule_id: 'page',
            phase: 'navigation',
            origin,
            methods: ['GET'],
            route: { path: { kind: 'prefix', value: '/' }, query: { kind: 'none' } },
            resource_types: ['document'],
            max_requests: 1,
            max_encoded_request_body_bytes: 0,
            max_encoded_response_bytes: 1024,
          },
        ],
        max_requests_per_browser_task: 1,
        max_encoded_request_body_bytes_per_browser_task: 0,
        max_encoded_response_bytes_per_browser_task: 1024,
        max_proxy_wire_bytes_per_browser_task: 2048,
        max_single_request_body_bytes: 0,
        max_single_response_bytes: 1024,
        service_workers: 'block',
        downloads: 'block',
        popups: 'block',
        websockets: 'block',
        webtransport: 'block',
        webrtc_direct_egress: 'block',
        browser_cache: 'block',
      },
      'browser_resources',
    ),
    input_schema: parseJsonSchema(
      { type: 'object', properties: {}, required: [], additionalProperties: false },
      'input_schema',
    ),
    navigation_origins: [origin],
    origin_traffic_policies: [
      {
        origin,
        max_concurrency: 1,
        requests_per_second: 1,
        burst: 1,
        min_delay_ms: 0,
        max_redirect_hops: 0,
        circuit_breaker: {
          transient_failure_threshold: 1,
          transient_window_ms: 1_000,
          cooldown_ms: 1_000,
        },
      },
    ],
    max_target_requests_per_call: 1,
    max_encoded_outcome_bytes: 1024,
  };
  try {
    await assert.rejects(
      () =>
        executeBrowserNavigationStrategy(capability, strategy, {
          input: {},
          bindings: {},
          timeout_ms: 5_000,
          max_target_requests: 1,
          scheduler: new OriginSchedulerV1(),
          resolve_host: async () => ['127.0.0.1'],
        }),
      (error) =>
        error &&
        (error.code === 'transport_failure' || error.code === 'response_invalid_json') &&
        error.target_requests === 1,
    );
    assert.equal(connections, 0);
  } finally {
    await close(target);
  }
});

test('a completed reviewed page script seals browser egress against deferred requests', async () => {
  let resolveFailedRequest;
  const failedRequest = new Promise((resolve) => {
    resolveFailedRequest = resolve;
  });
  class FakeCdp extends EventEmitter {
    async send(method, payload) {
      if (method === 'Fetch.failRequest') resolveFailedRequest(payload);
      return {};
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const context = {
    newCDPSession: async () => cdp,
    close: async () => undefined,
  };
  const policy = parseBrowserResourcePolicy(
    {
      egress_rules: [
        {
          rule_id: 'script_request',
          phase: 'page_script',
          origin: 'https://example.test',
          methods: ['GET'],
          route: { path: { kind: 'exact', value: '/api' }, query: { kind: 'none' } },
          resource_types: ['fetch', 'xhr'],
          max_requests: 1,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
      ],
      max_requests_per_browser_task: 1,
      max_encoded_request_body_bytes_per_browser_task: 0,
      max_encoded_response_bytes_per_browser_task: 1024,
      max_proxy_wire_bytes_per_browser_task: 2048,
      max_single_request_body_bytes: 0,
      max_single_response_bytes: 1024,
      service_workers: 'block',
      downloads: 'block',
      popups: 'block',
      websockets: 'block',
      webtransport: 'block',
      webrtc_direct_egress: 'block',
      browser_cache: 'block',
    },
    'browser_resources',
  );
  const signal = new AbortController().signal;
  const boundary = await installBrowserNetworkBoundary({
    page: { context: () => context },
    capability: {
      browser_resources: policy,
      origin_traffic_policies: [
        {
          origin: 'https://example.test',
          max_concurrency: 1,
          requests_per_second: 1,
          burst: 1,
          min_delay_ms: 0,
          max_redirect_hops: 0,
          circuit_breaker: {
            transient_failure_threshold: 1,
            transient_window_ms: 1000,
            cooldown_ms: 1000,
          },
        },
      ],
    },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 1,
      scheduler: new OriginSchedulerV1(),
      signal,
    },
  });
  const expectation = {
    wait: null,
    egress_rule_ids: ['script_request'],
    minimum_matching_requests: 0,
    maximum_matching_requests: 1,
  };
  const scope = boundary.beginPageScript(
    'script',
    expectation,
    {
      max_encoded_request_body_bytes_per_script: 0,
      max_single_request_body_bytes: 0,
      max_encoded_request_body_bytes_by_rule: { script_request: 0 },
    },
    'https://example.test',
  );
  await boundary.finishPageScript(scope, expectation, signal);
  cdp.emit('Fetch.requestPaused', {
    requestId: 'deferred',
    request: {
      url: 'https://example.test/api',
      method: 'GET',
      hasPostData: false,
    },
    resourceType: 'Fetch',
  });
  assert.deepEqual(await failedRequest, {
    requestId: 'deferred',
    errorReason: 'BlockedByClient',
  });
  assert.throws(
    () => boundary.assertHealthy(),
    (error) => error?.code === 'request_blocked',
  );
  await boundary.close();
});

test('a signed CORS preflight uses the exact resource rule and wire budgets', async () => {
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      this.emit('send', { method, payload });
      if (method === 'Fetch.takeResponseBodyAsStream') {
        return { stream: `stream-${payload.requestId}` };
      }
      if (method === 'IO.read') {
        return { data: '', base64Encoded: false, eof: true };
      }
      return {};
    }

    waitFor(method, requestId) {
      const existing = this.calls.find(
        (call) => call.method === method && call.payload.requestId === requestId,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (call) => {
          if (call.method !== method || call.payload.requestId !== requestId) return;
          this.off('send', listener);
          resolve(call);
        };
        this.on('send', listener);
      });
    }

    async detach() {}
  }

  const policy = parseBrowserResourcePolicy(
    {
      egress_rules: [
        {
          rule_id: 'script_post',
          phase: 'resource',
          origin: 'https://api.example.test',
          methods: ['POST'],
          route: { path: { kind: 'exact', value: '/items' }, query: { kind: 'none' } },
          resource_types: ['fetch'],
          max_requests: 2,
          max_encoded_request_body_bytes: 64,
          max_encoded_response_bytes: 1024,
        },
      ],
      max_requests_per_browser_task: 2,
      max_encoded_request_body_bytes_per_browser_task: 64,
      max_encoded_response_bytes_per_browser_task: 2048,
      max_proxy_wire_bytes_per_browser_task: 4096,
      max_single_request_body_bytes: 64,
      max_single_response_bytes: 1024,
      service_workers: 'block',
      downloads: 'block',
      popups: 'block',
      websockets: 'block',
      webtransport: 'block',
      webrtc_direct_egress: 'block',
      browser_cache: 'block',
    },
    'browser_resources',
  );
  const installBoundary = (cdp, selectedPolicy) =>
    installBrowserNetworkBoundary({
      page: {
        context: () => ({
          newCDPSession: async () => cdp,
          close: async () => undefined,
        }),
      },
      capability: {
        browser_resources: selectedPolicy,
        origin_traffic_policies: [
          {
            origin: 'https://api.example.test',
            max_concurrency: 2,
            requests_per_second: 100,
            burst: 2,
            min_delay_ms: 0,
            max_redirect_hops: 0,
            circuit_breaker: {
              transient_failure_threshold: 2,
              transient_window_ms: 1000,
              cooldown_ms: 1000,
            },
          },
        ],
      },
      options: {
        input: {},
        bindings: {},
        timeout_ms: 1000,
        max_target_requests: 2,
        scheduler: new OriginSchedulerV1(),
        signal: new AbortController().signal,
      },
    });

  const cdp = new FakeCdp();
  const boundary = await installBoundary(cdp, policy);
  cdp.emit('Fetch.requestPaused', {
    requestId: 'preflight',
    request: {
      url: 'https://api.example.test/items',
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
      hasPostData: false,
    },
    resourceType: 'Preflight',
  });
  await cdp.waitFor('Fetch.continueRequest', 'preflight');
  cdp.emit('Fetch.requestPaused', {
    requestId: 'preflight',
    request: {
      url: 'https://api.example.test/items',
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
      hasPostData: false,
    },
    resourceType: 'Preflight',
    responseStatusCode: 204,
    responseHeaders: [],
  });
  await cdp.waitFor('Fetch.fulfillRequest', 'preflight');

  cdp.emit('Fetch.requestPaused', {
    requestId: 'actual',
    request: {
      url: 'https://api.example.test/items',
      method: 'POST',
      headers: {},
      hasPostData: true,
      postData: '{}',
    },
    resourceType: 'Fetch',
  });
  await cdp.waitFor('Fetch.continueRequest', 'actual');
  cdp.emit('Fetch.requestPaused', {
    requestId: 'actual',
    request: {
      url: 'https://api.example.test/items',
      method: 'POST',
      headers: {},
      hasPostData: true,
      postData: '{}',
    },
    resourceType: 'Fetch',
    responseStatusCode: 200,
    responseHeaders: [],
  });
  await cdp.waitFor('Fetch.fulfillRequest', 'actual');
  assert.equal(boundary.target_requests(), 2);
  boundary.assertHealthy();
  await boundary.close();

  const limitedCdp = new FakeCdp();
  const limitedPolicy = {
    ...policy,
    egress_rules: [{ ...policy.egress_rules[0], max_requests: 1 }],
  };
  const limitedBoundary = await installBoundary(limitedCdp, limitedPolicy);
  limitedCdp.emit('Fetch.requestPaused', {
    requestId: 'limited-preflight',
    request: {
      url: 'https://api.example.test/items',
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
      hasPostData: false,
    },
    resourceType: 'Preflight',
  });
  await limitedCdp.waitFor('Fetch.continueRequest', 'limited-preflight');
  limitedCdp.emit('Fetch.requestPaused', {
    requestId: 'limited-preflight',
    request: {
      url: 'https://api.example.test/items',
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
      hasPostData: false,
    },
    resourceType: 'Preflight',
    responseStatusCode: 204,
    responseHeaders: [],
  });
  await limitedCdp.waitFor('Fetch.fulfillRequest', 'limited-preflight');
  limitedCdp.emit('Fetch.requestPaused', {
    requestId: 'limited-actual',
    request: {
      url: 'https://api.example.test/items',
      method: 'POST',
      headers: {},
      hasPostData: true,
      postData: '{}',
    },
    resourceType: 'Fetch',
  });
  await limitedCdp.waitFor('Fetch.failRequest', 'limited-actual');
  assert.throws(
    () => limitedBoundary.assertHealthy(),
    (error) => error?.code === 'request_budget_exhausted',
  );
  await limitedBoundary.close();

  const bodyCdp = new FakeCdp();
  const bodyBoundary = await installBoundary(bodyCdp, policy);
  bodyCdp.emit('Fetch.requestPaused', {
    requestId: 'body-preflight',
    request: {
      url: 'https://api.example.test/items',
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
      hasPostData: true,
      postData: 'x',
    },
    resourceType: 'Preflight',
  });
  await bodyCdp.waitFor('Fetch.failRequest', 'body-preflight');
  assert.throws(
    () => bodyBoundary.assertHealthy(),
    (error) => error?.code === 'request_blocked',
  );
  assert.equal(bodyBoundary.target_requests(), 0);
  await bodyBoundary.close();
});

test('a signed resource-phase CDP Ping beacon is admitted and budgeted', async () => {
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      this.emit('send', { method, payload });
      if (method === 'Fetch.takeResponseBodyAsStream') {
        return { stream: `stream-${payload.requestId}` };
      }
      if (method === 'IO.read') {
        return { data: '', base64Encoded: false, eof: true };
      }
      return {};
    }

    waitFor(method, requestId) {
      const existing = this.calls.find(
        (call) => call.method === method && call.payload.requestId === requestId,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (call) => {
          if (call.method !== method || call.payload.requestId !== requestId) return;
          this.off('send', listener);
          resolve(call);
        };
        this.on('send', listener);
      });
    }

    async detach() {}
  }

  const origin = 'https://api.example.test';
  const policy = testBrowserPolicy({
    rule_id: 'beacon',
    phase: 'resource',
    origin,
    methods: ['POST'],
    route: { path: { kind: 'exact', value: '/beacon' }, query: { kind: 'none' } },
    resource_types: ['ping'],
    max_requests: 1,
    max_encoded_request_body_bytes: 64,
    max_encoded_response_bytes: 1024,
  });
  const cdp = new FakeCdp();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: testBrowserCapability(policy, origin),
    options: testBrowserOptions(new OriginSchedulerV1(), 1),
  });
  cdp.emit('Fetch.requestPaused', {
    requestId: 'beacon',
    request: {
      url: `${origin}/beacon`,
      method: 'POST',
      headers: {},
      hasPostData: true,
      postData: '{}',
    },
    resourceType: 'Ping',
  });
  await cdp.waitFor('Fetch.continueRequest', 'beacon');
  cdp.emit('Fetch.requestPaused', {
    requestId: 'beacon',
    request: {
      url: `${origin}/beacon`,
      method: 'POST',
      headers: {},
      hasPostData: true,
      postData: '{}',
    },
    resourceType: 'Ping',
    responseStatusCode: 204,
    responseHeaders: [],
  });
  await cdp.waitFor('Fetch.fulfillRequest', 'beacon');
  assert.equal(boundary.target_requests(), 1);
  boundary.assertHealthy();
  await boundary.close();
});

test('concurrent browser requests cannot oversubscribe signed request budgets', async () => {
  let settleResults;
  const results = [];
  const settled = new Promise((resolve) => {
    settleResults = resolve;
  });
  class FakeCdp extends EventEmitter {
    async send(method, payload = {}) {
      if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
        results.push({ method, request_id: payload.requestId });
        if (results.length === 2) settleResults();
      }
      return {};
    }

    async detach() {}
  }
  class BarrierScheduler {
    resolvers = [];

    async acquire() {
      return new Promise((resolve) => {
        this.resolvers.push(resolve);
        if (this.resolvers.length !== 2) return;
        for (const release of this.resolvers) {
          release({ release: () => undefined });
        }
      });
    }
  }
  const cdp = new FakeCdp();
  const policy = parseBrowserResourcePolicy(
    {
      egress_rules: [
        {
          rule_id: 'items',
          phase: 'resource',
          origin: 'https://api.example.test',
          methods: ['GET'],
          route: { path: { kind: 'exact', value: '/items' }, query: { kind: 'none' } },
          resource_types: ['fetch'],
          max_requests: 1,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
      ],
      max_requests_per_browser_task: 1,
      max_encoded_request_body_bytes_per_browser_task: 0,
      max_encoded_response_bytes_per_browser_task: 1024,
      max_proxy_wire_bytes_per_browser_task: 2048,
      max_single_request_body_bytes: 0,
      max_single_response_bytes: 1024,
      service_workers: 'block',
      downloads: 'block',
      popups: 'block',
      websockets: 'block',
      webtransport: 'block',
      webrtc_direct_egress: 'block',
      browser_cache: 'block',
    },
    'browser_resources',
  );
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: {
      browser_resources: policy,
      origin_traffic_policies: [
        {
          origin: 'https://api.example.test',
          max_concurrency: 2,
          requests_per_second: 100,
          burst: 2,
          min_delay_ms: 0,
          max_redirect_hops: 0,
          circuit_breaker: {
            transient_failure_threshold: 2,
            transient_window_ms: 1000,
            cooldown_ms: 1000,
          },
        },
      ],
    },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 1,
      scheduler: new BarrierScheduler(),
      signal: new AbortController().signal,
    },
  });
  for (const requestId of ['first', 'second']) {
    cdp.emit('Fetch.requestPaused', {
      requestId,
      request: {
        url: 'https://api.example.test/items',
        method: 'GET',
        hasPostData: false,
      },
      resourceType: 'Fetch',
    });
  }
  await settled;
  assert.deepEqual(results.map(({ method }) => method).sort(), [
    'Fetch.continueRequest',
    'Fetch.failRequest',
  ]);
  assert.equal(boundary.target_requests(), 1);
  assert.throws(
    () => boundary.assertHealthy(),
    (error) => error?.code === 'request_budget_exhausted',
  );
  await boundary.close();
});

test('scheduler-queued page-script traffic holds its scope and boundary policy', async () => {
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      this.emit('send', { method, payload });
      if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'body' };
      if (method === 'IO.read') return { data: '', base64Encoded: false, eof: true };
      return {};
    }

    waitFor(method, requestId) {
      const existing = this.calls.find(
        (call) => call.method === method && call.payload.requestId === requestId,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (call) => {
          if (call.method !== method || call.payload.requestId !== requestId) return;
          this.off('send', listener);
          resolve(call);
        };
        this.on('send', listener);
      });
    }

    async detach() {}
  }
  let releaseAdmission;
  let markQueued;
  const queued = new Promise((resolve) => {
    markQueued = resolve;
  });
  const scheduler = {
    acquire: async () =>
      new Promise((resolve) => {
        releaseAdmission = () => resolve({ release: () => undefined });
        markQueued();
      }),
  };
  const origin = 'https://api.example.test';
  const policy = testBrowserPolicy({
    rule_id: 'script_get',
    phase: 'page_script',
    origin,
    methods: ['GET'],
    route: { path: { kind: 'exact', value: '/items' }, query: { kind: 'none' } },
    resource_types: ['fetch'],
    max_requests: 1,
    max_encoded_request_body_bytes: 0,
    max_encoded_response_bytes: 1024,
  });
  const capability = testBrowserCapability(policy, origin);
  const options = testBrowserOptions(scheduler, 1);
  const cdp = new FakeCdp();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability,
    options,
  });
  const expectation = {
    wait: null,
    egress_rule_ids: ['script_get'],
    minimum_matching_requests: 1,
    maximum_matching_requests: 1,
  };
  const scope = boundary.beginPageScript(
    'script',
    expectation,
    {
      max_encoded_request_body_bytes_per_script: 0,
      max_single_request_body_bytes: 0,
      max_encoded_request_body_bytes_by_rule: { script_get: 0 },
    },
    origin,
  );
  cdp.emit('Fetch.requestPaused', {
    requestId: 'queued',
    request: {
      url: `${origin}/items`,
      method: 'GET',
      hasPostData: false,
    },
    resourceType: 'Fetch',
  });
  await queued;
  assert.throws(
    () => boundary.transition(capability, options),
    (error) => error?.code === 'transport_failure',
  );
  let finished = false;
  const finishing = boundary.finishPageScript(scope, expectation, options.signal).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  releaseAdmission();
  await cdp.waitFor('Fetch.continueRequest', 'queued');
  cdp.emit('Fetch.requestPaused', {
    requestId: 'queued',
    request: {
      url: `${origin}/items`,
      method: 'GET',
      hasPostData: false,
    },
    resourceType: 'Fetch',
    responseStatusCode: 200,
    responseHeaders: [],
  });
  await cdp.waitFor('Fetch.fulfillRequest', 'queued');
  await finishing;
  assert.equal(finished, true);
  boundary.assertHealthy();
  await boundary.close();
});

test('aborted page-script traffic cannot resume after scheduler admission', async () => {
  let releaseAdmission;
  let markQueued;
  let markTerminal;
  const queued = new Promise((resolve) => {
    markQueued = resolve;
  });
  const terminal = new Promise((resolve) => {
    markTerminal = resolve;
  });
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      if (method === 'Fetch.failRequest') markTerminal();
      return {};
    }

    async detach() {}
  }
  const scheduler = {
    acquire: async () =>
      new Promise((resolve) => {
        releaseAdmission = () => resolve({ release: () => undefined });
        markQueued();
      }),
  };
  const origin = 'https://api.example.test';
  const policy = testBrowserPolicy({
    rule_id: 'script_get',
    phase: 'page_script',
    origin,
    methods: ['GET'],
    route: { path: { kind: 'exact', value: '/items' }, query: { kind: 'none' } },
    resource_types: ['fetch'],
    max_requests: 1,
    max_encoded_request_body_bytes: 0,
    max_encoded_response_bytes: 1024,
  });
  const cdp = new FakeCdp();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: testBrowserCapability(policy, origin),
    options: testBrowserOptions(scheduler, 1),
  });
  const expectation = {
    wait: null,
    egress_rule_ids: ['script_get'],
    minimum_matching_requests: 0,
    maximum_matching_requests: 1,
  };
  const scope = boundary.beginPageScript(
    'script',
    expectation,
    {
      max_encoded_request_body_bytes_per_script: 0,
      max_single_request_body_bytes: 0,
      max_encoded_request_body_bytes_by_rule: { script_get: 0 },
    },
    origin,
  );
  cdp.emit('Fetch.requestPaused', {
    requestId: 'aborted',
    request: {
      url: `${origin}/items`,
      method: 'GET',
      hasPostData: false,
    },
    resourceType: 'Fetch',
  });
  await queued;
  boundary.abortPageScript(scope);
  releaseAdmission();
  await terminal;
  assert.equal(
    cdp.calls.some(
      (call) => call.method === 'Fetch.continueRequest' && call.payload.requestId === 'aborted',
    ),
    false,
  );
  assert.throws(
    () => boundary.assertHealthy(),
    (error) => error?.code === 'request_blocked',
  );
  await boundary.close();
});

test('parallel browser responses serialize against the whole-task byte budget', async () => {
  const reads = [];
  const terminals = [];
  class FakeCdp extends EventEmitter {
    async send(method, payload = {}) {
      if (method === 'Fetch.takeResponseBodyAsStream') {
        return { stream: `stream-${payload.requestId}` };
      }
      if (method === 'IO.read') {
        return new Promise((resolve) => {
          reads.push(resolve);
          this.emit('read');
        });
      }
      if (method === 'Fetch.fulfillRequest' || method === 'Fetch.failRequest') {
        terminals.push(method);
        this.emit('terminal');
      }
      return {};
    }

    waitForCount(event, values, count) {
      if (values.length >= count) return Promise.resolve();
      return new Promise((resolve) => {
        const listener = () => {
          if (values.length < count) return;
          this.off(event, listener);
          resolve();
        };
        this.on(event, listener);
      });
    }

    async detach() {}
  }
  const origin = 'https://api.example.test';
  const policy = testBrowserPolicy(
    {
      rule_id: 'items',
      phase: 'resource',
      origin,
      methods: ['GET'],
      route: { path: { kind: 'exact', value: '/items' }, query: { kind: 'none' } },
      resource_types: ['fetch'],
      max_requests: 2,
      max_encoded_request_body_bytes: 0,
      max_encoded_response_bytes: 5,
    },
    5,
  );
  const cdp = new FakeCdp();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: testBrowserCapability(policy, origin),
    options: testBrowserOptions(new OriginSchedulerV1(), 2),
  });
  for (const requestId of ['first', 'second']) {
    cdp.emit('Fetch.requestPaused', {
      requestId,
      request: {
        url: `${origin}/items`,
        method: 'GET',
        hasPostData: false,
      },
      resourceType: 'Fetch',
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  for (const requestId of ['first', 'second']) {
    cdp.emit('Fetch.requestPaused', {
      requestId,
      request: {
        url: `${origin}/items`,
        method: 'GET',
        hasPostData: false,
      },
      resourceType: 'Fetch',
      responseStatusCode: 200,
      responseHeaders: [],
    });
  }
  await cdp.waitForCount('read', reads, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 1);
  reads[0]({ data: '1234', base64Encoded: false, eof: true });
  await cdp.waitForCount('read', reads, 2);
  reads[1]({ data: '1234', base64Encoded: false, eof: true });
  await cdp.waitForCount('terminal', terminals, 2);
  assert.deepEqual(terminals.sort(), ['Fetch.failRequest', 'Fetch.fulfillRequest']);
  // The refusal names the rule whose bound was passed, structurally, so a
  // reviewer need not read it out of the message.
  assert.throws(
    () => boundary.assertHealthy(),
    (error) => {
      assert.equal(error?.code, 'response_too_large');
      assert.deepEqual(error.diagnostic, {
        kind: 'response_limit_exceeded',
        rule_id: 'items',
        phase: 'resource',
        origin,
        path: '/items',
        method: 'GET',
        limit_bytes: 1,
      });
      return true;
    },
  );
  await boundary.close();
});

test('public browser popup guard blocks about:blank navigation before target traffic', async () => {
  const hits = [];
  const target = http.createServer((request, response) => {
    hits.push(request.url);
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>guard fixture</title>');
  });
  await listen(target);
  const address = target.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const guard = await installPublicSinglePageGuard(context, page);
    await page.goto(`${origin}/main`);
    const popupOpened = context.waitForEvent('page');
    await page.evaluate((escapeUrl) => {
      const popup = window.open('about:blank');
      if (popup === null) throw new Error('fixture popup was not created');
      popup.location.href = escapeUrl;
    }, `${origin}/escape`);
    const popup = await popupOpened;
    if (!popup.isClosed()) await popup.close();
    assert.throws(
      () => guard.assertHealthy(),
      (error) => error?.code === 'request_blocked',
    );
    assert.deepEqual(hits, ['/main']);
  } finally {
    await context.close();
    await browser.close();
    await close(target);
  }
});

test('reviewed page programs use sealed pristine intrinsics and a host-side JSON cap', async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext();
  try {
    const runnerName = await installReviewedPageProgramRunner(context);
    const page = await context.newPage();
    await page.goto(
      'data:text/html,<script>globalThis.Function=()=>{throw new Error("main-world Function")};Object.getPrototypeOf=()=>null;JSON.parse=()=>({forged:true});globalThis.siteSigner=value=>"site:"+value</script>',
    );
    assert.deepEqual(
      await executeReviewedPageProgram(
        page,
        runnerName,
        'async (args) => ({ ok: true, value: window.siteSigner(args.value) })',
        { value: 'main-world' },
        { kind: 'object', required_keys: ['ok', 'value'] },
        256,
      ),
      { ok: true, value: 'site:main-world' },
    );
    await assert.rejects(
      () =>
        executeReviewedPageProgram(
          page,
          runnerName,
          'async () => { maximumBytes = Number.MAX_SAFE_INTEGER; return { value: "x".repeat(1024) }; }',
          {},
          { kind: 'object', required_keys: ['value'] },
          256,
        ),
      (error) => error?.code === 'response_too_large' && /signed byte ceiling/.test(error.message),
    );
    await assert.rejects(
      () =>
        executeReviewedPageProgram(
          page,
          runnerName,
          'async () => ({ ok: true })',
          {},
          { kind: 'object', required_keys: ['item', 'ok'] },
          256,
        ),
      (error) => error?.code === 'response_contract_mismatch',
    );
    await assert.rejects(
      () =>
        executeReviewedPageProgram(
          page,
          runnerName,
          'async () => []',
          {},
          { kind: 'object', required_keys: [] },
          256,
        ),
      (error) => error?.code === 'response_contract_mismatch',
    );
  } finally {
    await context.close();
    await browser.close();
  }

  const oversized = '{"value":"' + 'x'.repeat(256) + '"}';
  const fakePage = {
    async evaluate() {
      return { kind: 'success', encoded: oversized };
    },
  };
  await assert.rejects(
    () =>
      executeReviewedPageProgram(
        fakePage,
        'runner',
        'async () => ({})',
        {},
        { kind: 'object', required_keys: [] },
        64,
      ),
    (error) => error?.code === 'response_too_large',
  );
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function testBrowserPolicy(rule, responseBudget = rule.max_encoded_response_bytes) {
  return parseBrowserResourcePolicy(
    {
      egress_rules: [rule],
      max_requests_per_browser_task: rule.max_requests,
      max_encoded_request_body_bytes_per_browser_task:
        rule.max_encoded_request_body_bytes * rule.max_requests,
      max_encoded_response_bytes_per_browser_task: responseBudget,
      max_proxy_wire_bytes_per_browser_task: responseBudget + 4096,
      max_single_request_body_bytes: rule.max_encoded_request_body_bytes,
      max_single_response_bytes: rule.max_encoded_response_bytes,
      service_workers: 'block',
      downloads: 'block',
      popups: 'block',
      websockets: 'block',
      webtransport: 'block',
      webrtc_direct_egress: 'block',
      browser_cache: 'block',
    },
    'browser_resources',
  );
}

function testBrowserCapability(policy, origin) {
  return {
    browser_resources: policy,
    origin_traffic_policies: [
      {
        origin,
        max_concurrency: 2,
        requests_per_second: 100,
        burst: 2,
        min_delay_ms: 0,
        max_redirect_hops: 0,
        circuit_breaker: {
          transient_failure_threshold: 2,
          transient_window_ms: 1000,
          cooldown_ms: 1000,
        },
      },
    ],
  };
}

function testBrowserOptions(scheduler, maxTargetRequests) {
  return {
    input: {},
    bindings: {},
    timeout_ms: 1000,
    max_target_requests: maxTargetRequests,
    scheduler,
    signal: new AbortController().signal,
  };
}

function navigationOnlyCapability() {
  const policy = parseBrowserResourcePolicy(
    {
      egress_rules: [
        {
          rule_id: 'front_page_document',
          phase: 'navigation',
          origin: 'https://example.test',
          methods: ['GET'],
          route: { path: { kind: 'exact', value: '/news' }, query: { kind: 'none' } },
          resource_types: ['document'],
          max_requests: 1,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
      ],
      max_requests_per_browser_task: 1,
      max_encoded_request_body_bytes_per_browser_task: 0,
      max_encoded_response_bytes_per_browser_task: 1024,
      max_proxy_wire_bytes_per_browser_task: 2048,
      max_single_request_body_bytes: 0,
      max_single_response_bytes: 1024,
      service_workers: 'block',
      downloads: 'block',
      popups: 'block',
      websockets: 'block',
      webtransport: 'block',
      webrtc_direct_egress: 'block',
      browser_cache: 'block',
    },
    'browser_resources',
  );
  return {
    browser_resources: policy,
    origin_traffic_policies: [
      {
        origin: 'https://example.test',
        max_concurrency: 1,
        requests_per_second: 1,
        burst: 1,
        min_delay_ms: 0,
        max_redirect_hops: 0,
        circuit_breaker: {
          transient_failure_threshold: 1,
          transient_window_ms: 1000,
          cooldown_ms: 1000,
        },
      },
    ],
  };
}

test('an undeclared page sub-resource is refused without failing the task', async () => {
  const sent = [];
  class FakeCdp extends EventEmitter {
    async send(method, payload) {
      sent.push({ method, payload });
      return {};
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const context = { newCDPSession: async () => cdp, close: async () => undefined };
  const signal = new AbortController().signal;
  const boundary = await installBrowserNetworkBoundary({
    page: { context: () => context },
    capability: navigationOnlyCapability(),
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 1,
      scheduler: new OriginSchedulerV1(),
      signal,
    },
  });
  cdp.emit('Fetch.requestPaused', {
    requestId: 'stylesheet',
    request: { url: 'https://example.test/news.css?v=1', method: 'GET', hasPostData: false },
    resourceType: 'Stylesheet',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.filter((call) => call.method === 'Fetch.failRequest').map((call) => call.payload),
    [{ requestId: 'stylesheet', errorReason: 'BlockedByClient' }],
  );
  boundary.assertHealthy();
  assert.equal(boundary.denied_requests(), 1);
  cdp.emit('Fetch.requestPaused', {
    requestId: 'elsewhere',
    request: { url: 'https://example.test/other', method: 'GET', hasPostData: false },
    resourceType: 'Document',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => boundary.assertHealthy(),
    (error) => error?.code === 'request_blocked' && error.diagnostic?.phase === 'navigation',
  );
  await boundary.close();
});

test("the boundary answers only the pinned proxy's authentication challenge", async () => {
  const sent = [];
  class FakeCdp extends EventEmitter {
    async send(method, payload) {
      sent.push({ method, payload });
      return {};
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const context = { newCDPSession: async () => cdp, close: async () => undefined };
  const boundary = await installBrowserNetworkBoundary({
    page: { context: () => context },
    capability: navigationOnlyCapability(),
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 1,
      scheduler: new OriginSchedulerV1(),
      signal: new AbortController().signal,
    },
    proxy_auth: { username: 'pinned', password: 'secret' },
  });
  assert.equal(
    sent.find((call) => call.method === 'Fetch.enable')?.payload.handleAuthRequests,
    true,
  );
  cdp.emit('Fetch.authRequired', {
    requestId: 'proxy',
    authChallenge: { source: 'Proxy', origin: 'http://127.0.0.1:1', scheme: 'basic', realm: '' },
  });
  cdp.emit('Fetch.authRequired', {
    requestId: 'site',
    authChallenge: { source: 'Server', origin: 'https://example.test', scheme: 'basic', realm: '' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.filter((call) => call.method === 'Fetch.continueWithAuth').map((call) => call.payload),
    [
      {
        requestId: 'proxy',
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: 'pinned',
          password: 'secret',
        },
      },
      { requestId: 'site', authChallengeResponse: { response: 'CancelAuth' } },
    ],
  );
  await boundary.close();
});

test('a runtime request is matched as fetch whatever label the browser gives it', async () => {
  const sent = [];
  class FakeCdp extends EventEmitter {
    async send(method, payload) {
      sent.push({ method, payload });
      return {};
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const context = { newCDPSession: async () => cdp, close: async () => undefined };
  const signal = new AbortController().signal;
  const capability = runtimeRequestCapability();
  const boundary = await installBrowserNetworkBoundary({
    page: { context: () => context },
    capability,
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 2,
      scheduler: new OriginSchedulerV1(),
      signal,
    },
  });
  boundary.beginRuntimeRequest();
  cdp.emit('Fetch.requestPaused', {
    requestId: 'product',
    request: { url: 'https://example.test/dp/B000', method: 'GET', hasPostData: false },
    resourceType: 'XHR',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.filter((call) => call.method === 'Fetch.failRequest'),
    [],
  );
  assert.equal(
    sent.some(
      (call) => call.method === 'Fetch.continueRequest' && call.payload.requestId === 'product',
    ),
    true,
  );
  boundary.assertHealthy();
  await boundary.close();
});

function runtimeRequestCapability() {
  const base = navigationOnlyCapability();
  const policy = parseBrowserResourcePolicy(
    {
      egress_rules: [
        {
          rule_id: 'bootstrap',
          phase: 'navigation',
          origin: 'https://example.test',
          methods: ['GET'],
          route: { path: { kind: 'exact', value: '/' }, query: { kind: 'none' } },
          resource_types: ['document'],
          max_requests: 1,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
        {
          rule_id: 'product',
          phase: 'runtime_request',
          origin: 'https://example.test',
          methods: ['GET'],
          route: { path: { kind: 'prefix', value: '/dp/' }, query: { kind: 'none' } },
          resource_types: ['fetch'],
          max_requests: 1,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
      ],
      max_requests_per_browser_task: 2,
      max_encoded_request_body_bytes_per_browser_task: 0,
      max_encoded_response_bytes_per_browser_task: 2048,
      max_proxy_wire_bytes_per_browser_task: 4096,
      max_single_request_body_bytes: 0,
      max_single_response_bytes: 1024,
      service_workers: 'block',
      downloads: 'block',
      popups: 'block',
      websockets: 'block',
      webtransport: 'block',
      webrtc_direct_egress: 'block',
      browser_cache: 'block',
    },
    'browser_resources',
  );
  return { ...base, browser_resources: policy };
}

test('a document loaded by a sub-frame is a page resource, not a navigation', async () => {
  const sent = [];
  class FakeCdp extends EventEmitter {
    async send(method, payload) {
      sent.push({ method, payload });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      return {};
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const context = { newCDPSession: async () => cdp, close: async () => undefined };
  const signal = new AbortController().signal;
  const boundary = await installBrowserNetworkBoundary({
    page: { context: () => context },
    capability: navigationOnlyCapability(),
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 1,
      scheduler: new OriginSchedulerV1(),
      signal,
    },
  });
  cdp.emit('Fetch.requestPaused', {
    requestId: 'iframe',
    frameId: 'child',
    request: { url: 'https://ads.example.test/frame.html', method: 'GET', hasPostData: false },
    resourceType: 'Document',
  });
  await new Promise((resolve) => setImmediate(resolve));
  boundary.assertHealthy();
  assert.deepEqual(boundary.denied_resources(), [
    {
      url: 'https://ads.example.test/frame.html',
      method: 'GET',
      resource_type: 'document',
      cdp_resource_type: 'Document',
    },
  ]);
  cdp.emit('Fetch.requestPaused', {
    requestId: 'top',
    frameId: 'main',
    request: { url: 'https://example.test/other', method: 'GET', hasPostData: false },
    resourceType: 'Document',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => boundary.assertHealthy(),
    (error) => error?.code === 'request_blocked' && error.diagnostic?.phase === 'navigation',
  );
  await boundary.close();
});

// A fake CDP session that records every command and lets a test await the
// verdict on one request id, so admission (continueRequest) and refusal
// (failRequest) are both observable without timing assumptions.
class RecordingCdp extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.waiters = [];
  }

  async send(method, payload) {
    this.sent.push({ method, payload });
    for (const waiter of [...this.waiters]) {
      if (waiter.method === method && waiter.id === payload?.requestId) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(payload);
      }
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    return {};
  }

  waitFor(method, id) {
    const hit = this.sent.find((call) => call.method === method && call.payload?.requestId === id);
    if (hit) return Promise.resolve(hit.payload);
    return new Promise((resolve) => this.waiters.push({ method, id, resolve }));
  }

  async detach() {}
}

function pageScriptWithResourcesCapability() {
  const policy = parseBrowserResourcePolicy(
    {
      egress_rules: [
        {
          rule_id: 'program_api',
          phase: 'page_script',
          origin: 'https://example.test',
          methods: ['GET'],
          route: { path: { kind: 'exact', value: '/api' }, query: { kind: 'none' } },
          resource_types: ['fetch', 'xhr'],
          max_requests: 1,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
        {
          rule_id: 'app_scripts',
          phase: 'resource',
          origin: 'https://example.test',
          methods: ['GET'],
          route: { path: { kind: 'prefix', value: '/static/' }, query: { kind: 'none' } },
          resource_types: ['script'],
          max_requests: 2,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
      ],
      max_requests_per_browser_task: 4,
      max_encoded_request_body_bytes_per_browser_task: 0,
      max_encoded_response_bytes_per_browser_task: 4096,
      max_proxy_wire_bytes_per_browser_task: 8192,
      max_single_request_body_bytes: 0,
      max_single_response_bytes: 1024,
      service_workers: 'block',
      downloads: 'block',
      popups: 'block',
      websockets: 'block',
      webtransport: 'block',
      webrtc_direct_egress: 'block',
      browser_cache: 'block',
    },
    'browser_resources',
  );
  return { ...navigationOnlyCapability(), browser_resources: policy };
}

const PROGRAM_EXPECTATION = {
  wait: null,
  egress_rule_ids: ['program_api'],
  minimum_matching_requests: 0,
  maximum_matching_requests: 1,
};
const PROGRAM_BODY_LIMITS = {
  max_encoded_request_body_bytes_per_script: 0,
  max_single_request_body_bytes: 0,
  max_encoded_request_body_bytes_by_rule: { program_api: 0 },
};

async function boundaryWithProgram(cdp) {
  const signal = new AbortController().signal;
  const boundary = await installBrowserNetworkBoundary({
    page: { context: () => ({ newCDPSession: async () => cdp, close: async () => undefined }) },
    capability: pageScriptWithResourcesCapability(),
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 4,
      scheduler: new OriginSchedulerV1(),
      signal,
    },
  });
  return { boundary, signal };
}

test('the page loading itself during a reviewed program is judged as a resource, not as the program', async () => {
  const cdp = new RecordingCdp();
  const { boundary, signal } = await boundaryWithProgram(cdp);
  const scope = boundary.beginPageScript(
    'program',
    PROGRAM_EXPECTATION,
    PROGRAM_BODY_LIMITS,
    'https://example.test',
  );
  // A same-origin script the app loads while the program runs matches the
  // resource rule and is admitted.
  cdp.emit('Fetch.requestPaused', {
    requestId: 'app-js',
    frameId: 'main',
    request: { url: 'https://example.test/static/app.js', method: 'GET', hasPostData: false },
    resourceType: 'Script',
  });
  assert.deepEqual(await cdp.waitFor('Fetch.continueRequest', 'app-js'), { requestId: 'app-js' });
  boundary.assertHealthy();
  // An undeclared image is refused and recorded with the label Chromium gave it.
  cdp.emit('Fetch.requestPaused', {
    requestId: 'hero',
    frameId: 'main',
    request: { url: 'https://example.test/img/hero.png', method: 'GET', hasPostData: false },
    resourceType: 'Image',
  });
  assert.deepEqual(await cdp.waitFor('Fetch.failRequest', 'hero'), {
    requestId: 'hero',
    errorReason: 'BlockedByClient',
  });
  boundary.assertHealthy();
  assert.deepEqual(boundary.denied_resources(), [
    {
      url: 'https://example.test/img/hero.png',
      method: 'GET',
      resource_type: 'image',
      cdp_resource_type: 'Image',
    },
  ]);
  // A cross-origin xhr the app makes for a sprite is nothing a page_script rule
  // could admit, so it is the page's own loading too — refused quietly.
  cdp.emit('Fetch.requestPaused', {
    requestId: 'legend',
    frameId: 'main',
    request: { url: 'https://static.example.test/legend.png', method: 'GET', hasPostData: false },
    resourceType: 'XHR',
  });
  await cdp.waitFor('Fetch.failRequest', 'legend');
  boundary.assertHealthy();
  assert.equal(boundary.denied_resources().length, 2);
  // Neither request was the program's: the scope closes with zero matching
  // requests, inside its signed expectation.
  await boundary.finishPageScript(scope, PROGRAM_EXPECTATION, signal);
  // After the scope seals, the app's own loading is still refused quietly…
  cdp.emit('Fetch.requestPaused', {
    requestId: 'late-js',
    frameId: 'main',
    request: { url: 'https://example.test/static/late.js', method: 'GET', hasPostData: false },
    resourceType: 'Script',
  });
  await cdp.waitFor('Fetch.failRequest', 'late-js');
  boundary.assertHealthy();
  assert.equal(boundary.denied_resources().length, 3);
  // …while a fetch — the program's own kind of traffic — is a sealed-scope
  // violation that fails the task.
  cdp.emit('Fetch.requestPaused', {
    requestId: 'deferred',
    frameId: 'main',
    request: { url: 'https://example.test/api', method: 'GET', hasPostData: false },
    resourceType: 'Fetch',
  });
  await cdp.waitFor('Fetch.failRequest', 'deferred');
  assert.throws(
    () => boundary.assertHealthy(),
    (error) => error?.code === 'request_blocked' && error.diagnostic?.phase === 'page_script',
  );
  await boundary.close();
});

test('a reviewed program may not navigate its page or fetch outside its expectation', async () => {
  for (const [requestId, resourceType, url] of [
    ['navigate', 'Document', 'https://example.test/elsewhere'],
    ['sneak', 'Fetch', 'https://example.test/other'],
  ]) {
    const cdp = new RecordingCdp();
    const { boundary } = await boundaryWithProgram(cdp);
    boundary.beginPageScript(
      'program',
      PROGRAM_EXPECTATION,
      PROGRAM_BODY_LIMITS,
      'https://example.test',
    );
    cdp.emit('Fetch.requestPaused', {
      requestId,
      frameId: 'main',
      request: { url, method: 'GET', hasPostData: false },
      resourceType,
    });
    await cdp.waitFor('Fetch.failRequest', requestId);
    assert.throws(
      () => boundary.assertHealthy(),
      (error) =>
        error?.code === 'request_blocked' &&
        error.diagnostic?.kind === 'egress_rejected' &&
        error.diagnostic.phase === 'page_script',
      `${resourceType} during the program must fail the task`,
    );
    assert.deepEqual(boundary.denied_resources(), []);
    await boundary.close();
  }
});

test('a rejected page program result names what the page was refused before it was read', async () => {
  const denied = [
    {
      url: 'https://example.test/_/app.js',
      method: 'GET',
      resource_type: 'script',
      cdp_resource_type: 'Script',
    },
  ];
  const strategy = {
    strategy_id: 'program',
    url: { op: 'literal', value: 'https://example.test/item' },
    wait: { kind: 'dom_content_loaded' },
    interaction: null,
    program: {
      source: 'async () => ({})',
      arguments: { op: 'literal', value: null },
      result_shape: { kind: 'object', required_keys: ['title'] },
      expect: { wait: null, egress_rule_ids: [], minimum_matching_requests: 0, maximum_matching_requests: 0 },
      request_body_limits: {},
    },
  };
  const capability = {
    strategies: [strategy],
    authentication: { mode: 'none' },
    browser_resources: {},
    origin_traffic_policies: [],
    max_target_requests_per_call: 4,
    max_encoded_outcome_bytes: 1024,
    input_schema: parseJsonSchema({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    navigation_origins: ['https://example.test'],
  };
  // The page rendered nothing because its own code was refused, so the
  // program's result lacks the key its signed shape requires.
  const page = {
    goto: async () => ({}),
    url: () => 'https://example.test/item',
    evaluate: async () => ({ kind: 'failure', code: 'result_contract_mismatch' }),
  };
  const boundary = {
    transition: () => undefined,
    assertHealthy: () => undefined,
    beginPageScript: () => ({}),
    abortPageScript: () => undefined,
    target_requests: () => 1,
    denied_resources: () => denied,
  };
  await assert.rejects(
    executeBrowserPageScriptStrategyInBoundedPage(page, boundary, 'runner', capability, strategy, {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 4,
    }),
    (error) => {
      assert.equal(error?.code, 'response_contract_mismatch', String(error?.stack ?? error));
      assert.deepEqual(error.diagnostic, {
        kind: 'page_program_rejected',
        target_requests: 1,
        denied_resources: denied,
      });
      return true;
    },
  );
});

test('a browser deadline names the running stage and the resources the page was refused', () => {
  const { deadlineExpired } = require('../dist/consumer/execution/public-browser/deadline.js');
  const denied = [
    {
      url: 'https://example.test/x.js',
      method: 'GET',
      resource_type: 'script',
      cdp_resource_type: 'Script',
    },
    {
      url: 'https://example.test/search?tbm=map',
      method: 'GET',
      resource_type: '',
      cdp_resource_type: 'Other',
    },
  ];
  const error = deadlineExpired('browser page-script', 'program', 3, denied);
  assert.equal(error.code, 'request_timeout');
  assert.match(error.message, /deadline expired during program$/);
  assert.equal(error.target_requests, 3);
  assert.deepEqual(error.diagnostic, {
    kind: 'deadline_expired',
    stage: 'program',
    target_requests: 3,
    denied_resources: denied,
  });
  assert.notStrictEqual(error.diagnostic.denied_resources, denied, 'the diagnostic owns its copy');
});

test('the public browser launches as Chrome when installed and always names its identity', async () => {
  const {
    launchPublicBrowser,
    PUBLIC_BROWSER_PROFILE_V1,
  } = require('../dist/consumer/execution/public-browser/context.js');
  const {
    startPinnedEgressProxy,
  } = require('../dist/consumer/execution/public-browser/pinned-proxy.js');
  const proxy = await startPinnedEgressProxy({
    allowed_origins: ['https://example.test'],
    max_wire_bytes: 1024,
    connect_timeout_ms: 1000,
  });
  const launched = await launchPublicBrowser(proxy);
  try {
    assert.ok(['chrome', 'chromium'].includes(launched.identity), launched.identity);
    const context = await launched.browser.newContext(
      require('../dist/consumer/execution/public-browser/context.js').createPublicBrowserContextOptions(
        undefined,
        launched.user_agent,
      ),
    );
    const page = await context.newPage();
    assert.deepEqual(page.viewportSize(), PUBLIC_BROWSER_PROFILE_V1.viewport);
    const agent = await page.evaluate(() => navigator.userAgent);
    assert.match(agent, /Chrome\//, 'the public browser presents a Chrome engine');
    assert.doesNotMatch(agent, /HeadlessChrome/, 'the hidden window is not a product');
    assert.equal(
      await page.evaluate('navigator.webdriver'),
      false,
      'an ordinary Chrome does not announce automation',
    );
    await context.close();
  } finally {
    await launched.browser.close();
    await proxy.close();
  }
});

test("a same-origin xhr a resource rule admits is the page's own, not the program's", async () => {
  const cdp = new RecordingCdp();
  const base = pageScriptWithResourcesCapability();
  const policy = parseBrowserResourcePolicy(
    {
      ...base.browser_resources,
      egress_rules: [
        ...base.browser_resources.egress_rules,
        {
          rule_id: 'app_data',
          phase: 'resource',
          origin: 'https://example.test',
          methods: ['GET'],
          route: { path: { kind: 'prefix', value: '/data/' }, query: { kind: 'none' } },
          resource_types: ['fetch', 'xhr'],
          max_requests: 2,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
      ],
    },
    'browser_resources',
  );
  const signal = new AbortController().signal;
  const boundary = await installBrowserNetworkBoundary({
    page: { context: () => ({ newCDPSession: async () => cdp, close: async () => undefined }) },
    capability: { ...base, browser_resources: policy },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 4,
      scheduler: new OriginSchedulerV1(),
      signal,
    },
  });
  // The program declares that it issues nothing at all.
  const silent = {
    wait: null,
    egress_rule_ids: [],
    minimum_matching_requests: 0,
    maximum_matching_requests: 0,
  };
  const limits = {
    max_encoded_request_body_bytes_per_script: 0,
    max_single_request_body_bytes: 0,
    max_encoded_request_body_bytes_by_rule: {},
  };
  const scope = boundary.beginPageScript('program', silent, limits, 'https://example.test');
  cdp.emit('Fetch.requestPaused', {
    requestId: 'tiles',
    frameId: 'main',
    request: { url: 'https://example.test/data/tiles.json', method: 'GET', hasPostData: false },
    resourceType: 'XHR',
  });
  assert.deepEqual(await cdp.waitFor('Fetch.continueRequest', 'tiles'), { requestId: 'tiles' });
  boundary.assertHealthy();
  // Admitted under the resource rule, so the silent program's expectation still holds.
  await boundary.finishPageScript(scope, silent, signal);
  await boundary.close();
});

test('a redirect response is followed without a body and its chain is bounded by the origin policy', async () => {
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      this.emit('send', { method, payload });
      if (method === 'Fetch.takeResponseBodyAsStream') {
        return { stream: `stream-${payload.requestId}` };
      }
      if (method === 'IO.read') {
        return { data: '', base64Encoded: false, eof: true };
      }
      return {};
    }

    waitFor(method, requestId) {
      const existing = this.calls.find(
        (call) => call.method === method && call.payload.requestId === requestId,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (call) => {
          if (call.method !== method || call.payload.requestId !== requestId) return;
          this.off('send', listener);
          resolve(call);
        };
        this.on('send', listener);
      });
    }

    async detach() {}
  }
  const policy = parseBrowserResourcePolicy(
    {
      egress_rules: [
        {
          rule_id: 'pages',
          phase: 'navigation',
          origin: 'https://example.test',
          methods: ['GET'],
          route: { path: { kind: 'prefix', value: '/' }, query: { kind: 'none' } },
          resource_types: ['document'],
          max_requests: 4,
          max_encoded_request_body_bytes: 0,
          max_encoded_response_bytes: 1024,
        },
      ],
      max_requests_per_browser_task: 4,
      max_encoded_request_body_bytes_per_browser_task: 0,
      max_encoded_response_bytes_per_browser_task: 4096,
      max_proxy_wire_bytes_per_browser_task: 8192,
      max_single_request_body_bytes: 0,
      max_single_response_bytes: 1024,
      service_workers: 'block',
      downloads: 'block',
      popups: 'block',
      websockets: 'block',
      webtransport: 'block',
      webrtc_direct_egress: 'block',
      browser_cache: 'block',
    },
    'browser_resources',
  );
  const install = async (cdp, maxRedirectHops) =>
    await installBrowserNetworkBoundary({
      page: {
        context: () => ({
          newCDPSession: async () => cdp,
          close: async () => undefined,
        }),
      },
      capability: {
        browser_resources: policy,
        origin_traffic_policies: [
          {
            origin: 'https://example.test',
            max_concurrency: 1,
            requests_per_second: 100,
            burst: 1,
            min_delay_ms: 0,
            max_redirect_hops: maxRedirectHops,
            circuit_breaker: {
              transient_failure_threshold: 2,
              transient_window_ms: 1000,
              cooldown_ms: 1000,
            },
          },
        ],
      },
      options: {
        input: {},
        bindings: {},
        timeout_ms: 1000,
        max_target_requests: 4,
        scheduler: new OriginSchedulerV1(),
        signal: new AbortController().signal,
      },
    });
  const document = (requestId, url, response) => ({
    requestId,
    networkId: 'chain',
    request: { url, method: 'GET', hasPostData: false },
    resourceType: 'Document',
    ...(response ?? {}),
  });

  const cdp = new FakeCdp();
  const boundary = await install(cdp, 1);
  cdp.emit('Fetch.requestPaused', document('hop-0', 'https://example.test/start'));
  await cdp.waitFor('Fetch.continueRequest', 'hop-0');
  cdp.emit(
    'Fetch.requestPaused',
    document('hop-0', 'https://example.test/start', {
      responseStatusCode: 302,
      responseHeaders: [{ name: 'Location', value: 'https://example.test/landing' }],
    }),
  );
  await cdp.waitFor('Fetch.continueRequest', 'hop-0');
  assert.equal(
    cdp.calls.filter(
      (call) => call.method === 'Fetch.continueRequest' && call.payload.requestId === 'hop-0',
    ).length,
    2,
    'the redirect response is continued as-is',
  );
  assert.ok(!cdp.calls.some((call) => call.method === 'Fetch.takeResponseBodyAsStream'));
  cdp.emit('Fetch.requestPaused', document('hop-1', 'https://example.test/landing'));
  await cdp.waitFor('Fetch.continueRequest', 'hop-1');
  cdp.emit(
    'Fetch.requestPaused',
    document('hop-1', 'https://example.test/landing', {
      responseStatusCode: 200,
      responseHeaders: [],
    }),
  );
  await cdp.waitFor('Fetch.fulfillRequest', 'hop-1');
  assert.equal(boundary.target_requests(), 2, 'every hop is a request of its own');
  boundary.assertHealthy();
  await boundary.close();

  const strict = new FakeCdp();
  const bounded = await install(strict, 0);
  strict.emit('Fetch.requestPaused', document('only', 'https://example.test/start'));
  await strict.waitFor('Fetch.continueRequest', 'only');
  strict.emit(
    'Fetch.requestPaused',
    document('only', 'https://example.test/start', {
      responseStatusCode: 302,
      responseHeaders: [{ name: 'Location', value: 'https://example.test/landing' }],
    }),
  );
  await strict.waitFor('Fetch.failRequest', 'only');
  assert.throws(
    () => bounded.assertHealthy(),
    (error) =>
      error?.code === 'request_blocked' && /redirect limit is exhausted/.test(error.message),
  );
  await bounded.close();
});

test('a login-phase rule admits a request in any phase and undeclared sub-resources during an action are refused quietly', async () => {
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      this.emit('send', { method, payload });
      return {};
    }

    waitFor(method, requestId) {
      const existing = this.calls.find(
        (call) => call.method === method && call.payload.requestId === requestId,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (call) => {
          if (call.method !== method || call.payload.requestId !== requestId) return;
          this.off('send', listener);
          resolve(call);
        };
        this.on('send', listener);
      });
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const rule = {
    rule_id: 'consent_save',
    phase: 'login',
    origin: 'https://consent.example.test',
    methods: ['POST'],
    route: { path: { kind: 'exact', value: '/save' }, query: { kind: 'none' } },
    resource_types: ['document'],
    max_requests: 2,
    max_encoded_request_body_bytes: 1024,
    max_encoded_response_bytes: 1024,
  };
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: {
      browser_resources: {
        egress_rules: [rule],
        max_requests_per_browser_task: 4,
        max_encoded_request_body_bytes_per_browser_task: 1024,
        max_encoded_response_bytes_per_browser_task: 4096,
        max_proxy_wire_bytes_per_browser_task: 8192,
        max_single_request_body_bytes: 1024,
        max_single_response_bytes: 1024,
        service_workers: 'block',
        downloads: 'block',
        popups: 'block',
        websockets: 'block',
        webtransport: 'block',
        webrtc_direct_egress: 'block',
        browser_cache: 'block',
      },
      origin_traffic_policies: [
        {
          origin: 'https://consent.example.test',
          max_concurrency: 2,
          requests_per_second: 100,
          burst: 2,
          min_delay_ms: 0,
          max_redirect_hops: 0,
          circuit_breaker: {
            transient_failure_threshold: 2,
            transient_window_ms: 1000,
            cooldown_ms: 1000,
          },
        },
      ],
    },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 4,
      scheduler: new OriginSchedulerV1(),
      signal: new AbortController().signal,
    },
  });
  const scope = boundary.beginAction({
    action_id: 'accept',
    kind: 'click',
    target: { frame: { kind: 'main' }, selector: 'button', visible_only: true },
    expect: {
      wait: null,
      egress_rule_ids: ['consent_save'],
      minimum_matching_requests: 1,
      maximum_matching_requests: 1,
    },
  });
  cdp.emit('Fetch.requestPaused', {
    requestId: 'save',
    request: {
      url: 'https://consent.example.test/save',
      method: 'POST',
      headers: {},
      hasPostData: true,
      postData: 'set=1',
    },
    resourceType: 'Document',
  });
  await cdp.waitFor('Fetch.continueRequest', 'save');
  cdp.emit('Fetch.requestPaused', {
    requestId: 'beacon',
    request: {
      url: 'https://consent.example.test/log',
      method: 'GET',
      headers: {},
      hasPostData: false,
    },
    resourceType: 'Image',
  });
  const refused = await cdp.waitFor('Fetch.failRequest', 'beacon');
  assert.equal(refused.payload.errorReason, 'BlockedByClient');
  boundary.assertHealthy();
  assert.deepEqual(
    boundary.denied_resources().map((resource) => resource.url),
    ['https://consent.example.test/log'],
  );
  assert.equal(boundary.target_requests(), 1);
  boundary.abortAction(scope);
  await boundary.close();
});

test('a request still awaiting admission when its action is aborted is refused quietly', async () => {
  let resolveFailed;
  const failed = new Promise((resolve) => {
    resolveFailed = resolve;
  });
  class FakeCdp extends EventEmitter {
    async send(method, payload = {}) {
      if (method === 'Fetch.failRequest') resolveFailed(payload);
      return {};
    }

    async detach() {}
  }
  class HeldScheduler {
    release = null;

    async acquire() {
      return new Promise((resolve) => {
        this.release = () => resolve({ release: () => undefined });
      });
    }
  }
  const cdp = new FakeCdp();
  const scheduler = new HeldScheduler();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: {
      browser_resources: {
        egress_rules: [
          {
            rule_id: 'submit',
            phase: 'interaction',
            origin: 'https://example.test',
            methods: ['GET'],
            route: { path: { kind: 'exact', value: '/submit' }, query: { kind: 'none' } },
            resource_types: ['fetch'],
            max_requests: 1,
            max_encoded_request_body_bytes: 0,
            max_encoded_response_bytes: 1024,
          },
        ],
        max_requests_per_browser_task: 1,
        max_encoded_request_body_bytes_per_browser_task: 0,
        max_encoded_response_bytes_per_browser_task: 1024,
        max_proxy_wire_bytes_per_browser_task: 2048,
        max_single_request_body_bytes: 0,
        max_single_response_bytes: 1024,
        service_workers: 'block',
        downloads: 'block',
        popups: 'block',
        websockets: 'block',
        webtransport: 'block',
        webrtc_direct_egress: 'block',
        browser_cache: 'block',
      },
      origin_traffic_policies: [
        {
          origin: 'https://example.test',
          max_concurrency: 1,
          requests_per_second: 1,
          burst: 1,
          min_delay_ms: 0,
          max_redirect_hops: 0,
          circuit_breaker: {
            transient_failure_threshold: 1,
            transient_window_ms: 1000,
            cooldown_ms: 1000,
          },
        },
      ],
    },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 1,
      scheduler,
      signal: new AbortController().signal,
    },
  });
  const scope = boundary.beginAction({
    action_id: 'submit',
    kind: 'click',
    target: { frame: { kind: 'main' }, selector: 'button', visible_only: false },
    expect: {
      wait: null,
      egress_rule_ids: ['submit'],
      minimum_matching_requests: 0,
      maximum_matching_requests: 1,
    },
  });
  cdp.emit('Fetch.requestPaused', {
    requestId: 'late',
    request: { url: 'https://example.test/submit', method: 'GET', hasPostData: false },
    resourceType: 'Fetch',
  });
  while (scheduler.release === null) await new Promise((resolve) => setImmediate(resolve));
  boundary.abortAction(scope);
  scheduler.release();
  assert.deepEqual(await failed, { requestId: 'late', errorReason: 'BlockedByClient' });
  boundary.assertHealthy();
  assert.equal(boundary.target_requests(), 0);
  await boundary.close();
});

test('an action with a declared wait completes without waiting for the page to settle', async () => {
  const continued = [];
  let resolveContinued;
  const firstContinue = new Promise((resolve) => {
    resolveContinued = resolve;
  });
  class FakeCdp extends EventEmitter {
    async send(method, payload = {}) {
      if (method === 'Fetch.continueRequest') {
        continued.push(payload.requestId);
        resolveContinued(payload);
      }
      return {};
    }

    async detach() {}
  }
  class HeldScheduler {
    release = null;

    async acquire() {
      return new Promise((resolve) => {
        this.release = () => resolve({ release: () => undefined });
      });
    }
  }
  const cdp = new FakeCdp();
  const scheduler = new HeldScheduler();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: {
      browser_resources: {
        egress_rules: [
          {
            rule_id: 'pages',
            phase: 'login',
            origin: 'https://example.test',
            methods: ['GET'],
            route: { path: { kind: 'prefix', value: '/' }, query: { kind: 'none' } },
            resource_types: ['fetch'],
            max_requests: 4,
            max_encoded_request_body_bytes: 0,
            max_encoded_response_bytes: 1024,
          },
        ],
        max_requests_per_browser_task: 4,
        max_encoded_request_body_bytes_per_browser_task: 0,
        max_encoded_response_bytes_per_browser_task: 4096,
        max_proxy_wire_bytes_per_browser_task: 8192,
        max_single_request_body_bytes: 0,
        max_single_response_bytes: 1024,
        service_workers: 'block',
        downloads: 'block',
        popups: 'block',
        websockets: 'block',
        webtransport: 'block',
        webrtc_direct_egress: 'block',
        browser_cache: 'block',
      },
      origin_traffic_policies: [
        {
          origin: 'https://example.test',
          max_concurrency: 1,
          requests_per_second: 1,
          burst: 1,
          min_delay_ms: 0,
          max_redirect_hops: 0,
          circuit_breaker: {
            transient_failure_threshold: 1,
            transient_window_ms: 1000,
            cooldown_ms: 1000,
          },
        },
      ],
    },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 4,
      scheduler,
      signal: new AbortController().signal,
    },
  });
  const expect = {
    wait: { kind: 'selector', selector: 'main', state: 'attached', minimum_count: 1 },
    egress_rule_ids: ['pages'],
    minimum_matching_requests: 0,
    maximum_matching_requests: 4,
  };
  const scope = boundary.beginAction({
    action_id: 'accept',
    kind: 'click',
    target: { frame: { kind: 'main' }, selector: 'button', visible_only: false },
    expect,
  });
  cdp.emit('Fetch.requestPaused', {
    requestId: 'trailing',
    request: { url: 'https://example.test/data', method: 'GET', hasPostData: false },
    resourceType: 'Fetch',
  });
  while (scheduler.release === null) await new Promise((resolve) => setImmediate(resolve));
  await boundary.finishAction(scope, expect, new AbortController().signal);
  scheduler.release();
  await firstContinue;
  assert.deepEqual(continued, ['trailing'], 'traffic still in flight proceeds as the page’s own');
  boundary.assertHealthy();
  assert.equal(boundary.target_requests(), 1);
  await boundary.close();
});

test('a load Chromium cancels settles its admission so the boundary can go quiet', async () => {
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      this.emit('send', { method, payload });
      return {};
    }

    waitFor(method, requestId) {
      const existing = this.calls.find(
        (call) => call.method === method && call.payload.requestId === requestId,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (call) => {
          if (call.method !== method || call.payload.requestId !== requestId) return;
          this.off('send', listener);
          resolve(call);
        };
        this.on('send', listener);
      });
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: {
      browser_resources: {
        egress_rules: [
          {
            rule_id: 'pages',
            phase: 'navigation',
            origin: 'https://example.test',
            methods: ['GET'],
            route: { path: { kind: 'prefix', value: '/' }, query: { kind: 'none' } },
            resource_types: ['document'],
            max_requests: 2,
            max_encoded_request_body_bytes: 0,
            max_encoded_response_bytes: 1024,
          },
        ],
        max_requests_per_browser_task: 2,
        max_encoded_request_body_bytes_per_browser_task: 0,
        max_encoded_response_bytes_per_browser_task: 2048,
        max_proxy_wire_bytes_per_browser_task: 4096,
        max_single_request_body_bytes: 0,
        max_single_response_bytes: 1024,
        service_workers: 'block',
        downloads: 'block',
        popups: 'block',
        websockets: 'block',
        webtransport: 'block',
        webrtc_direct_egress: 'block',
        browser_cache: 'block',
      },
      origin_traffic_policies: [
        {
          origin: 'https://example.test',
          max_concurrency: 2,
          requests_per_second: 100,
          burst: 2,
          min_delay_ms: 0,
          max_redirect_hops: 0,
          circuit_breaker: {
            transient_failure_threshold: 2,
            transient_window_ms: 1000,
            cooldown_ms: 1000,
          },
        },
      ],
    },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 2,
      scheduler: new OriginSchedulerV1(),
      signal: new AbortController().signal,
    },
  });
  cdp.emit('Fetch.requestPaused', {
    requestId: 'interception-1',
    networkId: 'network-1',
    request: { url: 'https://example.test/slow', method: 'GET', hasPostData: false },
    resourceType: 'Document',
  });
  await cdp.waitFor('Fetch.continueRequest', 'interception-1');
  cdp.emit('Network.loadingFailed', {
    requestId: 'network-1',
    errorText: 'net::ERR_ABORTED',
    canceled: true,
  });
  await boundary.waitForQuiet(
    { kind: 'network_quiet', quiet_ms: 10, maximum_in_flight: 0 },
    AbortSignal.timeout(1000),
  );
  boundary.assertHealthy();
  assert.equal(boundary.target_requests(), 1, 'the request was sent and counts');
  await boundary.close();
});

test('traffic the page issues while a runtime request is open is refused quietly, not charged to the request', async () => {
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      this.emit('send', { method, payload });
      return {};
    }

    waitFor(method, requestId) {
      const existing = this.calls.find(
        (call) => call.method === method && call.payload.requestId === requestId,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (call) => {
          if (call.method !== method || call.payload.requestId !== requestId) return;
          this.off('send', listener);
          resolve(call);
        };
        this.on('send', listener);
      });
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: {
      browser_resources: {
        egress_rules: [
          {
            rule_id: 'product_page',
            phase: 'runtime_request',
            origin: 'https://shop.example.test',
            methods: ['GET'],
            route: { path: { kind: 'prefix', value: '/dp/' }, query: { kind: 'none' } },
            resource_types: ['fetch'],
            max_requests: 1,
            max_encoded_request_body_bytes: 0,
            max_encoded_response_bytes: 1024,
          },
        ],
        max_requests_per_browser_task: 2,
        max_encoded_request_body_bytes_per_browser_task: 0,
        max_encoded_response_bytes_per_browser_task: 2048,
        max_proxy_wire_bytes_per_browser_task: 4096,
        max_single_request_body_bytes: 0,
        max_single_response_bytes: 1024,
        service_workers: 'block',
        downloads: 'block',
        popups: 'block',
        websockets: 'block',
        webtransport: 'block',
        webrtc_direct_egress: 'block',
        browser_cache: 'block',
      },
      origin_traffic_policies: [
        {
          origin: 'https://shop.example.test',
          max_concurrency: 2,
          requests_per_second: 100,
          burst: 2,
          min_delay_ms: 0,
          max_redirect_hops: 0,
          circuit_breaker: {
            transient_failure_threshold: 2,
            transient_window_ms: 1000,
            cooldown_ms: 1000,
          },
        },
      ],
    },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 2,
      scheduler: new OriginSchedulerV1(),
      signal: new AbortController().signal,
    },
  });
  const scope = boundary.beginRuntimeRequest();
  cdp.emit('Fetch.requestPaused', {
    requestId: 'favicon',
    request: { url: 'https://shop.example.test/favicon.ico', method: 'GET', hasPostData: false },
    resourceType: 'Other',
  });
  const refused = await cdp.waitFor('Fetch.failRequest', 'favicon');
  assert.equal(refused.payload.errorReason, 'BlockedByClient');
  boundary.assertHealthy();
  cdp.emit('Fetch.requestPaused', {
    requestId: 'product',
    request: { url: 'https://shop.example.test/dp/B000', method: 'GET', hasPostData: false },
    resourceType: 'Fetch',
  });
  await cdp.waitFor('Fetch.continueRequest', 'product');
  assert.equal(boundary.target_requests(), 1, 'only the runtime request counts');
  assert.deepEqual(
    boundary.denied_resources().map((resource) => resource.url),
    ['https://shop.example.test/favicon.ico'],
  );
  boundary.abortRuntimeRequest(scope);
  await boundary.close();
});

test('a navigation Chromium restarts under the same network id does not wait on its own first attempt', async () => {
  class FakeCdp extends EventEmitter {
    calls = [];

    async send(method, payload = {}) {
      this.calls.push({ method, payload });
      this.emit('send', { method, payload });
      if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 's' };
      if (method === 'IO.read') return { data: '', base64Encoded: false, eof: true };
      return {};
    }

    waitFor(method, requestId) {
      const existing = this.calls.find(
        (call) => call.method === method && call.payload.requestId === requestId,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (call) => {
          if (call.method !== method || call.payload.requestId !== requestId) return;
          this.off('send', listener);
          resolve(call);
        };
        this.on('send', listener);
      });
    }

    async detach() {}
  }
  const cdp = new FakeCdp();
  const boundary = await installBrowserNetworkBoundary({
    page: {
      context: () => ({
        newCDPSession: async () => cdp,
        close: async () => undefined,
      }),
    },
    capability: {
      browser_resources: {
        egress_rules: [
          {
            rule_id: 'search',
            phase: 'navigation',
            origin: 'https://example.test',
            methods: ['GET'],
            route: { path: { kind: 'exact', value: '/search' }, query: { kind: 'none' } },
            resource_types: ['document'],
            max_requests: 3,
            max_encoded_request_body_bytes: 0,
            max_encoded_response_bytes: 1024,
          },
        ],
        max_requests_per_browser_task: 3,
        max_encoded_request_body_bytes_per_browser_task: 0,
        max_encoded_response_bytes_per_browser_task: 4096,
        max_proxy_wire_bytes_per_browser_task: 8192,
        max_single_request_body_bytes: 0,
        max_single_response_bytes: 1024,
        service_workers: 'block',
        downloads: 'block',
        popups: 'block',
        websockets: 'block',
        webtransport: 'block',
        webrtc_direct_egress: 'block',
        browser_cache: 'block',
      },
      origin_traffic_policies: [
        {
          origin: 'https://example.test',
          max_concurrency: 1,
          requests_per_second: 100,
          burst: 2,
          min_delay_ms: 0,
          max_redirect_hops: 0,
          circuit_breaker: {
            transient_failure_threshold: 2,
            transient_window_ms: 1000,
            cooldown_ms: 1000,
          },
        },
      ],
    },
    options: {
      input: {},
      bindings: {},
      timeout_ms: 1000,
      max_target_requests: 3,
      scheduler: new OriginSchedulerV1(),
      signal: new AbortController().signal,
    },
  });
  const attempt = (requestId, response) => ({
    requestId,
    networkId: 'navigation-1',
    request: { url: 'https://example.test/search', method: 'GET', hasPostData: false },
    resourceType: 'Document',
    ...(response ?? {}),
  });
  cdp.emit('Fetch.requestPaused', attempt('first'));
  await cdp.waitFor('Fetch.continueRequest', 'first');
  // The restart arrives with no response ever paused for the first attempt.
  cdp.emit('Fetch.requestPaused', attempt('restart'));
  await cdp.waitFor('Fetch.continueRequest', 'restart');
  cdp.emit(
    'Fetch.requestPaused',
    attempt('restart', { responseStatusCode: 200, responseHeaders: [] }),
  );
  await cdp.waitFor('Fetch.fulfillRequest', 'restart');
  await boundary.waitForQuiet(
    { kind: 'network_quiet', quiet_ms: 10, maximum_in_flight: 0 },
    AbortSignal.timeout(1000),
  );
  assert.equal(boundary.target_requests(), 2, 'both attempts were sent and both count');
  boundary.assertHealthy();
  await boundary.close();
});
