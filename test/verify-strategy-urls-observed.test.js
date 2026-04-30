// Unit tests for the observation check in strategy-probe.ts — the
// hallucination guard that rejects strategies pointing at URLs not seen
// during the discovery flow.
//
// Covers:
//   - fetch endpoint observed in the log → accepted
//   - fetch endpoint NOT in the log → rejected with a pointer
//   - fetch prereq URL observed → accepted
//   - fetch prereq URL NOT observed → rejected
//   - Query string drift tolerated (host + path match is enough)
//   - Different host → rejected (github.com vs api.github.com)
//   - Empty observed list → no-op
//   - Templates resolved via notes.params.example
//   - Trailing slash tolerated

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-obs-test-'));
process.env.KLURA_HOME = TMP;

const { findUnobservedStrategyUrls, normalizeUrlForObservation } = await import(
  '../dist/strategies/verify-observed.js'
);

// Test-local shim: the production code path now collects issues and routes them
// through the unified Audit (audit/save-strategy.ts) rather than throwing
// directly. These tests assert the underlying URL-observation invariants — the
// shim preserves the throwing semantics so the existing assertions keep
// exercising the same logic without coupling to the audit envelope.
function verifyStrategyUrlsObserved(strategy, observed) {
  const issues = findUnobservedStrategyUrls(strategy, observed);
  if (issues.length === 0) return;
  throw new Error(issues.map((i) => i.message).join('\n'));
}

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---- URL normalization ----

test('normalizeUrlForObservation: strips query and fragment', () => {
  assert.strictEqual(
    normalizeUrlForObservation('https://github.com/_graphql?query=createIssue'),
    'https://github.com/_graphql',
  );
  assert.strictEqual(
    normalizeUrlForObservation('https://github.com/_graphql#section'),
    'https://github.com/_graphql',
  );
});

test('normalizeUrlForObservation: lowercases host', () => {
  assert.strictEqual(
    normalizeUrlForObservation('https://GitHub.com/_graphql'),
    'https://github.com/_graphql',
  );
});

test('normalizeUrlForObservation: strips trailing slash', () => {
  assert.strictEqual(
    normalizeUrlForObservation('https://github.com/_graphql/'),
    'https://github.com/_graphql',
  );
});

test('normalizeUrlForObservation: root path keeps its single slash', () => {
  // Root pathname is already minimal — not stripped. Matches browser
  // behavior where `https://github.com` and `https://github.com/` are
  // the same request; either form round-trips through new URL() as /.
  assert.strictEqual(
    normalizeUrlForObservation('https://github.com/'),
    'https://github.com/',
  );
  assert.strictEqual(
    normalizeUrlForObservation('https://github.com'),
    'https://github.com/',
  );
});

test('normalizeUrlForObservation: returns null on unparseable input', () => {
  assert.strictEqual(normalizeUrlForObservation('not a url'), null);
  assert.strictEqual(normalizeUrlForObservation(''), null);
});

// ---- Observation check: fetch ----

test('fetch: endpoint observed in log → accepted', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://hn.algolia.com',
    endpoint: '/api/v1/search',
  };
  verifyStrategyUrlsObserved(strategy, ['https://hn.algolia.com/api/v1/search?query=foo']);
});

test('fetch: endpoint NOT in log → rejected with detail', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.github.com',
    endpoint: '/repos/klura-ai/scratch',
  };
  assert.throws(
    () =>
      verifyStrategyUrlsObserved(strategy, [
        'https://github.com/_graphql',
        'https://github.com/assets/app.css',
      ]),
    (err) => {
      assert.match(err.message, /not observed/i);
      assert.match(err.message, /fetch\.endpoint/);
      assert.match(err.message, /api\.github\.com/);
      // Error should list the captured hosts so the agent can self-correct.
      assert.match(err.message, /github\.com/);
      return true;
    },
  );
});

test('fetch: query string drift tolerated (host+path match wins)', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://hn.algolia.com',
    endpoint: '/api/v1/search?query={{q}}',
    notes: { params: { q: { example: 'rust' } } },
  };
  // Observed log has different query params, same path
  verifyStrategyUrlsObserved(strategy, [
    'https://hn.algolia.com/api/v1/search?query=show+hn&hitsPerPage=10',
  ]);
});

test('fetch: template resolved via notes.params.example', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.example.com',
    endpoint: '/users/{{userId}}/orders',
    notes: { params: { userId: { example: 'alice' } } },
  };
  verifyStrategyUrlsObserved(strategy, ['https://api.example.com/users/alice/orders']);
});

// ---- Observation check: fetch prerequisites ----

test('fetch: page-extract prereq URL observed → accepted', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://github.com',
    endpoint: '/_graphql',
    prerequisites: [
      {
        name: 'getTokens',
        kind: 'page-extract',
        url: 'https://github.com/klura-ai/scratch/issues/new',
        vars: { fetchNonce: { selector: 'meta[name=fetch-nonce]', attr: 'content' } },
      },
    ],
  };
  verifyStrategyUrlsObserved(strategy, [
    'https://github.com/_graphql',
    'https://github.com/klura-ai/scratch/issues/new',
  ]);
});

test('fetch: fetch-extract prereq URL NOT observed → rejected', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://github.com',
    endpoint: '/_graphql',
    prerequisites: [
      {
        name: 'getRepoId',
        kind: 'fetch-extract',
        url: 'https://api.github.com/repos/{{owner}}/{{repo}}',
        vars: { nodeId: 'node_id' },
      },
    ],
    notes: {
      params: {
        owner: { example: 'klura-ai' },
        repo: { example: 'scratch' },
      },
    },
  };
  assert.throws(
    () =>
      verifyStrategyUrlsObserved(strategy, [
        'https://github.com/_graphql',
        'https://github.com/klura-ai/scratch/issues/new',
      ]),
    (err) => {
      assert.match(err.message, /not observed/i);
      assert.match(err.message, /getRepoId/);
      assert.match(err.message, /api\.github\.com/);
      return true;
    },
  );
});

test('fetch: cached prereq skipped (no URL to check)', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://github.com',
    endpoint: '/_graphql',
    prerequisites: [
      { name: 'csrf', kind: 'cached' },
    ],
  };
  verifyStrategyUrlsObserved(strategy, ['https://github.com/_graphql']);
});

// ---- Edge cases ----

test('empty observed list → reject every declared URL (training-data hallucination guard)', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://totally.fake',
    endpoint: '/not/real',
  };
  // Auth-fail / page-crash sessions capture zero traffic. Saving from
  // training-data recall is exactly the failure mode this guard is for —
  // the empty-log branch must reject, not pass.
  assert.throws(
    () => verifyStrategyUrlsObserved(strategy, []),
    /captured ZERO requests|training-data recall/i,
  );
});

test('recorded-path: no URL check (recorded-path navigate steps are not validated here)', () => {
  const strategy = {
    strategy: 'recorded-path',
    steps: [{ action: 'navigate', url: 'https://totally.fake/' }],
  };
  // No-op — observation check currently only covers API-tier strategies.
  verifyStrategyUrlsObserved(strategy, ['https://real.example.com/']);
});

test('method-prefixed endpoint field parses correctly', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: 'POST /items',
  };
  verifyStrategyUrlsObserved(strategy, ['https://api.example.com/items']);
});

test('template-unresolvable endpoint skipped (selector probe handles it)', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.example.com',
    endpoint: '/items/{{missingId}}',
  };
  // No notes.params.missingId.example → template resolution throws → caught
  // and skipped. The selector probe surfaces the error; here we just don't
  // false-positive on an already-broken strategy.
  verifyStrategyUrlsObserved(strategy, ['https://api.example.com/items/xyz']);
});

// ---- WebSocket-shaped strategies: URL check is delegated to verifyWsUrlObserved ----

test('ws-shaped fetch: stray endpoint field is NOT checked for observation', () => {
  // When protocol:'websocket', the agent sometimes leaves a leftover endpoint
  // field from the http-tier template. The websocket-shape validator (in
  // skills.ts) rejects that field with the right message — so the URL
  // observation check must skip it, otherwise the misleading "endpoint not
  // in network log" error fires first and masks the real schema problem.
  const strategy = {
    strategy: 'fetch',
    protocol: 'websocket',
    wsUrl: 'wss://edge-chat.example.com/chat',
    baseUrl: 'https://edge-chat.example.com',
    endpoint: '/chat',
    frameEncoding: 'binary',
  };
  // Only http URLs in the observed log — no match for /chat. Should still
  // pass: the ws strategy doesn't fire an endpoint check, and wsUrl is the
  // job of verifyWsUrlObserved (separate function, not exercised here).
  verifyStrategyUrlsObserved(strategy, [
    'https://edge-chat.example.com/some/other/path',
  ]);
});

test('ws-shaped fetch: prereq URLs are still checked, endpoint is skipped', () => {
  // Prereq URLs on a ws strategy are still real http navigations the agent
  // should have observed — only the leftover endpoint field is skipped.
  const strategy = {
    strategy: 'fetch',
    protocol: 'websocket',
    wsUrl: 'wss://example.com/ws',
    baseUrl: 'https://example.com',
    endpoint: '/leftover',
    frameEncoding: 'binary',
    prerequisites: [
      {
        name: 'getToken',
        kind: 'page-extract',
        url: 'https://example.com/auth/token',
        vars: { token: { selector: 'meta[name=token]', attr: 'content' } },
      },
    ],
  };
  // Token URL not in the log → still rejected (this is the correct guard).
  assert.throws(
    () => verifyStrategyUrlsObserved(strategy, ['https://example.com/some/path']),
    /not observed/i,
  );
  // Token URL in the log → accepted; leftover endpoint is not checked.
  verifyStrategyUrlsObserved(strategy, [
    'https://example.com/auth/token',
    'https://example.com/some/path',
  ]);
});

test('regression: page-extract prereq URL from session.visitedUrls resolves', () => {
  // This is the exact github/create_issue case: the agent start_session'd
  // to /issues/new, which is a top-level document navigation. klura's CDP
  // interceptor doesn't capture document loads, so the ONLY source for that
  // URL in the observed set is `session.visitedUrls`. The runtime's
  // saveStrategy merges captured + visited into one list before calling
  // the validator — this test pins that the validator accepts a visited
  // URL even when it doesn't appear in the CDP capture.
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://github.com',
    endpoint: '/_graphql',
    prerequisites: [
      {
        name: 'getPageTokens',
        kind: 'page-extract',
        url: 'https://github.com/klura-ai/scratch/issues/new',
        vars: { fetchNonce: { selector: 'meta[name=fetch-nonce]', attr: 'content' } },
      },
    ],
  };
  // Captured requests (XHR/fetch) do NOT include /issues/new — they're all
  // subrequests fired from the page. Visited URLs DO include it.
  // Caller (saveStrategy in index.ts) merges these before invoking the
  // validator, so the observed set passed here represents the merged view.
  const captured = [
    'https://github.com/_graphql',
    'https://github.githubassets.com/assets/app.css',
    'https://avatars.githubusercontent.com/u/12345',
  ];
  const visited = ['https://github.com/klura-ai/scratch/issues/new'];
  verifyStrategyUrlsObserved(strategy, [...captured, ...visited]);
});
