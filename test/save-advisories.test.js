// Save-time advisory (soft warning) behaviour — runtime_meta.save_warnings[].
// The runtime attaches structural signals to the strategy JSON body at save
// time; validation already passed, but a pattern is worth flagging so the
// NEXT session's agent reads it via list_platform_skills / get_strategy and can fix
// it. "Context via skill body" — no return-shape change, no runtime state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  detectSessionScopedIdExtraction,
  detectNameIdMismatch,
  detectPrereqBindKeyMismatch,
} = await import('../dist/gate/index.js');
const { setDeclaredArgsProvider, setCapturedRequestsProvider } = await import(
  '../dist/strategies/validate.js'
);

test.afterEach(() => {
  setDeclaredArgsProvider(null);
  setCapturedRequestsProvider(null);
});

test('detectSessionScopedIdExtraction: flags frameFromPage reading window.location.pathname + .match()', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    baseUrl: 'https://example.com/',
    wsUrl: 'wss://example.com/s',
    frameFromPage: {
      expression:
        "(()=>{ const id = window.location.pathname.match(/\\/t\\/(\\d+)/)?.[1]; return id; })()",
      returns: 'hex',
    },
  };
  const warnings = detectSessionScopedIdExtraction(strategy);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'unparametrized_session_id');
  assert.match(warnings[0].message, /frameFromPage\.expression/);
  assert.match(warnings[0].message, /window\.location\.pathname/);
  assert.match(warnings[0].hint, /capability-prereq/);
});

test('detectSessionScopedIdExtraction: flags document.cookie + .split()', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    baseUrl: 'https://example.com/',
    wsUrl: 'wss://example.com/s',
    prerequisites: [
      {
        name: 'session_id',
        kind: 'js-eval',
        expression:
          "(()=>{ const raw = document.cookie.split('sid=')[1]; return raw; })()",
      },
    ],
  };
  const warnings = detectSessionScopedIdExtraction(strategy);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /prerequisites\[0\]\.expression/);
  assert.match(warnings[0].message, /document\.cookie/);
});

test('detectSessionScopedIdExtraction: no warning when expression only reads args.*', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    baseUrl: 'https://example.com/',
    wsUrl: 'wss://example.com/s',
    frameFromPage: {
      expression:
        "(()=>{ const text = args.text; const threadId = args.thread_id; return text + threadId; })()",
      returns: 'hex',
    },
  };
  assert.deepEqual(detectSessionScopedIdExtraction(strategy), []);
});

test('detectSessionScopedIdExtraction: no warning when a capability-method prereq is present (lookup chained)', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    baseUrl: 'https://example.com/',
    wsUrl: 'wss://example.com/s',
    prerequisites: [
      { name: 'thread_id', kind: 'capability', capability: 'lookup_thread_by_name', args: { name: '{{recipient}}' } },
    ],
    frameFromPage: {
      // Still reads pathname, but because the caller chains a lookup the
      // id is presumed to land via the capability-bound placeholder.
      expression:
        "(()=>{ const id = window.location.pathname.match(/\\/t\\/(\\d+)/)?.[1]; return id; })()",
      returns: 'hex',
    },
  };
  assert.deepEqual(detectSessionScopedIdExtraction(strategy), []);
});

test('detectSessionScopedIdExtraction: no warning for session-state read WITHOUT id-extraction shape', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    baseUrl: 'https://example.com/',
    wsUrl: 'wss://example.com/s',
    frameFromPage: {
      // Reads pathname but doesn't run match/split/substring — no id being
      // extracted, just a raw string dump.
      expression:
        "(()=>{ return window.location.pathname; })()",
      returns: 'hex',
    },
  };
  assert.deepEqual(detectSessionScopedIdExtraction(strategy), []);
});

test('detectSessionScopedIdExtraction: no warning when there are no expression bodies at all', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/send',
    method: 'POST',
    contentType: 'json',
    body: { text: '{{text}}' },
  };
  assert.deepEqual(detectSessionScopedIdExtraction(strategy), []);
});

test('detectNameIdMismatch: no warning when capability prereq binds the id via vars', () => {
  setDeclaredArgsProvider(() => ({ recipient: 'alice' }));
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages/{{thread_id}}',
    prerequisites: [
      {
        name: 'resolve_thread',
        kind: 'capability',
        capability: 'lookup_thread_by_name',
        args: { name: '{{recipient}}' },
        vars: { thread_id: 'results.0.id' },
      },
    ],
    notes: {
      params: {
        thread_id: {
          description: 'resolved thread id',
          kind: 'id',
          example: '156025504001094',
        },
      },
    },
  };

  assert.deepEqual(detectNameIdMismatch(strategy, 'sess-bind-as-ok'), []);
});

test('detectNameIdMismatch: no warning when a non-capability prereq binds the id', () => {
  setDeclaredArgsProvider(() => ({ recipient: 'alice' }));
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages/{{thread_id}}',
    prerequisites: [
      {
        name: 'mint_thread',
        kind: 'js-eval',
        url: 'https://api.example.com/compose',
        expression: "'156025504001094'",
        binds: 'thread_id',
        return_shape: { kind: 'string', min_length: 1 },
      },
    ],
    notes: {
      params: {
        thread_id: {
          description: 'resolved thread id',
          kind: 'id',
          example: '156025504001094',
        },
      },
    },
  };

  assert.deepEqual(detectNameIdMismatch(strategy, 'sess-any-prereq-ok'), []);
});

test('detectNameIdMismatch: warning hint uses vars for capability prereqs', () => {
  setDeclaredArgsProvider(() => ({ recipient: 'alice' }));
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages/{{thread_id}}',
    notes: {
      params: {
        thread_id: {
          description: 'resolved thread id',
          kind: 'id',
          example: '156025504001094',
        },
      },
    },
  };

  const warnings = detectNameIdMismatch(strategy, 'sess-binds-hint');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /no prereq binds to thread_id/);
  assert.match(warnings[0].hint, /vars:\{"thread_id"/);
});

// ---------------------------------------------------------------------------
// detectPrereqBindKeyMismatch — prereq binds "X" but the captured XHR's query
// (or body / header) uses "Y" instead. Warm execute would send the value
// under X (ignored) and omit Y (required).
// ---------------------------------------------------------------------------

test('detectPrereqBindKeyMismatch: flags query-key mismatch and suggests the wire name', () => {
  setCapturedRequestsProvider(() => [
    {
      method: 'GET',
      url: 'https://api.example.com/messages?thread_id=156025504001094&limit=20',
      headers: {},
      postData: null,
      status: 200,
      responseBody: '',
    },
  ]);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages?thread_id={{threadId}}&limit=20',
    method: 'GET',
    prerequisites: [
      {
        name: 'resolve_thread',
        kind: 'capability',
        capability: 'lookup_thread_by_name',
        args: { name: '{{recipient}}' },
        binds: 'threadId',
      },
    ],
  };
  const warnings = detectPrereqBindKeyMismatch(strategy, 'sess-bind-key-mismatch');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'prereq_bind_key_mismatch');
  assert.match(warnings[0].message, /binds "threadId"/);
  assert.match(warnings[0].message, /captured query has "thread_id"/);
  assert.match(warnings[0].message, /did you mean "thread_id"/);
  assert.match(warnings[0].hint, /Rename the prereq's binds to "thread_id"/);
});

test('detectPrereqBindKeyMismatch: no warning when bind name matches the wire query key', () => {
  setCapturedRequestsProvider(() => [
    {
      method: 'GET',
      url: 'https://api.example.com/messages?thread_id=x&limit=20',
      headers: {},
      postData: null,
      status: 200,
      responseBody: '',
    },
  ]);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages?thread_id={{thread_id}}&limit=20',
    method: 'GET',
    prerequisites: [
      {
        name: 'resolve',
        kind: 'capability',
        capability: 'lookup_thread_by_name',
        args: { name: '{{recipient}}' },
        binds: 'thread_id',
      },
    ],
  };
  assert.deepEqual(detectPrereqBindKeyMismatch(strategy, 'sess-bind-ok'), []);
});

test('detectPrereqBindKeyMismatch: no warning when no captured requests match the endpoint', () => {
  setCapturedRequestsProvider(() => []);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages?thread={{threadId}}',
    method: 'GET',
    prerequisites: [
      {
        name: 'resolve',
        kind: 'capability',
        capability: 'lookup_thread_by_name',
        args: { name: '{{recipient}}' },
        binds: 'threadId',
      },
    ],
  };
  assert.deepEqual(detectPrereqBindKeyMismatch(strategy, 'sess-no-captures'), []);
});

test('detectPrereqBindKeyMismatch: no warning when sessionId is missing', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages?thread={{threadId}}',
    prerequisites: [{ name: 'r', kind: 'js-eval', expression: 'x', binds: 'threadId' }],
  };
  assert.deepEqual(detectPrereqBindKeyMismatch(strategy), []);
});

test('detectPrereqBindKeyMismatch: flags body-key mismatch for JSON POST body', () => {
  setCapturedRequestsProvider(() => [
    {
      method: 'POST',
      url: 'https://api.example.com/send',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({ thread_id: 'abc', text: 'hello' }),
      status: 200,
      responseBody: '',
    },
  ]);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/send',
    method: 'POST',
    contentType: 'json',
    body: { thread_id: '{{threadId}}', text: '{{text}}' },
    prerequisites: [
      {
        name: 'resolve',
        kind: 'capability',
        capability: 'lookup_thread_by_name',
        args: { name: '{{recipient}}' },
        binds: 'threadId',
      },
    ],
  };
  const warnings = detectPrereqBindKeyMismatch(strategy, 'sess-body-mismatch');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /captured body has "thread_id"/);
  assert.match(warnings[0].message, /did you mean "thread_id"/);
});
