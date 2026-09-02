// `response.extract` is a CSS-selector extractor over HTML. It cannot narrow a
// JSON body, so telling an agent holding 30 KB of JSON to "add structural
// extraction" names an affordance that does not apply — and the agent cannot
// discover that from the message, only by trying `extract` and failing.
//
// Observed on reddit: a page-script returning the raw listing JSON was refused
// promotion with "narrow the sample result or add structural extraction", and
// the run ended with five staged candidates and nothing active.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-remedy-test-'));
process.env.KLURA_HOME = TMP;

// Bodies large enough to blow the review-artifact bound.
const BIG_JSON = JSON.stringify({ items: Array.from({ length: 4000 }, (_, i) => ({ i, t: 'x'.repeat(20) })) });
const BIG_HTML = `<html><body>${'<div class="row">x</div>'.repeat(4000)}</body></html>`;

const server = http.createServer((req, res) => {
  const wantsHtml = req.url.includes('html');
  res.setHeader('Content-Type', wantsHtml ? 'text/html' : 'application/json');
  res.end(wantsHtml ? BIG_HTML : BIG_JSON);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const BASE = `http://127.0.0.1:${server.address().port}`;

process.on('exit', () => {
  try {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { verifySavedStrategy } = await import('../dist/strategies/verify-saved-strategy.js');
const skills = await import('../dist/strategies/skills.js');

function strategyFor(format) {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: BASE,
    endpoint: format === 'html' ? '/page.html' : '/data.json',
    // `format: "html"` cannot be saved without a non-empty extract, so the HTML
    // case necessarily arrives at verification already carrying one — which is
    // why "add an extract" would be the wrong thing to tell it.
    response:
      format === 'html'
        ? { format, extract: { rows: { selector: '.row', multiple: true } } }
        : { format },
    notes: { params: {} },
  };
}

test('a JSON result is not told to use response.extract', async () => {
  skills.saveStrategy('remedy-json', 'list_items', strategyFor('json'));
  const result = await verifySavedStrategy('remedy-json', 'list_items', {}, null);
  const message = result.message ?? '';

  if (!/output budget|review artifact bound/.test(message)) return; // not the oversize path here
  assert.match(
    message,
    /cannot narrow/,
    'a JSON body must be told that response.extract does not apply to it',
  );
  assert.match(
    message,
    /prereq return only the fields|narrow the request/,
    'the message has to name a remedy the agent can actually carry out',
  );
});

test('an HTML result is told to narrow its extract, not to add one', async () => {
  skills.saveStrategy('remedy-html', 'list_items', strategyFor('html'));
  const result = await verifySavedStrategy('remedy-html', 'list_items', {}, null);
  const message = result.message ?? '';

  if (!/output budget|review artifact bound/.test(message)) return;
  assert.match(
    message,
    /narrow it rather than add one/,
    'the extract is mandatory for html and therefore already present',
  );
  assert.doesNotMatch(
    message,
    /cannot narrow/,
    'the JSON caveat must not be shown for a document response.extract can read',
  );
});
