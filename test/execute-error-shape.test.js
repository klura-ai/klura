// Unit tests for finalizeCascadeFailure — the pure helper that classifies an
// exhausted strategy cascade and attaches diagnostic context (params_used +
// params_doc) so the LLM can self-correct or re-discover without guessing.
//
// The full execute() function needs a real browser pool for fetch / browser
// -fetch / recorded-path tiers, so testing the cascade end-to-end is expensive.
// This file tests the exhaustion logic in isolation by feeding it synthetic
// (args, errors, lastFailedResult, lastFailedStrategy) tuples and asserting the
// shape of the returned ExecuteResult.

import test from 'node:test';
import assert from 'node:assert';
import { finalizeCascadeFailure, looksLikeHtml } from '../dist/execution.js';

const baseStrategy = {
  strategy: 'fetch',
  method: 'POST',
  baseUrl: 'http://localhost:9999',
  endpoint: '/api/conversations/{{to}}/messages',
  notes: {
    discovery: 'Discovered during benchmark',
    params: {
      to: {
        description: 'recipient user id',
        kind: 'id',
        example: 'bob',
        source: 'lowercase user id, not display name',
      },
      text: 'message body',
    },
  },
};

test('finalizeCascadeFailure: 404 → endpoint_stale with needs_rediscovery and echoed params', () => {
  const args = { to: 'Bob', text: 'hello' };
  const lastResult = {
    status: 404,
    body: { error: 'user not found' },
    finalUrl: 'http://localhost:9999/api/conversations/Bob/messages',
  };
  const result = finalizeCascadeFailure(args, ['fetch: HTTP 404'], lastResult, baseStrategy);

  assert.strictEqual(result.status, 404);
  const body = result.body;
  assert.strictEqual(body.error, 'endpoint_stale');
  assert.strictEqual(body.needs_rediscovery, true);
  assert.strictEqual(body.original_status, 404);
  assert.deepStrictEqual(body.original_body, { error: 'user not found' });
  assert.strictEqual(body.final_url, 'http://localhost:9999/api/conversations/Bob/messages');
  assert.strictEqual(body.tier, 'fetch');
  assert.deepStrictEqual(body.params_used, { to: 'Bob', text: 'hello' });
  // ParamDoc pass-through: the LLM sees the structured shape verbatim
  assert.deepStrictEqual(body.params_doc, baseStrategy.notes.params);
});

test('finalizeCascadeFailure: 401 → auth_failed with needs_reauth, not endpoint_stale', () => {
  const args = { to: 'bob', text: 'hello' };
  const lastResult = {
    status: 401,
    body: { error: 'unauthorized' },
    finalUrl: 'http://localhost:9999/api/conversations/bob/messages',
  };
  const result = finalizeCascadeFailure(args, ['fetch: HTTP 401'], lastResult, baseStrategy);

  const body = result.body;
  assert.strictEqual(body.error, 'auth_failed');
  assert.strictEqual(body.needs_reauth, true);
  // Auth path must NOT emit needs_rediscovery (re-discovery is expensive)
  assert.strictEqual(body.needs_rediscovery, undefined);
  // Auth branch also echoes params so the agent still has diagnostic context
  assert.deepStrictEqual(body.params_used, args);
  assert.deepStrictEqual(body.params_doc, baseStrategy.notes.params);
});

test('finalizeCascadeFailure: 500 → all_strategies_failed (generic) with echoed params', () => {
  const args = { to: 'bob', text: 'hello' };
  const lastResult = {
    status: 500,
    body: { error: 'internal server error' },
    finalUrl: '',
  };
  const errors = ['fetch: HTTP 500', 'page-script: HTTP 500'];
  const result = finalizeCascadeFailure(args, errors, lastResult, baseStrategy);

  const body = result.body;
  assert.strictEqual(body.error, 'all_strategies_failed');
  assert.strictEqual(body.needs_rediscovery, true);
  assert.deepStrictEqual(body.details, errors);
  assert.deepStrictEqual(body.params_used, args);
  assert.deepStrictEqual(body.params_doc, baseStrategy.notes.params);
});

test('finalizeCascadeFailure: no lastFailedResult → generic all_strategies_failed', () => {
  // Can happen when strategies all threw exceptions (network errors, etc.)
  // without ever producing a structured HTTP result.
  const args = { to: 'bob' };
  const result = finalizeCascadeFailure(args, ['fetch: fetch failed'], null, null);

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.body.error, 'all_strategies_failed');
  assert.strictEqual(result.body.needs_rediscovery, true);
  assert.deepStrictEqual(result.body.params_used, args);
  assert.strictEqual(result.body.params_doc, undefined);
});

test('finalizeCascadeFailure: legacy string-valued notes.params echoes as strings', () => {
  const legacyStrategy = {
    strategy: 'fetch',
    baseUrl: 'http://localhost:9999',
    endpoint: '/api/search',
    notes: {
      params: {
        q: 'search query',
        limit: 'max results',
      },
    },
  };
  const args = { q: 'pizza', limit: 10 };
  const lastResult = { status: 404, body: {}, finalUrl: '' };
  const result = finalizeCascadeFailure(args, ['fetch: HTTP 404'], lastResult, legacyStrategy);

  assert.deepStrictEqual(result.body.params_doc, { q: 'search query', limit: 'max results' });
  assert.deepStrictEqual(result.body.params_used, args);
});

test('finalizeCascadeFailure: notes-less strategy → params_doc is undefined', () => {
  const bareStrategy = {
    strategy: 'fetch',
    baseUrl: 'http://localhost:9999',
    endpoint: '/api/ping',
  };
  const result = finalizeCascadeFailure(
    { foo: 'bar' },
    ['fetch: HTTP 404'],
    { status: 404, body: {}, finalUrl: '' },
    bareStrategy,
  );

  assert.strictEqual(result.body.params_doc, undefined);
  assert.deepStrictEqual(result.body.params_used, { foo: 'bar' });
});

test('finalizeCascadeFailure: 400 with shape-mismatch body → all_strategies_failed (400 is ambiguous, no longer auto-classified as endpoint_stale)', () => {
  const args = { userId: '12345' };
  const lastResult = {
    status: 400,
    body: { error: 'invalid user id format' },
    finalUrl: '',
  };
  const result = finalizeCascadeFailure(args, ['fetch: HTTP 400'], lastResult, baseStrategy);

  assert.strictEqual(result.body.error, 'all_strategies_failed');
  assert.strictEqual(result.body.needs_rediscovery, true);
});

test('finalizeCascadeFailure: 400 with rate-limit body → all_strategies_failed (not endpoint_stale)', () => {
  const args = { to: 'bob' };
  const lastResult = {
    status: 400,
    body: { message: 'too many requests, slow down' },
    finalUrl: '',
  };
  const result = finalizeCascadeFailure(args, ['fetch: HTTP 400'], lastResult, baseStrategy);

  // 400 without shape-mismatch phrases falls through to the generic branch
  assert.strictEqual(result.body.error, 'all_strategies_failed');
  assert.strictEqual(result.body.needs_rediscovery, true);
});

test('finalizeCascadeFailure: params_used is caller args verbatim, no mutation', () => {
  const args = { to: 'bob', text: 'hello', nested: { foo: 'bar' } };
  const snapshot = JSON.parse(JSON.stringify(args));
  const result = finalizeCascadeFailure(
    args,
    ['fetch: HTTP 404'],
    { status: 404, body: {}, finalUrl: '' },
    baseStrategy,
  );

  // Echoed reference must contain exactly what the caller passed
  assert.deepStrictEqual(result.body.params_used, snapshot);
  // And we must not have mutated the caller's args
  assert.deepStrictEqual(args, snapshot);
});

// ---- looksLikeHtml: decision boundary for the HTML fallback in the
// body-size guard. Unit tests the gate that decides whether an oversized
// string body gets converted to a11y + trimmed vs returned as
// response_too_large.

test('looksLikeHtml: doctype', () => {
  assert.strictEqual(looksLikeHtml('<!DOCTYPE html><html>...'), true);
  assert.strictEqual(looksLikeHtml('<!doctype html>\n<html>...'), true);
});

test('looksLikeHtml: leading whitespace is tolerated', () => {
  assert.strictEqual(looksLikeHtml('  \n  <!DOCTYPE html>'), true);
  assert.strictEqual(looksLikeHtml('\n\t<html lang="en">'), true);
});

test('looksLikeHtml: common top-level elements', () => {
  assert.strictEqual(looksLikeHtml('<html><body>x</body></html>'), true);
  assert.strictEqual(looksLikeHtml('<main class="x">'), true);
  assert.strictEqual(looksLikeHtml('<nav>...'), true);
  assert.strictEqual(looksLikeHtml('<header>...'), true);
  assert.strictEqual(looksLikeHtml('<footer>...'), true);
  assert.strictEqual(looksLikeHtml('<div id=app>...'), true);
});

test('looksLikeHtml: JSON-shaped strings are not HTML', () => {
  assert.strictEqual(looksLikeHtml('{"key": "value"}'), false);
  assert.strictEqual(looksLikeHtml('[{"id": 1}]'), false);
});

test('looksLikeHtml: plain text is not HTML', () => {
  assert.strictEqual(looksLikeHtml('hello world'), false);
  assert.strictEqual(looksLikeHtml(''), false);
});

test('looksLikeHtml: XML-ish non-HTML tags are not HTML', () => {
  // The sniff is intentionally narrow — an arbitrary XML root like
  // <feed>, <rss>, <svg> is NOT matched. That keeps us from running the
  // DOMParser walker on content where tag→role mapping would be noisy.
  assert.strictEqual(looksLikeHtml('<feed xmlns="http://www.w3.org/2005/Atom">'), false);
  assert.strictEqual(looksLikeHtml('<rss version="2.0">'), false);
  assert.strictEqual(looksLikeHtml('<svg xmlns="http://www.w3.org/2000/svg">'), false);
});
