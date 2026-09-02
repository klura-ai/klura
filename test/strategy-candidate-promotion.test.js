import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-strategy-candidate-'));
process.env.KLURA_HOME = TMP;

const skills = await import('../dist/strategies/skills.js');
const candidates = await import('../dist/strategies/strategy-candidates.js');
const mutations = await import('../dist/strategies/capability-mutation.js');
const { previewBody, verifyStrategyCandidate } =
  await import('../dist/strategies/verify-saved-strategy.js');
const { reviewStrategyCandidate } = await import('../dist/tools/review-strategy-candidate.js');
const { getHealth, markFailed } = await import('../dist/strategies/health.js');
const { pool } = await import('../dist/runtime-state/index.js');
const { createPostSaveVerificationProof } =
  await import('../dist/strategies/post-save-verification-proof.js');

const requests = [];
let changingEvidenceVersion = 'one';
const server = http.createServer((req, res) => {
  requests.push(req.url);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/ok') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, items: [{ id: 'one' }] }));
    return;
  }
  if (req.url === '/typed-fail') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: false, outcome: 'shape_changed', code: 'items_absent' }));
    return;
  }
  if (req.url === '/transport-only') {
    res.writeHead(200);
    res.end(JSON.stringify({ items: [{ id: 'one' }] }));
    return;
  }
  if (req.url === '/transport-large') {
    res.writeHead(200);
    res.end(JSON.stringify({ items: [{ id: 'one', payload: 'x'.repeat(1200) }] }));
    return;
  }
  if (req.url === '/transport-changing') {
    res.writeHead(200);
    res.end(JSON.stringify({ items: [{ id: changingEvidenceVersion }] }));
    return;
  }
  res.writeHead(500);
  res.end(JSON.stringify({ error: 'unexpected_path' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const port = server.address().port;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.shutdown();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function strategy(endpoint) {
  return {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: `http://127.0.0.1:${port}`,
    endpoint,
  };
}

function activePath(platform, capability) {
  return path.join(TMP, 'skills', platform, 'fetch', `${capability}.json`);
}

function writeActive(platform, capability, value) {
  const filePath = activePath(platform, capability);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

function successfulVerification(ref) {
  const candidate = candidates.loadStrategyCandidate(ref);
  return {
    post_save_validation: 'passed',
    post_save_verification: createPostSaveVerificationProof(
      ref.platform,
      ref.capability,
      candidate,
    ),
    candidate_verification: {
      classification: 'explicit_success',
      status: 200,
      checked_at_ms: Date.now(),
    },
  };
}

function verificationPath(ref) {
  return ref.path.replace(/\.json$/, '.verification.json');
}

function capabilityLockPath(platform, capability) {
  const key = crypto
    .createHash('sha256')
    .update('klura-capability-mutation-v1\0')
    .update(JSON.stringify([platform, capability]))
    .digest('hex');
  return path.join(TMP, 'strategy-candidates', '.mutation-locks', `${key}.lock`);
}

function capabilityProcessMarkerPath(pid, nonce) {
  return path.join(
    TMP,
    'strategy-candidates',
    '.mutation-locks',
    '.process-owners',
    `${pid}-${nonce}.lease`,
  );
}

function promoteAtRenameWithCompetingMutation(ref, mutate) {
  const targetPath = activePath(ref.platform, ref.capability);
  const originalRenameSync = fs.renameSync;
  let attempted = false;
  let mutationError;
  fs.renameSync = function interceptedRename(source, destination) {
    if (!attempted && path.resolve(destination) === path.resolve(targetPath)) {
      attempted = true;
      try {
        mutate();
      } catch (error) {
        mutationError = error;
      }
    }
    return originalRenameSync.call(this, source, destination);
  };
  try {
    const promotedPath = candidates.promoteStrategyCandidate(ref);
    return { attempted, mutationError, promotedPath };
  } finally {
    fs.renameSync = originalRenameSync;
  }
}

function assertCapabilityMutationConflict(result) {
  assert.equal(result.attempted, true);
  assert.ok(result.mutationError instanceof mutations.CapabilityMutationLockError);
  assert.equal(result.mutationError.code, 'capability_mutation_locked');
}

test('explicit success atomically promotes the exact inactive candidate', async () => {
  const platform = 'candidate-success';
  const capability = 'list_items';
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/ok'));
  for (let index = 0; index < 5; index += 1) {
    markFailed(platform, capability, 'fetch', `prior candidate failure ${index}`);
  }
  assert.equal(getHealth(platform, capability, 'fetch').status, 'broken');

  assert.equal(skills.loadStrategy(platform, capability), null);
  assert.ok(fs.existsSync(ref.path));

  const result = await verifyStrategyCandidate(ref, {}, pool);

  assert.equal(result.ok, true);
  assert.equal(result.classification, 'explicit_success');
  assert.equal(result.state, 'active');
  assert.equal(result.active, true);
  assert.equal(result.path, activePath(platform, capability));
  assert.equal(fs.existsSync(ref.path), false);

  const active = JSON.parse(fs.readFileSync(result.path, 'utf8'));
  assert.equal(active.endpoint, '/ok');
  assert.equal(active.runtime_meta.post_save_validation, 'passed');
  assert.equal(active.runtime_meta.candidate_verification.classification, 'explicit_success');
  const health = getHealth(platform, capability, 'fetch');
  assert.equal(health.status, 'healthy');
  assert.equal(health.failureCount, 0);
  assert.equal(health.healCount, 1);
});

test('explicit failure keeps candidate inactive and preserves prior active bytes', async () => {
  const platform = 'candidate-failure';
  const capability = 'list_items';
  const priorPath = writeActive(platform, capability, strategy('/ok'));
  const priorBytes = fs.readFileSync(priorPath);
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/typed-fail'));
  const candidateBytes = fs.readFileSync(ref.path);

  requests.length = 0;
  const result = await verifyStrategyCandidate(ref, {}, pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'explicit_failure');
  assert.equal(result.state, 'candidate');
  assert.equal(result.active, false);
  assert.deepEqual(requests, ['/typed-fail']);
  assert.deepEqual(fs.readFileSync(priorPath), priorBytes);
  assert.ok(fs.existsSync(ref.path));
  assert.deepEqual(fs.readFileSync(ref.path), candidateBytes);

  const retained = candidates.loadStrategyCandidate(ref);
  assert.equal(retained.runtime_meta?.candidate_verification, undefined);
  const verification = candidates.loadStrategyCandidateVerification(ref);
  assert.equal(verification.candidate_verification.classification, 'explicit_failure');
  const health = getHealth(platform, capability, 'fetch');
  assert.equal(health.failureCount, 0);
  assert.equal(health.recent, undefined);
});

test('runtime failure preview surfaces decision evidence before large incidental fields', () => {
  const body = {
    params_used: { payload: 'x'.repeat(1200) },
    error: 'all_strategies_failed',
    details: ['prerequisite response code was search_feed_missing'],
    diagnosis: { kind: 'prereq_returned_undefined', prerequisite: 'search_feed' },
  };
  const result = previewBody(body);
  assert.match(result, /all_strategies_failed/);
  assert.match(result, /search_feed_missing/);
  assert.ok(result.indexOf('search_feed_missing') < result.indexOf('params_used'));
});

test('transport-only HTTP 2xx remains an inactive candidate', async () => {
  const platform = 'candidate-transport';
  const capability = 'list_items';
  const ref = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    strategy('/transport-only'),
  );

  const result = await verifyStrategyCandidate(ref, {}, pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.active, false);
  assert.equal(result.semantic_review_required, true);
  assert.match(result.evidence_digest, /^[a-f0-9]{64}$/);
  assert.equal(skills.loadStrategy(platform, capability), null);
  assert.ok(fs.existsSync(ref.path));
  const retained = candidates.loadStrategyCandidate(ref);
  assert.equal(retained.runtime_meta?.post_save_validation, undefined);
  const verification = candidates.loadStrategyCandidateVerification(ref);
  assert.equal(verification.post_save_validation, 'transport_passed');
  assert.equal(verification.candidate_verification.evidence_digest, result.evidence_digest);
});

test('typed LLM review promotes normal transport-only JSON against exact evidence', async () => {
  const platform = 'candidate-reviewed-success';
  const capability = 'list_items';
  const ref = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    strategy('/transport-large'),
  );
  for (let index = 0; index < 5; index += 1) {
    markFailed(platform, capability, 'fetch', `prior reviewed candidate failure ${index}`);
  }
  const verified = await verifyStrategyCandidate(ref, {}, pool);

  assert.equal(verified.active, false);
  assert.equal(verified.body_preview.endsWith('…'), true);
  const pending = reviewStrategyCandidate({
    platform,
    capability,
    candidate_id: ref.candidate_id,
    evidence_digest: verified.evidence_digest,
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.review_required, true);
  assert.equal(pending.evidence.body_truncated, false);
  assert.ok(pending.evidence.body.length > verified.body_preview.length);
  assert.match(pending.evidence.body, /x{500}/);

  const reviewed = reviewStrategyCandidate({
    platform,
    capability,
    candidate_id: ref.candidate_id,
    evidence_digest: verified.evidence_digest,
    review_token: pending.review_token,
    verdict: 'verified_success',
    rationale: 'Returen är en JSON-lista med det efterfrågade item-objektet.',
  });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.active, true);
  const active = JSON.parse(fs.readFileSync(reviewed.path, 'utf8'));
  assert.equal(active.runtime_meta.post_save_validation, 'passed');
  assert.equal(active.runtime_meta.candidate_verification.classification, 'transport_accepted');
  assert.equal(active.runtime_meta.semantic_review.verdict, 'verified_success');
  assert.equal(active.runtime_meta.semantic_review.evidence_digest, verified.evidence_digest);
  assert.equal(getHealth(platform, capability, 'fetch').status, 'healthy');
  assert.equal(getHealth(platform, capability, 'fetch').healCount, 1);
  assert.equal(fs.existsSync(ref.path), false);
  assert.equal(fs.existsSync(verificationPath(ref)), false);
  assert.equal(fs.existsSync(ref.path.replace(/\.json$/, '.evidence.json')), false);
});

test('verified_failure and inconclusive reviews never activate a candidate', async () => {
  for (const verdict of ['verified_failure', 'inconclusive']) {
    const platform = `candidate-reviewed-${verdict.replaceAll('_', '-')}`;
    const capability = 'list_items';
    const ref = skills.stageValidatedStrategyCandidate(
      platform,
      capability,
      strategy('/transport-only'),
    );
    const verified = await verifyStrategyCandidate(ref, {}, pool);
    const pending = reviewStrategyCandidate({
      platform,
      capability,
      candidate_id: ref.candidate_id,
      evidence_digest: verified.evidence_digest,
    });
    const reviewed = reviewStrategyCandidate({
      platform,
      capability,
      candidate_id: ref.candidate_id,
      evidence_digest: verified.evidence_digest,
      review_token: pending.review_token,
      verdict,
      rationale: 'Det exakta resultatet räcker inte för att bekräfta capabilityn.',
    });
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.active, false);
    assert.equal(skills.loadStrategy(platform, capability), null);
    assert.equal(fs.existsSync(ref.path), true);
  }
});

test('wrong or stale review bindings cannot change active strategy bytes', async () => {
  const platform = 'candidate-review-binding';
  const capability = 'list_items';
  const ref = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    strategy('/transport-changing'),
  );
  changingEvidenceVersion = 'one';
  const first = await verifyStrategyCandidate(ref, {}, pool);
  const pending = reviewStrategyCandidate({
    platform,
    capability,
    candidate_id: ref.candidate_id,
    evidence_digest: first.evidence_digest,
  });

  const wrongToken = reviewStrategyCandidate({
    platform,
    capability,
    candidate_id: ref.candidate_id,
    evidence_digest: first.evidence_digest,
    review_token: 'unknown-review-token',
    verdict: 'verified_success',
    rationale: 'The exact returned item satisfies the requested list operation.',
  });
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.reason, 'token_unknown_or_expired');
  assert.equal(skills.loadStrategy(platform, capability), null);

  changingEvidenceVersion = 'two';
  const second = await verifyStrategyCandidate(ref, {}, pool);
  assert.notEqual(second.evidence_digest, first.evidence_digest);
  assert.throws(
    () =>
      reviewStrategyCandidate({
        platform,
        capability,
        candidate_id: ref.candidate_id,
        evidence_digest: first.evidence_digest,
        review_token: pending.review_token,
        verdict: 'verified_success',
        rationale: 'The exact returned item satisfies the requested list operation.',
      }),
    (error) =>
      error instanceof candidates.StrategyCandidateError &&
      error.code === 'strategy_candidate_evidence_mismatch',
  );
  assert.equal(skills.loadStrategy(platform, capability), null);
});

test('reviewed promotion still compare-and-swaps the staged active baseline', async () => {
  const platform = 'candidate-reviewed-cas';
  const capability = 'list_items';
  const ref = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    strategy('/transport-only'),
  );
  const verified = await verifyStrategyCandidate(ref, {}, pool);
  const pending = reviewStrategyCandidate({
    platform,
    capability,
    candidate_id: ref.candidate_id,
    evidence_digest: verified.evidence_digest,
  });
  const competingPath = writeActive(platform, capability, strategy('/ok'));
  const competingBytes = fs.readFileSync(competingPath);

  assert.throws(
    () =>
      reviewStrategyCandidate({
        platform,
        capability,
        candidate_id: ref.candidate_id,
        evidence_digest: verified.evidence_digest,
        review_token: pending.review_token,
        verdict: 'verified_success',
        rationale: 'The returned items array is the requested capability result.',
      }),
    (error) =>
      error instanceof candidates.StrategyCandidateError &&
      error.code === 'strategy_candidate_promotion_conflict',
  );
  assert.deepEqual(fs.readFileSync(competingPath), competingBytes);
  assert.equal(fs.existsSync(ref.path), true);
});

test('different candidate payloads are hash-addressed independently', () => {
  const platform = 'candidate-hashes';
  const capability = 'list_items';
  const first = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/ok'));
  const second = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    strategy('/typed-fail'),
  );

  assert.notEqual(first.candidate_id, second.candidate_id);
  assert.notEqual(first.path, second.path);
  assert.ok(fs.existsSync(first.path));
  assert.ok(fs.existsSync(second.path));
});

test('promotion ignores fabricated call arguments when the verification sidecar is absent', () => {
  const platform = 'candidate-sidecar-required';
  const capability = 'list_items';
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/ok'));
  fs.unlinkSync(verificationPath(ref));

  assert.throws(
    () => candidates.promoteStrategyCandidate(ref, successfulVerification(ref)),
    (error) =>
      error instanceof candidates.StrategyCandidateError &&
      error.code === 'strategy_candidate_verification_missing',
  );
  assert.equal(fs.existsSync(ref.path), true);
  assert.equal(fs.existsSync(activePath(platform, capability)), false);
});

test('a later candidate promotion makes an earlier verified candidate stale', () => {
  const platform = 'candidate-promotion-order';
  const capability = 'list_items';
  const first = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/ok'));
  const second = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    strategy('/transport-only'),
  );
  const firstSidecar = JSON.parse(fs.readFileSync(verificationPath(first), 'utf8'));
  const secondSidecar = JSON.parse(fs.readFileSync(verificationPath(second), 'utf8'));
  assert.equal(firstSidecar.schema_version, 2);
  assert.equal(firstSidecar.candidate_digest, first.candidate_id.slice(`${first.tier}-`.length));
  assert.deepEqual(firstSidecar.baseline_active, { state: 'absent' });
  assert.deepEqual(secondSidecar.baseline_active, { state: 'absent' });
  candidates.writeStrategyCandidateVerification(first, successfulVerification(first));
  candidates.writeStrategyCandidateVerification(second, successfulVerification(second));

  const promotedPath = candidates.promoteStrategyCandidate(second);
  const promotedBytes = fs.readFileSync(promotedPath);

  assert.throws(
    () => candidates.promoteStrategyCandidate(first),
    (error) =>
      error instanceof candidates.StrategyCandidateError &&
      error.code === 'strategy_candidate_promotion_conflict',
  );
  assert.deepEqual(fs.readFileSync(promotedPath), promotedBytes);
  assert.equal(JSON.parse(promotedBytes).endpoint, '/transport-only');
  assert.equal(fs.existsSync(first.path), true);
  assert.equal(fs.existsSync(verificationPath(first)), true);
});

test('candidate bytes are immutable and digest-checked before promotion', () => {
  const platform = 'candidate-tamper';
  const capability = 'list_items';
  const priorPath = writeActive(platform, capability, strategy('/ok'));
  const priorBytes = fs.readFileSync(priorPath);
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/typed-fail'));
  candidates.writeStrategyCandidateVerification(ref, successfulVerification(ref));

  fs.appendFileSync(ref.path, ' ');

  assert.throws(
    () => candidates.promoteStrategyCandidate(ref),
    /strategy_candidate_digest_mismatch/,
  );
  assert.deepEqual(fs.readFileSync(priorPath), priorBytes);
});

test('an active commit that wins before promotion is preserved by candidate CAS', () => {
  const platform = 'candidate-commit-wins';
  const capability = 'list_items';
  writeActive(platform, capability, strategy('/ok'));
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/typed-fail'));
  candidates.writeStrategyCandidateVerification(ref, successfulVerification(ref));

  const committedPath = skills.commitValidatedStrategy(
    platform,
    capability,
    strategy('/transport-only'),
  );
  const committedBytes = fs.readFileSync(committedPath);

  assert.throws(
    () => candidates.promoteStrategyCandidate(ref),
    (error) =>
      error instanceof candidates.StrategyCandidateError &&
      error.code === 'strategy_candidate_promotion_conflict',
  );
  assert.deepEqual(fs.readFileSync(committedPath), committedBytes);
  assert.equal(JSON.parse(committedBytes).endpoint, '/transport-only');
  assert.equal(fs.existsSync(ref.path), true);
  assert.equal(fs.existsSync(verificationPath(ref)), true);
});

test('commit cannot interleave between promotion baseline check and atomic rename', () => {
  const platform = 'candidate-commit-interleave';
  const capability = 'list_items';
  writeActive(platform, capability, strategy('/ok'));
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/typed-fail'));
  candidates.writeStrategyCandidateVerification(ref, successfulVerification(ref));

  const result = promoteAtRenameWithCompetingMutation(ref, () => {
    skills.commitValidatedStrategy(platform, capability, strategy('/transport-only'));
  });

  assertCapabilityMutationConflict(result);
  assert.equal(JSON.parse(fs.readFileSync(result.promotedPath, 'utf8')).endpoint, '/typed-fail');
});

test('runtime-meta stamp cannot interleave with candidate promotion', () => {
  const platform = 'candidate-stamp-interleave';
  const capability = 'list_items';
  writeActive(platform, capability, strategy('/ok'));
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/typed-fail'));
  candidates.writeStrategyCandidateVerification(ref, successfulVerification(ref));

  const result = promoteAtRenameWithCompetingMutation(ref, () => {
    skills.stampRuntimeMeta(platform, capability, { probe_warnings: ['competing stamp'] });
  });

  assertCapabilityMutationConflict(result);
  const active = JSON.parse(fs.readFileSync(result.promotedPath, 'utf8'));
  assert.equal(active.endpoint, '/typed-fail');
  assert.equal(active.runtime_meta.probe_warnings, undefined);
  assert.equal(active.runtime_meta.candidate_verification.classification, 'explicit_success');
});

test('archive cannot interleave with candidate promotion', () => {
  const platform = 'candidate-archive-interleave';
  const capability = 'list_items';
  writeActive(platform, capability, strategy('/ok'));
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/typed-fail'));
  candidates.writeStrategyCandidateVerification(ref, successfulVerification(ref));

  const result = promoteAtRenameWithCompetingMutation(ref, () => {
    skills.archiveStrategy(platform, capability, 'fetch', 'competing archive');
  });

  assertCapabilityMutationConflict(result);
  assert.equal(JSON.parse(fs.readFileSync(result.promotedPath, 'utf8')).endpoint, '/typed-fail');
  assert.equal(
    fs.existsSync(path.join(TMP, 'skills', platform, 'fetch', `${capability}.broken.json`)),
    false,
  );
});

test('demotion cannot interleave with candidate promotion', () => {
  const platform = 'candidate-demotion-interleave';
  const capability = 'list_items';
  writeActive(platform, capability, strategy('/ok'));
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/typed-fail'));
  candidates.writeStrategyCandidateVerification(ref, successfulVerification(ref));

  const result = promoteAtRenameWithCompetingMutation(ref, () => {
    skills.demoteFetchToPageScript(platform, capability);
  });

  assertCapabilityMutationConflict(result);
  assert.equal(JSON.parse(fs.readFileSync(result.promotedPath, 'utf8')).endpoint, '/typed-fail');
  assert.equal(
    fs.existsSync(path.join(TMP, 'skills', platform, 'scripts', `${capability}.json`)),
    false,
  );
});

test('the capability mutation lock rejects promotion and commit across processes', async () => {
  const platform = 'candidate-cross-process';
  const capability = 'list_items';
  writeActive(platform, capability, strategy('/ok'));
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy('/typed-fail'));
  candidates.writeStrategyCandidateVerification(ref, successfulVerification(ref));

  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'dist', 'strategies', 'capability-mutation.js'),
  ).href;
  const childSource = `
    import fs from 'node:fs';
    const [moduleUrl, platform, capability] = process.argv.slice(1);
    const { withCapabilityMutationLock } = await import(moduleUrl);
    withCapabilityMutationLock(platform, capability, () => {
      process.send?.({ ready: true });
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    });
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', childSource, moduleUrl, platform, capability],
    {
      env: { ...process.env, KLURA_HOME: TMP },
      stdio: ['pipe', 'ignore', 'inherit', 'ipc'],
    },
  );
  const exitPromise = once(child, 'exit');
  const [message] = await once(child, 'message');
  assert.deepEqual(message, { ready: true });

  assert.throws(
    () => candidates.promoteStrategyCandidate(ref),
    (error) =>
      error instanceof candidates.StrategyCandidateError &&
      error.code === 'strategy_candidate_promotion_locked',
  );
  assert.throws(
    () => skills.commitValidatedStrategy(platform, capability, strategy('/transport-only')),
    (error) =>
      error instanceof mutations.CapabilityMutationLockError &&
      error.code === 'capability_mutation_locked',
  );

  child.stdin.end('x');
  const [exitCode, signal] = await exitPromise;
  assert.equal(signal, null);
  assert.equal(exitCode, 0);
  const promotedPath = candidates.promoteStrategyCandidate(ref);
  assert.equal(JSON.parse(fs.readFileSync(promotedPath, 'utf8')).endpoint, '/typed-fail');
});

test('a process killed inside the capability lock leaves a recoverable owner lease', async () => {
  const platform = 'candidate-killed-lock-owner';
  const capability = 'list_items';
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'dist', 'strategies', 'capability-mutation.js'),
  ).href;
  const childSource = `
    import fs from 'node:fs';
    const [moduleUrl, platform, capability] = process.argv.slice(1);
    const { withCapabilityMutationLock } = await import(moduleUrl);
    withCapabilityMutationLock(platform, capability, () => {
      process.send?.({ ready: true });
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    });
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', childSource, moduleUrl, platform, capability],
    {
      env: { ...process.env, KLURA_HOME: TMP },
      stdio: ['pipe', 'ignore', 'inherit', 'ipc'],
    },
  );
  const exitPromise = once(child, 'exit');
  const [message] = await once(child, 'message');
  assert.deepEqual(message, { ready: true });
  child.kill('SIGKILL');
  const [, signal] = await exitPromise;
  assert.equal(signal, 'SIGKILL');
  assert.equal(fs.existsSync(capabilityLockPath(platform, capability)), true);

  const committedPath = skills.commitValidatedStrategy(
    platform,
    capability,
    strategy('/transport-only'),
  );
  assert.equal(JSON.parse(fs.readFileSync(committedPath, 'utf8')).endpoint, '/transport-only');
  assert.equal(fs.existsSync(capabilityLockPath(platform, capability)), false);
});

test('fresh malformed locks fail closed, while aged malformed locks recover once', () => {
  const platform = 'candidate-malformed-lock';
  const capability = 'list_items';
  const lockPath = capabilityLockPath(platform, capability);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '');

  assert.throws(
    () => skills.commitValidatedStrategy(platform, capability, strategy('/ok')),
    (error) =>
      error instanceof mutations.CapabilityMutationLockError &&
      error.code === 'capability_mutation_locked',
  );
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);

  const committedPath = skills.commitValidatedStrategy(
    platform,
    capability,
    strategy('/transport-only'),
  );
  assert.equal(JSON.parse(fs.readFileSync(committedPath, 'utf8')).endpoint, '/transport-only');
});

test('a same-pid lock with a nonmatching process nonce is recoverable', () => {
  const platform = 'candidate-nonce-mismatch';
  const capability = 'list_items';
  const lockPath = capabilityLockPath(platform, capability);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      schema_version: 3,
      pid: process.pid,
      process_nonce: '0'.repeat(32),
      acquire_nonce: 'c'.repeat(16),
      process_marker: 'held_file_v1',
      created_at_ms: Date.now(),
    }),
  );

  const committedPath = skills.commitValidatedStrategy(
    platform,
    capability,
    strategy('/transport-only'),
  );
  assert.equal(JSON.parse(fs.readFileSync(committedPath, 'utf8')).endpoint, '/transport-only');
});

test('a live unrelated process cannot keep a stale lease alive through PID reuse', async () => {
  const platform = 'candidate-reused-pid';
  const capability = 'list_items';
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import fs from 'node:fs';
        process.send?.({ ready: true });
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      `,
    ],
    {
      stdio: ['pipe', 'ignore', 'inherit', 'ipc'],
    },
  );
  const exitPromise = once(child, 'exit');
  await once(child, 'message');
  assert.ok(child.pid);

  const nonce = 'b'.repeat(32);
  const lockPath = capabilityLockPath(platform, capability);
  const markerPath = capabilityProcessMarkerPath(child.pid, nonce);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, '');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      schema_version: 3,
      pid: child.pid,
      process_nonce: nonce,
      acquire_nonce: 'c'.repeat(16),
      process_marker: 'held_file_v1',
      created_at_ms: Date.now(),
    }),
  );

  const committedPath = skills.commitValidatedStrategy(
    platform,
    capability,
    strategy('/transport-only'),
  );
  assert.equal(JSON.parse(fs.readFileSync(committedPath, 'utf8')).endpoint, '/transport-only');

  child.stdin.end('x');
  await exitPromise;
});

test('two stale-lock reclaimers admit exactly one critical section', async () => {
  const platform = 'candidate-recovery-race';
  const capability = 'list_items';
  const exited = spawn(process.execPath, ['--input-type=module', '-e', '']);
  const exitedPid = exited.pid;
  assert.ok(exitedPid);
  await once(exited, 'exit');
  const lockPath = capabilityLockPath(platform, capability);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      schema_version: 3,
      pid: exitedPid,
      process_nonce: 'a'.repeat(32),
      acquire_nonce: 'c'.repeat(16),
      process_marker: 'held_file_v1',
      created_at_ms: Date.now(),
    }),
  );

  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'dist', 'strategies', 'capability-mutation.js'),
  ).href;
  const childSource = `
    import fs from 'node:fs';
    const [moduleUrl, platform, capability] = process.argv.slice(1);
    const { withCapabilityMutationLock } = await import(moduleUrl);
    try {
      withCapabilityMutationLock(platform, capability, () => {
        process.send?.({ state: 'acquired' });
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      });
    } catch (error) {
      process.send?.({ state: 'locked', code: error.code });
    }
  `;
  const makeChild = () =>
    spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource, moduleUrl, platform, capability],
      {
        env: { ...process.env, KLURA_HOME: TMP },
        stdio: ['pipe', 'ignore', 'inherit', 'ipc'],
      },
    );
  const first = makeChild();
  const second = makeChild();
  const firstExit = once(first, 'exit');
  const secondExit = once(second, 'exit');
  const [[firstMessage], [secondMessage]] = await Promise.all([
    once(first, 'message'),
    once(second, 'message'),
  ]);
  const states = [firstMessage.state, secondMessage.state].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(states, ['acquired', 'locked']);
  const acquired = firstMessage.state === 'acquired' ? first : second;
  acquired.stdin.end('x');
  await Promise.all([firstExit, secondExit]);
});
