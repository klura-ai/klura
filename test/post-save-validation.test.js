// Post-save 2xx verification — verifySavedStrategy runs a just-saved strategy
// through execute() and archives it to `.broken.json` when it doesn't work.
//
// Repro shape: an agent saves a strategy whose request 500s at warm time (the
// github/create_issue dropped-header case). Pre-fix, save_strategy accepted it
// blind and the break only surfaced on the next user's warm run. Post-fix, the
// post_save_validation_consent checkpoint runs verifySavedStrategy on consent —
// a non-2xx archives the strategy in the same turn.

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

// Local server: /ok → 200, anything else → 500.
const server = http.createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: 'abc123' }));
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
  assert.ok(result.status >= 200 && result.status < 300, `expected 2xx, got ${result.status}`);
  assert.equal(result.archived, false);
  assert.ok(fs.existsSync(activePath(platform, capability)), 'active strategy file should remain');
  const saved = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
  assert.equal(saved.runtime_meta?.post_save_validation, 'passed');
});

test('verifySavedStrategy: non-2xx → archived to .broken.json with a failure envelope', async () => {
  const platform = 'psv-fail';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/fail');

  const result = await verifySavedStrategy(platform, capability, {}, pool);

  assert.equal(result.ok, false, `expected failure, got ${JSON.stringify(result)}`);
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
