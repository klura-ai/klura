// `collectDataLoadCandidates` — the read-only review path. No auto-save:
// the runtime narrows captured requests to ranked candidates and lets
// `close_session` surface them for the LLM to pick. These tests cover
// the narrowing + candidate shape directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const synth = await import('../dist/strategies/synthesize-on-close/index.js');

function mkSession({ intercepted = [], visitedUrls = ['https://example.com/'] } = {}) {
  return {
    id: 'sess_t',
    intercepted,
    intercepting: false,
    platform: 'test-p',
    declaredCapabilities: [],
    savedCapabilities: [],
    performActionHistory: [],
    visitedUrls,
  };
}

function mkJsonReq({
  method = 'GET',
  url = 'https://example.com/api/videos',
  body = { videos: new Array(5).fill({ id: 1, title: 't', likes: 100 }) },
  status = 200,
  cookie = null,
} = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  return {
    method,
    url,
    headers,
    postData: null,
    status,
    responseBody: JSON.stringify(body),
  };
}

test('collectDataLoadCandidates: single qualifying XHR → one candidate with body preview', () => {
  const session = mkSession({
    intercepted: [mkJsonReq({ url: 'https://example.com/api/videos?count=3' })],
  });
  const cands = synth.collectDataLoadCandidates(session, 'list_videos', session.intercepted);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].method, 'GET');
  assert.equal(cands[0].url, 'https://example.com/api/videos?count=3');
  assert.ok(cands[0].body_preview.includes('videos'));
  assert.ok(cands[0].signals.includes('list_shaped_body'));
  assert.equal(cands[0].needs_browser_session, false);
});

test('collectDataLoadCandidates: cookie on captured request → needs_browser_session:true', () => {
  const session = mkSession({
    intercepted: [mkJsonReq({ url: 'https://example.com/api/feed', cookie: 'sid=abc' })],
  });
  const cands = synth.collectDataLoadCandidates(session, 'list_feed', session.intercepted);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].needs_browser_session, true);
});

test('collectDataLoadCandidates: dedupes same host+path (scroll pagination)', () => {
  const session = mkSession({
    intercepted: [
      mkJsonReq({ url: 'https://example.com/api/videos?cursor=0' }),
      mkJsonReq({ url: 'https://example.com/api/videos?cursor=20' }),
      mkJsonReq({ url: 'https://example.com/api/videos?cursor=40' }),
    ],
  });
  const cands = synth.collectDataLoadCandidates(session, 'list_videos', session.intercepted);
  assert.equal(cands.length, 1, 'same path collapsed to one candidate');
});

test('collectDataLoadCandidates: multiple distinct endpoints → ranked list', () => {
  const session = mkSession({
    intercepted: [
      mkJsonReq({ url: 'https://example.com/api/profile', body: { name: 'x' } }),
      mkJsonReq({ url: 'https://example.com/api/videos', body: { items: new Array(5).fill({ id: 1 }) } }),
      mkJsonReq({ url: 'https://example.com/api/comments', body: { items: new Array(3).fill({ id: 1 }) } }),
    ],
  });
  const cands = synth.collectDataLoadCandidates(session, 'list_videos', session.intercepted);
  assert.ok(cands.length >= 2, 'multiple candidates surfaced');
  // Body previews present so the LLM can identify which one carries the data.
  for (const c of cands) {
    assert.ok(typeof c.body_preview === 'string');
    assert.ok(typeof c.body_bytes === 'number');
    assert.ok(typeof c.score === 'number');
    assert.ok(Array.isArray(c.signals));
  }
});

test('collectDataLoadCandidates: HTML response excluded', () => {
  const session = mkSession({
    intercepted: [
      {
        method: 'GET',
        url: 'https://example.com/page',
        headers: { 'content-type': 'text/html' },
        postData: null,
        status: 200,
        responseBody: '<html/>',
      },
    ],
  });
  const cands = synth.collectDataLoadCandidates(session, 'list_things', session.intercepted);
  assert.equal(cands.length, 0);
});

test('collectDataLoadCandidates: respects limit argument', () => {
  const intercepted = [];
  for (let i = 0; i < 30; i++) {
    intercepted.push(
      mkJsonReq({
        url: `https://example.com/api/endpoint_${i}`,
        body: { items: new Array(5).fill({ id: i }) },
      }),
    );
  }
  const session = mkSession({ intercepted });
  const cands = synth.collectDataLoadCandidates(session, 'list_things', intercepted, 5);
  assert.equal(cands.length, 5);
});

test('collectDataLoadCandidates: body_truncated flag when over 400 chars', () => {
  const bigBody = { items: new Array(100).fill({ id: 1, title: 'a'.repeat(50) }) };
  const session = mkSession({ intercepted: [mkJsonReq({ body: bigBody })] });
  const cands = synth.collectDataLoadCandidates(session, 'list_videos', session.intercepted);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].body_truncated, true);
  assert.ok(cands[0].body_preview.length <= 400);
  assert.ok(cands[0].body_bytes > 400);
});
