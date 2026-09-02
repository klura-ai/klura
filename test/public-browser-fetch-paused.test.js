import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBrowserFetchPaused,
} = require('../dist/consumer/execution/public-browser/fetch-paused.js');

function pausedRequest(overrides = {}) {
  const { request: requestOverrides = {}, ...eventOverrides } = overrides;
  return {
    requestId: 'request-1',
    request: {
      url: 'https://api.example.test/items',
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
      hasPostData: false,
      ...requestOverrides,
    },
    resourceType: 'Preflight',
    ...eventOverrides,
  };
}

test('CDP preflight parsing preserves the exact requested method and resource type', () => {
  const parsed = parseBrowserFetchPaused(pausedRequest());
  assert.equal(parsed?.resource_type, 'preflight');
  assert.equal(parsed?.preflight_method, 'POST');
  assert.equal(parsed?.request_body.has_post_data, false);
});

test('CDP Ping normalizes to ping while Other and unknown beacon labels remain blocked', () => {
  const request = {
    request: {
      method: 'POST',
      headers: {},
      hasPostData: false,
    },
  };
  assert.equal(
    parseBrowserFetchPaused(pausedRequest({ ...request, resourceType: 'Ping' }))?.resource_type,
    'ping',
  );
  for (const resourceType of ['Other', 'Beacon']) {
    assert.equal(
      parseBrowserFetchPaused(pausedRequest({ ...request, resourceType }))?.resource_type,
      '',
    );
  }
});

test('CDP preflight parsing rejects missing or ambiguous requested-method headers', () => {
  assert.equal(
    parseBrowserFetchPaused(
      pausedRequest({ request: { headers: {}, hasPostData: false } }),
    )?.preflight_method,
    null,
  );
  assert.equal(
    parseBrowserFetchPaused(
      pausedRequest({
        request: {
          headers: {
            'Access-Control-Request-Method': 'POST',
            'access-control-request-method': 'POST',
          },
          hasPostData: false,
        },
      }),
    )?.preflight_method,
    null,
  );
  assert.equal(
    parseBrowserFetchPaused(
      pausedRequest({
        request: {
          method: 'GET',
          headers: { 'Access-Control-Request-Method': 'POST' },
          hasPostData: false,
        },
        resourceType: 'Fetch',
      }),
    )?.preflight_method,
    null,
  );
});
