// `post_save_validation: "passed"` records that a strategy once passed. It does
// not record which verifier passed it, and the verifier changes. A stamp earned
// under a retired contract read on its own is indistinguishable from one earned
// a minute ago — at exactly the moment a reader decides whether to trust the
// capability.
//
// These pin that the qualifier travels with the claim.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-verification-status-'));
process.env.KLURA_HOME = TMP;
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { verificationStatus } = await import('../dist/strategies/verification-status.js');
const { createPostSaveVerificationProof } = await import(
  '../dist/strategies/post-save-verification-proof.js'
);

const SCOPE = { platform: 'acme', capability: 'list_things' };

function strategy(runtime_meta) {
  return {
    strategy: 'fetch',
    baseUrl: 'https://acme.test',
    endpoint: '/api/things',
    ...(runtime_meta ? { runtime_meta } : {}),
  };
}

test('an unstamped strategy makes no claim, so there is nothing to qualify', () => {
  assert.equal(verificationStatus(strategy(), SCOPE), null);
  assert.equal(verificationStatus(strategy({ save_warnings: [] }), SCOPE), null);
});

test('a stamp with a current proof stands on its own — no advisory', () => {
  const s = strategy({ post_save_validation: 'passed' });
  s.runtime_meta.post_save_verification = createPostSaveVerificationProof(
    SCOPE.platform,
    SCOPE.capability,
    s,
  );
  const status = verificationStatus(s, SCOPE);
  assert.equal(status.stamp, 'passed');
  assert.equal(status.proof, 'current');
  assert.equal(status.advisory, undefined, 'a current proof needs no qualifier');
});

test('a stamp with no proof at all is reported as unverified under this contract', () => {
  // The shape every strategy saved before the proof record carries.
  const status = verificationStatus(strategy({ post_save_validation: 'passed' }), SCOPE);
  assert.equal(status.stamp, 'passed');
  assert.equal(status.proof, 'missing');
  assert.match(status.advisory, /no verification proof attached/);
  assert.match(status.advisory, /unverified under the current contract/);
});

test('a proof from a retired verifier contract does not establish a current pass', () => {
  const s = strategy({ post_save_validation: 'passed' });
  const proof = createPostSaveVerificationProof(SCOPE.platform, SCOPE.capability, s);
  s.runtime_meta.post_save_verification = { ...proof, verifier_contract: 'post-save-v0' };
  const status = verificationStatus(s, SCOPE);
  assert.equal(status.proof, 'verifier_changed');
  assert.match(status.advisory, /retired verifier contract/);
});

test('a proof describing different bytes than the ones on disk is called out', () => {
  const s = strategy({ post_save_validation: 'passed' });
  s.runtime_meta.post_save_verification = createPostSaveVerificationProof(
    SCOPE.platform,
    SCOPE.capability,
    s,
  );
  s.endpoint = '/api/things?changed=1'; // re-saved after verification
  const status = verificationStatus(s, SCOPE);
  assert.equal(status.proof, 'artifact_changed');
  assert.match(status.advisory, /no longer exists/);
});

test('the qualifier travels with a transport_passed stamp too, not just passed', () => {
  const status = verificationStatus(strategy({ post_save_validation: 'transport_passed' }), SCOPE);
  assert.equal(status.stamp, 'transport_passed');
  assert.match(status.advisory, /transport_passed/, 'the advisory names the stamp it qualifies');
});
