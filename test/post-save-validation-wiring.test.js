// Integration: the post-save-validation deferred-action wiring.
//
// `save_strategy` stages `session.pendingPostSaveValidation` and emits the
// `post_save_validation_consent` checkpoint via `invokeCheckpointAndGate`.
// `ack_checkpoint` resolves it: consent runs `verifySavedStrategy` (archive on
// transport or explicit local failure), decline stamps the strategy unverified.
// This test drives that path from the exact `invokeCheckpointAndGate` call
// `save_strategy` makes — driving the whole `save_strategy` tool in a unit test
// isn't feasible (audit-token dance + browser probe), and the rest of the suite
// covers its audit/probe.
//
// The benchmark's `checkpoint-stubs.js` auto-continues this checkpoint, so the
// field-report e2e cannot exercise this — this test is the verification.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-psv-wiring-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { invokeCheckpointAndGate } = await import('../dist/checkpoints/index.js');
const { ackCheckpoint } = await import('../dist/checkpoints/api.js');
const { registerCheckpointDefaults } = await import('../dist/checkpoints/default-handlers.js');
const { pool } = await import('../dist/runtime-state/index.js');

// The default `post_save_validation_consent` handler returns `handover` — so
// `invokeCheckpointAndGate` mints an envelope + registers a pending checkpoint.
registerCheckpointDefaults();

const server = http.createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
    JSON.stringify({
      strategy: 'fetch',
      baseUrl: `http://127.0.0.1:${port}`,
      endpoint,
      method: 'GET',
      transport: 'node',
      schema_version: 1,
    }),
  );
}
const activePath = (p, c) => path.join(TMP, 'skills', p, 'fetch', `${c}.json`);
const brokenPath = (p, c) => path.join(TMP, 'skills', p, 'fetch', `${c}.broken.json`);

function patchPool(session) {
  const origGet = pool.getSession;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  return () => {
    pool.getSession = origGet;
  };
}

// Mirror what save_strategy does: stage the verify payload on the session, then
// emit the checkpoint. Returns the envelope the agent would ack.
async function stageAndEmit(session, platform, capability) {
  session.pendingPostSaveValidation = { platform, capability, args: {} };
  const { envelope } = await invokeCheckpointAndGate('post_save_validation_consent', {
    session_id: session.id,
    capability,
    context: { kind: 'post_save_validation_consent', capability },
  });
  return envelope;
}

test('consent ack → verifySavedStrategy runs; a non-2xx strategy is archived', async () => {
  const platform = 'psv-wire-fail';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/fail');
  const session = { id: 'sess_psv_fail' };
  const restore = patchPool(session);
  try {
    const envelope = await stageAndEmit(session, platform, capability);
    assert.ok(envelope, 'save_strategy must emit a checkpoint envelope');
    assert.equal(envelope.kind, 'post_save_validation_consent');
    assert.ok(envelope.checkpoint_token, 'envelope must carry a checkpoint_token');

    const ack = await ackCheckpoint({
      session_id: session.id,
      checkpoint_token: envelope.checkpoint_token,
      user_response: 'yes, verify it',
    });

    assert.equal(
      ack.post_save_validation?.ok,
      false,
      `expected verification failure, got ${JSON.stringify(ack)}`,
    );
    assert.equal(ack.post_save_validation.archived, true);
    assert.ok(
      !fs.existsSync(activePath(platform, capability)),
      'a strategy that fails verification must not stay in the active corpus',
    );
    assert.ok(fs.existsSync(brokenPath(platform, capability)), 'failed strategy archived');
    assert.equal(session.pendingPostSaveValidation, undefined, 'staged payload cleared after ack');
  } finally {
    restore();
  }
});

test('consent ack → a 2xx strategy passes and stays, stamped passed', async () => {
  const platform = 'psv-wire-ok';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/ok');
  const session = { id: 'sess_psv_ok' };
  const restore = patchPool(session);
  try {
    const envelope = await stageAndEmit(session, platform, capability);
    const ack = await ackCheckpoint({
      session_id: session.id,
      checkpoint_token: envelope.checkpoint_token,
      user_response: 'yes',
    });

    assert.ok(
      String(ack._hint ?? '')
        .toLowerCase()
        .includes('passed'),
      `expected a passed hint, got ${JSON.stringify(ack)}`,
    );
    assert.ok(fs.existsSync(activePath(platform, capability)), 'verified strategy stays active');
    const saved = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
    assert.equal(saved.runtime_meta?.post_save_validation, 'passed');
  } finally {
    restore();
  }
});

test('consent ack → typed 2xx without body.ok is surfaced as inconclusive', async () => {
  const platform = 'psv-wire-transport';
  const capability = 'list_things';
  writeFetchStrategy(platform, capability, '/transport-only');
  const session = { id: 'sess_psv_transport' };
  const restore = patchPool(session);
  try {
    const envelope = await stageAndEmit(session, platform, capability);
    const ack = await ackCheckpoint({
      session_id: session.id,
      checkpoint_token: envelope.checkpoint_token,
      user_response: 'yes',
    });

    assert.equal(ack.post_save_validation?.ok, false);
    assert.equal(ack.post_save_validation?.classification, 'transport_accepted');
    assert.equal(ack.post_save_validation?.archived, false);
    assert.match(ack.post_save_validation?.body_preview ?? '', /"outcome":"failure"/);
    assert.match(String(ack._hint ?? ''), /inconclusive/i);
    assert.doesNotMatch(String(ack._hint ?? ''), /validation passed/i);
    const saved = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
    assert.equal(saved.runtime_meta?.post_save_validation, 'transport_passed');
  } finally {
    restore();
  }
});

test('decline ack → strategy stands, stamped declined, not archived, not re-fired', async () => {
  const platform = 'psv-wire-decline';
  const capability = 'list_things';
  // Endpoint would 500 — proves a declined strategy is NOT executed.
  writeFetchStrategy(platform, capability, '/fail');
  const session = { id: 'sess_psv_decline' };
  const restore = patchPool(session);
  try {
    const envelope = await stageAndEmit(session, platform, capability);
    const ack = await ackCheckpoint({
      session_id: session.id,
      checkpoint_token: envelope.checkpoint_token,
      cancelled: true,
      reason: 'sandbox scenario — re-firing the mutation needs explicit operator consent',
    });

    assert.ok(
      String(ack._hint ?? '')
        .toLowerCase()
        .includes('declined'),
      `expected a declined hint, got ${JSON.stringify(ack)}`,
    );
    assert.ok(
      fs.existsSync(activePath(platform, capability)),
      'a declined strategy stays — the save stands, unverified',
    );
    assert.ok(
      !fs.existsSync(brokenPath(platform, capability)),
      'a declined strategy is not archived (it was never executed)',
    );
    const saved = JSON.parse(fs.readFileSync(activePath(platform, capability), 'utf8'));
    assert.equal(saved.runtime_meta?.post_save_validation, 'declined');
  } finally {
    restore();
  }
});
