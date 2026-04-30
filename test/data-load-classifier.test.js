// Structural classifier for "page's data-load XHR" — used by synth_fetch
// at close_session when a capability was declared with no typed-literal
// args. Gates are strict (same-origin, 2xx, JSON). Soft signals are
// scored (list-shape +3, size +1, method:GET +1, name-affinity up to +4).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { classifyDataLoadXhr } = await import('../dist/response/data-load-classifier.js');

function mkReq(overrides = {}) {
  return {
    method: 'GET',
    url: 'https://example.com/api/videos',
    headers: { 'content-type': 'application/json' },
    postData: null,
    status: 200,
    responseBody: JSON.stringify({ videos: new Array(5).fill({ id: 1, title: 't' }) }),
    ...overrides,
  };
}

test('positive: JSON list on same origin → candidate with score > 0', () => {
  const r = mkReq();
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.ok(hit, 'returned a candidate');
  assert.ok(hit.score > 0);
  assert.ok(hit.signals.includes('list_shaped_body'));
});

test('negative: different origin → null', () => {
  const r = mkReq({ url: 'https://analytics.other.com/beacon' });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('negative: HTML response → null', () => {
  const r = mkReq({
    headers: { 'content-type': 'text/html' },
    responseBody: '<html><body>...</body></html>',
  });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('negative: 4xx status → null', () => {
  const r = mkReq({ status: 404 });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('negative: 5xx status → null', () => {
  const r = mkReq({ status: 500 });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('negative: full-page navigation → null', () => {
  const r = mkReq({ isNavigation: true });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('negative: 3xx redirect → null', () => {
  const r = mkReq({ status: 302, redirectUrl: 'https://example.com/login' });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('negative: body under 500 bytes → still a candidate but no size bonus', () => {
  const r = mkReq({ responseBody: JSON.stringify([{ id: 1 }]) });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.ok(hit);
  assert.ok(!hit.signals.includes('body_gte_500_bytes'));
});

test('positive: top-level array body qualifies as list-shaped', () => {
  const r = mkReq({
    responseBody: JSON.stringify(new Array(10).fill({ x: 1, y: 2, z: 3, data: 'x'.repeat(60) })),
  });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.ok(hit);
  assert.ok(hit.signals.includes('list_shaped_body'));
});

test('positive: object-with-array at depth 2 qualifies', () => {
  const r = mkReq({
    responseBody: JSON.stringify({ data: { items: new Array(5).fill({ id: 1 }) }, cursor: 'x' }),
  });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.ok(hit);
  assert.ok(hit.signals.includes('list_shaped_body'));
});

test('scalar-only object body does not qualify as list-shaped', () => {
  const r = mkReq({
    responseBody: JSON.stringify({
      id: 1,
      name: 'x',
      description: 'a'.repeat(600),
      user: { handle: 'x', bio: 'y' },
    }),
  });
  const hit = classifyDataLoadXhr(r, 'get_profile', 'example.com');
  // Still a valid candidate (JSON same-origin 200), but no list-shape bonus.
  assert.ok(hit);
  assert.ok(!hit.signals.includes('list_shaped_body'));
});

test('scoring: name-affinity rewards capability-noun → path-segment match', () => {
  const matches = mkReq({ url: 'https://example.com/api/videos' });
  const offtopic = mkReq({ url: 'https://example.com/api/profile' });
  const matchHit = classifyDataLoadXhr(matches, 'list_videos', 'example.com');
  const offtopicHit = classifyDataLoadXhr(offtopic, 'list_videos', 'example.com');
  assert.ok(matchHit && offtopicHit);
  assert.ok(
    matchHit.score > offtopicHit.score,
    `matched path should score higher (${matchHit.score} vs ${offtopicHit.score})`,
  );
});

test('scoring: GET beats POST on otherwise equal bodies', () => {
  const getR = mkReq({ method: 'GET' });
  const postR = mkReq({ method: 'POST' });
  const gHit = classifyDataLoadXhr(getR, 'list_videos', 'example.com');
  const pHit = classifyDataLoadXhr(postR, 'list_videos', 'example.com');
  assert.ok(gHit && pHit);
  assert.ok(gHit.score > pHit.score);
});

test('gracefully handles unparseable URL → null', () => {
  const r = mkReq({ url: 'not-a-url-at-all' });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('accepts already-parsed responseBody (object/array, not string)', () => {
  const r = mkReq({ responseBody: { items: [{ id: 1 }, { id: 2 }] } });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.ok(hit);
  assert.ok(hit.signals.includes('list_shaped_body'));
});

test('empty-string responseBody → null', () => {
  const r = mkReq({ responseBody: '' });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('responseBody is non-JSON string with JSON content-type → null', () => {
  const r = mkReq({
    headers: { 'content-type': 'application/json' },
    responseBody: 'not-actually-json-bytes',
  });
  const hit = classifyDataLoadXhr(r, 'list_videos', 'example.com');
  assert.equal(hit, null);
});

test('noise tokens in capability name (get / list / fetch) do not inflate affinity', () => {
  // Capability is "get_list_fetch" — every token is in the noise set.
  // URL is "/api/get/list/fetch" (same tokens as segments).
  const r = mkReq({ url: 'https://example.com/api/get/list/fetch' });
  const hit = classifyDataLoadXhr(r, 'get_list_fetch', 'example.com');
  assert.ok(hit);
  assert.ok(
    !hit.signals.some((s) => s.startsWith('name_affinity:')),
    'noise tokens should not count toward name_affinity',
  );
});

test('originHost null (unknown) → same-origin gate skipped; other gates still apply', () => {
  const r = mkReq({ url: 'https://anywhere.com/api/data' });
  const hit = classifyDataLoadXhr(r, 'list_videos', null);
  assert.ok(hit, 'no origin → accept any origin (classifier still scores structure)');
});
