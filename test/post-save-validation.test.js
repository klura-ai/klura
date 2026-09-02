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
const skills = await import('../dist/strategies/skills.js');
const { execute } = await import('../dist/execution/index.js');
const { pool, tokenCache } = await import('../dist/runtime-state/index.js');
const { assessPostSaveVerificationProof, POST_SAVE_PROOF_ASSESSMENT_KINDS, readRuntimeBuildId } =
  await import('../dist/strategies/post-save-verification-proof.js');

let mutatingTimeoutRequests = 0;
let notifyDelayedFailureRequest = () => {};
let finishDelayedFailureResponse = () => {};
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
  } else if (req.url === '/mutating-timeout') {
    mutatingTimeoutRequests += 1;
    req.resume();
  } else if (req.url === '/delayed-fail') {
    notifyDelayedFailureRequest();
    finishDelayedFailureResponse = () => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'delayed failure' }));
    };
  } else {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const port = server.address().port;
test.after(() => server.close());

function writeFetchStrategy(platform, capability, endpoint, method = 'GET') {
  const dir = path.join(TMP, 'skills', platform, 'fetch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${capability}.json`),
    JSON.stringify(
      {
        strategy: 'fetch',
        baseUrl: `http://127.0.0.1:${port}`,
        endpoint,
        method,
        ...(method === 'GET' ? {} : { body: { value: 'one' } }),
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

test('commit returns a proof for the exact bytes written under the capability lock', () => {
  const platform = 'psv-atomic-commit-proof';
  const capability = 'list_things';
  const first = {
    strategy: 'fetch',
    baseUrl: `http://127.0.0.1:${port}`,
    endpoint: '/ok',
    method: 'GET',
    transport: 'node',
    schema_version: 1,
  };
  const committed = skills.commitValidatedStrategyWithProof(platform, capability, first);
  const exactSaved = JSON.parse(fs.readFileSync(committed.path, 'utf8'));

  assert.equal(
    assessPostSaveVerificationProof(exactSaved, committed.proof, {
      platform,
      capability,
    }).kind,
    POST_SAVE_PROOF_ASSESSMENT_KINDS.current,
  );

  skills.commitValidatedStrategy(platform, capability, {
    strategy: 'fetch',
    baseUrl: `http://127.0.0.1:${port}`,
    endpoint: '/transport-only',
    method: 'GET',
    transport: 'node',
    schema_version: 1,
  });

  assert.equal(skills.loadCurrentPostSaveVerificationTarget(committed.proof), null);
  assert.equal(JSON.parse(fs.readFileSync(committed.path, 'utf8')).endpoint, '/transport-only');
});

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
  assert.deepEqual(saved.runtime_meta?.post_save_verification, result.proof);
  assert.equal(result.proof_current, true);
  assert.equal(result.proof.platform, platform);
  assert.equal(result.proof.capability, capability);
  assert.equal(result.proof.tier, 'fetch');
  assert.equal(result.proof.runtime_build_id, readRuntimeBuildId());
  assert.equal(result.proof.verifier_contract, 'post-save-verification-v1');
  assert.match(result.proof.strategy_digest, /^[a-f0-9]{64}$/);
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

test('a failed verification never archives newer strategy bytes committed in flight', async () => {
  const platform = 'psv-failure-archive-race';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/delayed-fail');
  const target = skills.capturePostSaveVerificationTarget(platform, capability, 'fetch');
  const requestObserved = new Promise((resolve) => {
    notifyDelayedFailureRequest = resolve;
  });

  const verification = verifySavedStrategy(platform, capability, {}, pool, target.proof);
  await requestObserved;
  skills.commitValidatedStrategy(platform, capability, {
    strategy: 'fetch',
    baseUrl: `http://127.0.0.1:${port}`,
    endpoint: '/ok',
    method: 'GET',
    transport: 'node',
    schema_version: 1,
  });
  finishDelayedFailureResponse();
  const result = await verification;

  assert.equal(result.classification, 'transport_failure');
  assert.equal(result.archived, false);
  assert.equal(result.proof_current, false);
  assert.ok(fs.existsSync(activePath(platform, capability)));
  assert.ok(!fs.existsSync(brokenPath(platform, capability)));
  const current = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
  assert.equal(current.endpoint, '/ok');
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
  assert.deepEqual(saved.runtime_meta?.post_save_verification, result.proof);
});

test('verifySavedStrategy rejects proof when the exact saved bytes changed before verification', async () => {
  const platform = 'psv-binding-stale';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/ok');
  const target = skills.capturePostSaveVerificationTarget(platform, capability, 'fetch');
  const changed = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
  changed.endpoint = '/transport-only';
  fs.writeFileSync(activePath(platform, capability), JSON.stringify(changed, null, 2));

  const result = await verifySavedStrategy(platform, capability, {}, pool, target.proof);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'not_run');
  assert.equal(result.proof_current, false);
  assert.match(result.message ?? '', /exact .* strategy .* no longer active/i);
  const saved = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
  assert.equal(saved.runtime_meta?.post_save_validation, undefined);
});

test('proof-bound validation stamps only the verified tier when a sibling tier exists', () => {
  const platform = 'psv-binding-tier';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/ok');
  const scriptsDir = path.join(TMP, 'skills', platform, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const pagePath = path.join(scriptsDir, `${capability}.json`);
  fs.writeFileSync(
    pagePath,
    JSON.stringify(
      {
        strategy: 'page-script',
        baseUrl: `http://127.0.0.1:${port}`,
        endpoint: '/ok',
        method: 'GET',
        schema_version: 1,
      },
      null,
      2,
    ),
  );
  const target = skills.capturePostSaveVerificationTarget(platform, capability, 'page-script');

  assert.equal(skills.stampPostSaveValidationProof(target.proof, 'passed', true), true);

  const fetch = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
  const page = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
  assert.equal(fetch.runtime_meta?.post_save_validation, undefined);
  assert.equal(page.runtime_meta?.post_save_validation, 'passed');
  assert.equal(page.runtime_meta?.post_save_verification?.tier, 'page-script');
});

test('a normal explicit-success execute refreshes proof without another save round-trip', async () => {
  const platform = 'psv-normal-execute';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/ok');

  const result = await execute(platform, capability, {}, pool, tokenCache);

  assert.equal(result.body.ok, true);
  const saved = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
  assert.equal(saved.runtime_meta?.post_save_validation, 'passed');
  assert.equal(saved.runtime_meta?.post_save_verification?.runtime_build_id, readRuntimeBuildId());
});

test('verifySavedStrategy: a request that was not sent remains active and health-neutral', async () => {
  const platform = 'psv-not-run';
  const capability = 'list_things';
  const dir = path.dirname(activePath(platform, capability));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    activePath(platform, capability),
    JSON.stringify(
      {
        strategy: 'fetch',
        baseUrl: `http://127.0.0.1:${port}`,
        endpoint: '/ok',
        method: 'POST',
        transport: 'node',
        generated: {
          nonce: { instruction: 'Return the request nonce.' },
        },
        body: { nonce: '{{nonce}}' },
        schema_version: 1,
      },
      null,
      2,
    ),
  );

  const result = await verifySavedStrategy(platform, capability, {}, pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'not_run');
  assert.equal(result.archived, false);
  assert.ok(fs.existsSync(activePath(platform, capability)));
  assert.ok(!fs.existsSync(brokenPath(platform, capability)));
  assert.match(result.message ?? '', /not sent/i);
});

test('verifySavedStrategy: a timed-out dispatched write is not retried or archived', async () => {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ traffic: { request_timeout_ms: 1_000 } }),
  );
  const platform = 'psv-delivery-unknown';
  const capability = 'submit_thing';
  writeFetchStrategy(platform, capability, '/mutating-timeout', 'POST');
  mutatingTimeoutRequests = 0;

  const result = await verifySavedStrategy(platform, capability, {}, pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'delivery_unknown');
  assert.equal(result.archived, false);
  assert.equal(mutatingTimeoutRequests, 1);
  assert.ok(fs.existsSync(activePath(platform, capability)));
  assert.ok(!fs.existsSync(brokenPath(platform, capability)));
  assert.match(result.message ?? '', /not archived or retried automatically/);
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
