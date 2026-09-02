// The end_drive `unsaved_xhr_endpoints` gate makes the agent quote each flagged
// endpoint path verbatim in its ack. That is only answerable if the paths are
// real and small.
//
// YouTube's sidebar hover-prefetch emits `data:application/json;base64,…` URLs
// of 60-350 KB. `new URL()` parses them happily and puts the entire payload in
// `pathname`, so the gate demanded a quote no tool call could carry — two
// capabilities were abandoned with working strategies because their session
// could not be closed.

import test from 'node:test';
import assert from 'node:assert';

import { collectUnsavedHotXhrEndpoints } from '../dist/audit/drive/xhr-noise.js';

const req = (url, over = {}) => ({ method: 'GET', url, status: 200, isNavigation: false, ...over });

test('a data: URI is not an endpoint and is not flagged', () => {
  const payload = 'data:application/json;base64,' + 'A'.repeat(300_000);
  const out = collectUnsavedHotXhrEndpoints([req(payload)], [], 'p');
  assert.equal(out.length, 0, 'inline content was flagged as a liftable endpoint');
});

test('a blob: URI is not an endpoint either', () => {
  const out = collectUnsavedHotXhrEndpoints([req('blob:https://x.test/abc-123')], [], 'p');
  assert.equal(out.length, 0);
});

test('real http endpoints are still flagged', () => {
  const out = collectUnsavedHotXhrEndpoints([req('https://x.test/api/items?page=1')], [], 'p');
  assert.equal(out.length, 1);
  assert.equal(out[0].urlPath, '/api/items');
});

test('an enormous real path is truncated, and says so', () => {
  const out = collectUnsavedHotXhrEndpoints([req('https://x.test/api/' + 'z'.repeat(5000))], [], 'p');
  assert.equal(out.length, 1);
  assert.ok(out[0].urlPath.length < 400, `path is ${out[0].urlPath.length} chars`);
  assert.match(out[0].urlPath, /…\[\d+ chars\]/);
});

test('the whole checklist stays quotable when a page floods data URIs', () => {
  // The real shape: a handful of genuine endpoints buried in prefetch noise.
  const flood = Array.from({ length: 40 }, (_, i) =>
    req('data:application/json;base64,' + 'B'.repeat(80_000) + i),
  );
  const real = [req('https://x.test/api/watch'), req('https://x.test/api/next')];
  const out = collectUnsavedHotXhrEndpoints([...flood, ...real], [], 'p');
  const rendered = JSON.stringify(out);
  assert.ok(rendered.length < 5_000, `checklist is ${rendered.length} chars`);
  assert.equal(out.length, 2, 'only the real endpoints survive');
});
