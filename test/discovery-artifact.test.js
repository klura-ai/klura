// Unit tests for the discovery-artifact module: schema, merge, PII scanner.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// KLURA_HOME must be set before the module loads — its read/write helpers
// resolve the home dir at call time, so the env var has to be present when
// they fire. Set here so each test's fs operations land in a tmp dir.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-discovery-artifact-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const {
  validateDiscoveryArtifactShape,
  buildAndMergeArtifact,
  writeArtifact,
  readArtifactFromDisk,
  listArtifactsForPlatform,
  RESUME_POINTER_KINDS,
} = await import('../dist/strategies/discovery-artifact.js');

// ---- Schema ----

function baseArtifact(over = {}) {
  return {
    schema_version: 1,
    capability: 'send_message',
    created_at: '2026-04-17T12:00:00.000Z',
    updated_at: '2026-04-17T12:05:00.000Z',
    sessions_contributed: 1,
    resume_pointers: [],
    observations: [],
    tool_call_trace: [],
    ...over,
  };
}

test('artifact: minimal valid shape accepted', () => {
  validateDiscoveryArtifactShape(baseArtifact());
});

test('artifact: wrong schema_version rejected', () => {
  assert.throws(
    () => validateDiscoveryArtifactShape(baseArtifact({ schema_version: 2 })),
    /schema_version.*must be 1/,
  );
});

test('artifact: js_source pointer with http URL accepted', () => {
  validateDiscoveryArtifactShape(
    baseArtifact({
      resume_pointers: [
        {
          kind: 'js_source',
          ref: 'https://static.example.com/bundle.js',
          line: 216,
          at: '2026-04-17T12:03:00.000Z',
        },
      ],
    }),
  );
});

test('artifact: js_source pointer with file:// scheme rejected', () => {
  assert.throws(
    () =>
      validateDiscoveryArtifactShape(
        baseArtifact({
          resume_pointers: [
            { kind: 'js_source', ref: 'file:///etc/passwd', at: '2026-04-17T12:00:00.000Z' },
          ],
        }),
      ),
    /scheme.*not allowed/,
  );
});

test('artifact: line on non-js_source pointer rejected', () => {
  assert.throws(
    () =>
      validateDiscoveryArtifactShape(
        baseArtifact({
          resume_pointers: [
            { kind: 'request_index', ref: '5', line: 10, at: '2026-04-17T12:00:00.000Z' },
          ],
        }),
      ),
    /line.*only valid when kind === "js_source"/,
  );
});

test('artifact: duplicate observation rejected', () => {
  assert.throws(
    () =>
      validateDiscoveryArtifactShape(
        baseArtifact({ observations: ['epoch_id', 'otid', 'epoch_id'] }),
      ),
    /duplicate observation/,
  );
});

test('artifact: observation with invalid shape rejected', () => {
  assert.throws(
    () =>
      validateDiscoveryArtifactShape(
        baseArtifact({ observations: ['has spaces'] }),
      ),
    /must match/,
  );
});

test('artifact: recommended_next_steps over cap rejected', () => {
  assert.throws(
    () =>
      validateDiscoveryArtifactShape(
        baseArtifact({ recommended_next_steps: Array(10).fill('step') }),
      ),
    /max 6 entries/,
  );
});

// ---- Merge ----

test('merge: fresh accumulator builds an artifact from session tool calls', () => {
  const accumulator = {
    inspectWsFrameCalls: [
      { ws_i: 493, args_digest: '0123456789abcdef', starter_present: true, at: '2026-04-17T12:00:00.000Z' },
    ],
    tryGeneratorCalls: [
      { args_digest: 'fedcba9876543210', ok: true, at: '2026-04-17T12:01:00.000Z' },
    ],
    getJsSourceCalls: [
      { url: 'https://static.example.com/bundle.js', line: 216, at: '2026-04-17T12:02:00.000Z' },
    ],
    getSendEncoderCalls: [],
    findInPageCalls: [
      { needle_slug: 'epoch_id', matches_count: 2, at: '2026-04-17T12:03:00.000Z' },
    ],
    getAttributeCalls: [],
    getNetworkLogCalls: [],
    agentResumePointers: {},
    recommendedNextSteps: ['grep the bundle for ls_req'],
  };
  const { artifact } = buildAndMergeArtifact(
    'example',
    'send_message',
    accumulator,
    { verify_iterations: 1, verified_ok: 1 },
    { now: '2026-04-17T12:05:00.000Z' },
  );
  assert.strictEqual(artifact.iteration_state.verified_ok, 1);
  assert.strictEqual(artifact.resume_pointers.length, 2); // frame_index + js_source
  assert.ok(artifact.resume_pointers.some((p) => p.kind === 'frame_index'));
  assert.ok(artifact.resume_pointers.some((p) => p.kind === 'js_source' && p.line === 216));
  assert.deepStrictEqual(artifact.observations, ['epoch_id']);
  assert.ok(artifact.tool_call_trace.length >= 3);
  assert.deepStrictEqual(artifact.recommended_next_steps, ['grep the bundle for ls_req']);
});

test('merge: write + read round-trip through disk', () => {
  const accumulator = {
    inspectWsFrameCalls: [],
    tryGeneratorCalls: [],
    getJsSourceCalls: [],
    getSendEncoderCalls: [],
    findInPageCalls: [
      { needle_slug: 'foo_bar', matches_count: 1, at: '2026-04-17T12:00:00.000Z' },
    ],
    getAttributeCalls: [],
    getNetworkLogCalls: [],
    agentResumePointers: {},
    recommendedNextSteps: [],
  };
  const { artifact } = buildAndMergeArtifact(
    'roundtrip',
    'cap',
    accumulator,
    null,
    { now: '2026-04-17T12:05:00.000Z' },
  );
  writeArtifact('roundtrip', 'cap', artifact);
  const read = readArtifactFromDisk('roundtrip', 'cap');
  assert.ok(read);
  assert.strictEqual(read.capability, 'cap');
  assert.deepStrictEqual(read.observations, ['foo_bar']);
  const list = listArtifactsForPlatform('roundtrip');
  assert.deepStrictEqual(list, ['cap']);
});

test('merge: second session increments sessions_contributed and takes max iteration_state', () => {
  const accumulator1 = {
    inspectWsFrameCalls: [],
    tryGeneratorCalls: [],
    getJsSourceCalls: [],
    getSendEncoderCalls: [],
    findInPageCalls: [{ needle_slug: 'first_session', matches_count: 1, at: '2026-04-17T12:00:00.000Z' }],
    getAttributeCalls: [],
    getNetworkLogCalls: [],
    agentResumePointers: {},
    recommendedNextSteps: [],
  };
  const r1 = buildAndMergeArtifact(
    'multisession',
    'cap',
    accumulator1,
    { verify_iterations: 1, verified_ok: 1 },
    { now: '2026-04-17T12:00:00.000Z' },
  );
  writeArtifact('multisession', 'cap', r1.artifact);

  const accumulator2 = {
    inspectWsFrameCalls: [],
    tryGeneratorCalls: [],
    getJsSourceCalls: [],
    getSendEncoderCalls: [],
    findInPageCalls: [{ needle_slug: 'second_session', matches_count: 1, at: '2026-04-17T13:00:00.000Z' }],
    getAttributeCalls: [],
    getNetworkLogCalls: [],
    agentResumePointers: {},
    recommendedNextSteps: [],
  };
  const r2 = buildAndMergeArtifact(
    'multisession',
    'cap',
    accumulator2,
    { verify_iterations: 3, verified_ok: 2 },
    { now: '2026-04-17T13:00:00.000Z' },
  );

  // Both observations survive; iteration_state takes the max.
  assert.strictEqual(r2.artifact.iteration_state.verified_ok, 2);
  assert.strictEqual(r2.artifact.iteration_state.verify_iterations, 3);
  assert.ok(r2.artifact.observations.includes('first_session'));
  assert.ok(r2.artifact.observations.includes('second_session'));
  assert.strictEqual(r2.artifact.sessions_contributed, 2);
});

// ---- Kinds enum coverage ----

test('artifact: every RESUME_POINTER_KIND is accepted at the schema layer', () => {
  for (const kind of RESUME_POINTER_KINDS) {
    const ref = kind === 'js_source' || kind === 'page_url' ? 'https://example.com/x' : 'ref-value';
    validateDiscoveryArtifactShape(
      baseArtifact({
        resume_pointers: [{ kind, ref, at: '2026-04-17T12:00:00.000Z' }],
      }),
    );
  }
});
