import test from 'node:test';
import assert from 'node:assert/strict';

const {
  assessPostSaveVerificationProof,
  createPostSaveVerificationProof,
  POST_SAVE_PROOF_ASSESSMENT_KINDS,
  POST_SAVE_VERIFIER_CONTRACT,
} = await import('../dist/strategies/post-save-verification-proof.js');

const BUILD_A = 'a'.repeat(64);
const BUILD_B = 'b'.repeat(64);

function strategy(endpoint = '/items') {
  return {
    strategy: 'fetch',
    baseUrl: 'https://example.test',
    endpoint,
    method: 'GET',
    transport: 'node',
    schema_version: 1,
  };
}

test('one canonical assessor accepts the exact strategy proof', () => {
  const saved = strategy();
  const proof = createPostSaveVerificationProof('example', 'list_items', saved, BUILD_A);

  const assessment = assessPostSaveVerificationProof(saved, proof, {
    platform: 'example',
    capability: 'list_items',
  });

  assert.equal(assessment.kind, POST_SAVE_PROOF_ASSESSMENT_KINDS.current);
  assert.equal(assessment.proof.runtime_build_id, BUILD_A);
  assert.equal(assessment.proof.verifier_contract, POST_SAVE_VERIFIER_CONTRACT);
});

test('runtime build identity is provenance and does not invalidate a stable verifier contract', () => {
  const saved = strategy();
  const proof = createPostSaveVerificationProof('example', 'list_items', saved, BUILD_A);
  const copiedByAnotherBuild = { ...proof, runtime_build_id: BUILD_B };

  const assessment = assessPostSaveVerificationProof(saved, copiedByAnotherBuild, {
    platform: 'example',
    capability: 'list_items',
  });

  assert.equal(assessment.kind, POST_SAVE_PROOF_ASSESSMENT_KINDS.current);
});

test('verifier contract changes are distinct from artifact changes', () => {
  const saved = strategy();
  const proof = createPostSaveVerificationProof('example', 'list_items', saved, BUILD_A);

  const assessment = assessPostSaveVerificationProof(
    saved,
    { ...proof, verifier_contract: 'post-save-verification-v2' },
    {
      platform: 'example',
      capability: 'list_items',
    },
  );

  assert.equal(assessment.kind, POST_SAVE_PROOF_ASSESSMENT_KINDS.verifierChanged);
});

test('strategy bytes and sibling tiers cannot reuse another artifact proof', () => {
  const saved = strategy();
  const proof = createPostSaveVerificationProof('example', 'list_items', saved, BUILD_A);

  const changedBytes = assessPostSaveVerificationProof(strategy('/items-v2'), proof, {
    platform: 'example',
    capability: 'list_items',
  });
  const siblingTier = assessPostSaveVerificationProof(
    { ...saved, strategy: 'page-script' },
    proof,
    {
      platform: 'example',
      capability: 'list_items',
    },
  );

  assert.equal(changedBytes.kind, POST_SAVE_PROOF_ASSESSMENT_KINDS.artifactChanged);
  assert.deepEqual(changedBytes.fields, ['strategy_digest']);
  assert.equal(siblingTier.kind, POST_SAVE_PROOF_ASSESSMENT_KINDS.artifactChanged);
  assert.deepEqual(siblingTier.fields, ['tier', 'strategy_digest']);
});

test('missing and malformed proofs have typed outcomes', () => {
  const saved = strategy();

  assert.equal(
    assessPostSaveVerificationProof(saved, undefined, {
      platform: 'example',
      capability: 'list_items',
    }).kind,
    POST_SAVE_PROOF_ASSESSMENT_KINDS.missing,
  );
  assert.equal(
    assessPostSaveVerificationProof(
      saved,
      { schema_version: 1 },
      {
        platform: 'example',
        capability: 'list_items',
      },
    ).kind,
    POST_SAVE_PROOF_ASSESSMENT_KINDS.malformed,
  );
});
