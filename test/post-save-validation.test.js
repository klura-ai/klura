// Post-save factory verification — verifySavedStrategy runs a just-saved
// strategy through execute(). Explicit body.ok:false fails even on HTTP 2xx;
// a 2xx body with no boolean ok is recorded as transport-only.
//
// The post_save_validation_consent checkpoint runs verifySavedStrategy on
// consent. A transport failure or explicit local failure archives the strategy
// in the same turn; an unclassified 2xx remains active but inconclusive.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-post-save-val-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { verifySavedStrategy } = await import('../dist/strategies/verify-saved-strategy.js');
const { pool } = await import('../dist/runtime-state/index.js');

const server = http.createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: 'abc123' }));
  } else if (req.url === '/typed-fail') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, outcome: 'failure', code: 'surface_missing' }));
  } else if (req.url === '/transport-only') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ outcome: 'failure', code: 'surface_missing' }));
  } else {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const port = server.address().port;
test.after(() => server.close());

function writeFetchStrategy(platform, capability, endpoint) {
  const dir = path.join(TMP, 'skills', platform, 'fetch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${capability}.json`),
    JSON.stringify(
      {
        strategy: 'fetch',
        baseUrl: `http://127.0.0.1:${port}`,
        endpoint,
        method: 'GET',
        transport: 'node',
        schema_version: 1,
      },
      null,
      2,
    ),
  );
}
const activePath = (p, c) => path.join(TMP, 'skills', p, 'fetch', `${c}.json`);
const brokenPath = (p, c) => path.join(TMP, 'skills', p, 'fetch', `${c}.broken.json`);

test('verifySavedStrategy: 2xx → passes, file stays, stamped passed', async () => {
  const platform = 'psv-ok';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/ok');

  const result = await verifySavedStrategy(platform, capability, {}, pool);

  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.classification, 'explicit_success');
  assert.ok(result.status >= 200 && result.status < 300, `expected 2xx, got ${result.status}`);
  assert.equal(result.archived, false);
  assert.ok(fs.existsSync(activePath(platform, capability)), 'active strategy file should remain');
  const saved = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
  assert.equal(saved.runtime_meta?.post_save_validation, 'passed');
});

test('verifySavedStrategy: HTTP 2xx with body.ok false → archived as an explicit failure', async () => {
  const platform = 'psv-explicit-fail';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/typed-fail');

  const result = await verifySavedStrategy(platform, capability, {}, pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'explicit_failure');
  assert.equal(result.status, 200);
  assert.equal(result.archived, true);
  assert.ok(!fs.existsSync(activePath(platform, capability)));
  assert.ok(fs.existsSync(brokenPath(platform, capability)));
  assert.match(result.message ?? '', /body\.ok === false/);
});

test('verifySavedStrategy: unclassified HTTP 2xx is transport-only, not semantic success', async () => {
  const platform = 'psv-transport-only';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/transport-only');

  const result = await verifySavedStrategy(platform, capability, {}, pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.archived, false);
  assert.match(result.body_preview, /"outcome":"failure"/);
  assert.match(result.body_preview, /"code":"surface_missing"/);
  const saved = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
  assert.equal(saved.runtime_meta?.post_save_validation, 'transport_passed');
});

test('verifySavedStrategy: non-2xx → archived to .broken.json with a failure envelope', async () => {
  const platform = 'psv-fail';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/fail');

  const result = await verifySavedStrategy(platform, capability, {}, pool);

  assert.equal(result.ok, false, `expected failure, got ${JSON.stringify(result)}`);
  assert.equal(result.classification, 'transport_failure');
  assert.equal(result.archived, true);
  assert.ok(
    !fs.existsSync(activePath(platform, capability)),
    'broken strategy must not remain in the active corpus',
  );
  assert.ok(
    fs.existsSync(brokenPath(platform, capability)),
    'broken strategy should be archived to .broken.json',
  );
  assert.ok(
    String(result.message ?? '').includes('post_save_validation_failed'),
    `expected a post_save_validation_failed envelope, got: ${result.message}`,
  );
});
