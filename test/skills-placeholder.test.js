// Unit tests for validatePlaceholderReferences — catches hallucinated
// {{X}} refs at save time. Every field the executor interpolates through
// must be covered here so the agent never saves a strategy with an
// unresolvable placeholder.

import test from 'node:test';
import assert from 'node:assert';
import { validatePlaceholderReferences } from '../dist/strategies/skills.js';

function expectReject(data, matcher) {
  assert.throws(
    () => validatePlaceholderReferences(data),
    (err) => {
      assert.match(err.message, /^invalid_strategy: placeholder/);
      if (matcher instanceof RegExp) assert.match(err.message, matcher);
      else if (typeof matcher === 'string') assert.ok(err.message.includes(matcher));
      return true;
    },
  );
}

// ---- declared param refs ----

test('notes.params refs are accepted', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/users/{{user_id}}',
    notes: { params: { user_id: { kind: 'string', example: '123' } } },
  };
  validatePlaceholderReferences(data);
});

test('undeclared top-level ref is rejected and lists available', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/users/{{user_id}}',
    notes: { params: { username: { kind: 'string', example: 'alice' } } },
  };
  expectReject(data, /\{\{user_id\}\}/);
  expectReject(data, /\{\{username\}\}/);
});

// ---- generator refs ----

test('{{__gen.X}} where X is declared passes', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    headers: { 'X-Request-Id': '{{__gen.reqId}}' },
    generated: { reqId: { code: 'return Date.now()' } },
  };
  validatePlaceholderReferences(data);
});

test('{{__gen.X}} where X is missing is rejected', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    headers: { 'X-Request-Id': '{{__gen.reqId}}' },
    generated: {},
  };
  expectReject(data, /\{\{__gen\.reqId\}\}/);
});

test('{{__prereq.X}} is always rejected (no such prefix exists)', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    headers: { 'X-Fetch-Nonce': '{{__prereq.fetchNonce}}' },
    prerequisites: [
      {
        name: 'fetchNonce',
        kind: 'page-extract',
        url: 'https://example.com',
        vars: { fetchNonce: { selector: 'meta[name=nonce]', attr: 'content' } },
      },
    ],
  };
  expectReject(data, /\{\{__prereq\.fetchNonce\}\}/);
  expectReject(data, /\{\{__prereq\.X\}\}/);
});

// ---- prereq-declared refs ----

test('fetch-extract vars become declared refs', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/graphql',
    body: { variables: { input: { repositoryId: '{{repositoryId}}' } } },
    prerequisites: [
      {
        name: 'resolve_repo',
        kind: 'fetch-extract',
        url: 'https://api.github.com/repos/{{owner}}/{{repo}}',
        vars: { repositoryId: 'node_id' },
      },
    ],
    notes: {
      params: {
        owner: { kind: 'slug', example: 'klura-ai' },
        repo: { kind: 'slug', example: 'scratch' },
      },
    },
  };
  validatePlaceholderReferences(data);
});

test('page-extract vars become declared refs', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/graphql',
    headers: { 'X-Fetch-Nonce': '{{fetchNonce}}', 'X-Client': '{{clientVersion}}' },
    prerequisites: [
      {
        name: 'extractNonce',
        kind: 'page-extract',
        url: 'https://example.com',
        vars: {
          fetchNonce: { selector: 'meta[name=nonce]', attr: 'content' },
          clientVersion: { selector: 'meta[name=client-version]', attr: 'content' },
        },
      },
    ],
  };
  validatePlaceholderReferences(data);
});

test('browser-step as fields become declared refs', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    headers: { 'X-Token': '{{extractedToken}}' },
    prerequisites: [
      {
        name: 'grabToken',
        kind: 'browser',
        steps: [
          { action: 'navigate', url: 'https://example.com' },
          { action: 'extract', selector: '#token', attr: 'value', as: 'extractedToken' },
        ],
      },
    ],
  };
  validatePlaceholderReferences(data);
});

test('browser-step url/value/selector refs are checked', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    prerequisites: [
      {
        name: 'grabToken',
        kind: 'browser',
        steps: [
          { action: 'navigate', url: 'https://example.com/users/{{user_id}}' },
          { action: 'type', selector: '#composer-{{user_id}}', value: '{{missing_text}}' },
        ],
      },
    ],
    notes: {
      params: {
        user_id: { kind: 'string', example: '42' },
      },
    },
  };
  expectReject(data, /\{\{missing_text\}\}/);
});

test("browser prereq's own name is NOT a declared ref unless a step extracts to it", () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    headers: { 'X-Token': '{{grabToken}}' },
    prerequisites: [
      {
        name: 'grabToken',
        kind: 'browser',
        steps: [
          { action: 'navigate', url: 'https://example.com' },
          { action: 'extract', selector: '#token', attr: 'value', as: 'extractedToken' },
        ],
      },
    ],
  };
  expectReject(data, /\{\{grabToken\}\}/);
});

test("cached prereq's own name becomes a declared ref", () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    headers: { 'X-Cached-Token': '{{myCachedToken}}' },
    prerequisites: [{ name: 'myCachedToken', kind: 'cached', key: 'auth:token' }],
  };
  validatePlaceholderReferences(data);
});

test('capability vars becomes a declared ref', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/messages/{{thread_id}}',
    prerequisites: [
      {
        name: 'resolveThread',
        kind: 'capability',
        capability: 'lookup_thread_by_name',
        args: { name: '{{recipient}}' },
        vars: { thread_id: 'results.0.id' },
      },
    ],
    notes: {
      params: {
        recipient: { kind: 'text', example: 'alice' },
      },
    },
  };
  validatePlaceholderReferences(data);
});

test('js-eval binds becomes a declared ref', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/submit',
    headers: { 'X-Page-Token': '{{pageToken}}' },
    prerequisites: [
      {
        name: 'mintPageToken',
        kind: 'js-eval',
        url: 'https://example.com/new',
        expression: 'await window.x.mint()',
        binds: 'pageToken',
        return_shape: { kind: 'string' },
      },
    ],
  };
  validatePlaceholderReferences(data);
});

test('fetch-extract headers_map and fetch_body refs are checked', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'fetch-extract',
        url: 'https://api.example.com/search?q={{query}}',
        headers_map: { Authorization: 'Bearer {{api_token}}' },
        fetch_body: { filter: '{{missing_filter}}' },
        vars: { resultId: 'data.id' },
      },
    ],
    notes: {
      params: {
        query: { kind: 'text', example: 'alice' },
        api_token: { kind: 'text', example: 'tok_123' },
      },
    },
  };
  expectReject(data, /\{\{missing_filter\}\}/);
});

test('capability prereq args refs are checked', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/messages/{{thread_id}}',
    prerequisites: [
      {
        name: 'resolveThread',
        kind: 'capability',
        capability: 'lookup_thread_by_name',
        args: { name: '{{recipient}}', workspace: '{{missing_workspace}}' },
        vars: { thread_id: 'results.0.id' },
      },
    ],
    notes: {
      params: {
        recipient: { kind: 'text', example: 'alice' },
      },
    },
  };
  expectReject(data, /\{\{missing_workspace\}\}/);
});

// ---- nested scans ----

test('refs inside nested body objects are checked', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/x',
    body: {
      variables: { input: { userId: '{{user_id}}', nestedList: ['{{missing_param}}'] } },
    },
    notes: { params: { user_id: { kind: 'string', example: '1' } } },
  };
  expectReject(data, /\{\{missing_param\}\}/);
});

test('refs inside params/headers/prereq.url are checked', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/graphql',
    params: { limit: '{{page_size}}' },
    prerequisites: [
      {
        name: 'nonce',
        kind: 'page-extract',
        url: 'https://example.com/{{user_id}}',
        vars: { nonce: { selector: 'meta', attr: 'content' } },
      },
    ],
    notes: { params: { user_id: { kind: 'string', example: '1' } } },
  };
  expectReject(data, /\{\{page_size\}\}/);
});

test('recorded-path steps refs are checked', () => {
  const data = {
    strategy: 'recorded-path',
    steps: [{ action: 'type', selector: '#composer', value: '{{missing_text}}' }],
    notes: { params: { text: { kind: 'text', example: 'hello' } } },
  };
  expectReject(data, /\{\{missing_text\}\}/);
});

test('recorded-path steps accept interrupt binds tokens', () => {
  const data = {
    strategy: 'recorded-path',
    steps: [{ action: 'type', selector: '#otp', value: '{{otp_code}}' }],
    interrupts: [
      {
        name: 'assist',
        at: 'pre_execution',
        handler: {
          kind: 'user-assist',
          message: 'Please solve the challenge',
          binds: 'otp_code',
        },
      },
    ],
  };
  validatePlaceholderReferences(data);
});

test('wsOpen steps refs are checked', () => {
  const data = {
    strategy: 'page-script',
    protocol: 'websocket',
    origin: 'https://example.com/chat',
    wsUrl: 'wss://example.com/ws',
    frame: '{{text}}',
    wsOpen: {
      steps: [{ action: 'click', selector: '[data-room="{{missing_room}}"]' }],
    },
    notes: { params: { text: { kind: 'text', example: 'hello' } } },
  };
  expectReject(data, /\{\{missing_room\}\}/);
});

test('websocket frame does not accept __gen placeholders', () => {
  const data = {
    strategy: 'fetch',
    protocol: 'websocket',
    wsUrl: 'wss://example.com/ws',
    frame: '{{__gen.reqId}}',
    generated: { reqId: { code: 'return "x"' } },
  };
  expectReject(data, /frame/);
});

// ---- no-op cases ----

test('strategies without any placeholders pass trivially', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/health',
    method: 'GET',
  };
  validatePlaceholderReferences(data);
});

test('generators key passes when referenced alongside params', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/users/{{user_id}}',
    headers: { 'X-Request-Id': '{{__gen.reqId}}' },
    generated: { reqId: { code: 'return "x"' } },
    notes: { params: { user_id: { kind: 'string', example: '1' } } },
  };
  validatePlaceholderReferences(data);
});

test('error message lists all available placeholders', () => {
  const data = {
    strategy: 'fetch',
    endpoint: 'https://api.example.com/{{bogus}}',
    generated: { reqId: { code: 'return 1' } },
    notes: { params: { user_id: { kind: 'string', example: '1' } } },
    prerequisites: [
      {
        name: 'p',
        kind: 'page-extract',
        url: 'https://example.com',
        vars: { nonce: { selector: 'meta', attr: 'content' } },
      },
    ],
  };
  assert.throws(
    () => validatePlaceholderReferences(data),
    (err) => {
      assert.ok(err.message.includes('{{__gen.reqId}}'));
      assert.ok(err.message.includes('{{user_id}}'));
      assert.ok(err.message.includes('{{nonce}}'));
      assert.ok(!err.message.includes('{{p}}'));
      return true;
    },
  );
});
