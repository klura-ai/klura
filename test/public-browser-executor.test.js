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
  const scope = boundary.beginPageScript('script', expectation, {
    max_encoded_request_body_bytes_per_script: 0,
    max_single_request_body_bytes: 0,
    max_encoded_request_body_bytes_by_rule: { script_request: 0 },
  });
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
  assert.deepEqual(
    results.map(({ method }) => method).sort(),
    ['Fetch.continueRequest', 'Fetch.failRequest'],
  );
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
  const scope = boundary.beginPageScript('script', expectation, {
    max_encoded_request_body_bytes_per_script: 0,
    max_single_request_body_bytes: 0,
    max_encoded_request_body_bytes_by_rule: { script_get: 0 },
  });
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
  const scope = boundary.beginPageScript('script', expectation, {
    max_encoded_request_body_bytes_per_script: 0,
    max_single_request_body_bytes: 0,
    max_encoded_request_body_bytes_by_rule: { script_get: 0 },
  });
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
      (call) =>
        call.method === 'Fetch.continueRequest' && call.payload.requestId === 'aborted',
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
  assert.throws(
    () => boundary.assertHealthy(),
    (error) => error?.code === 'response_too_large',
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
