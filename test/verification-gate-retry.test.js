// Post-save verification runs in a fresh context so a strategy cannot pass on
// state the authoring session happened to hold. That is right for defences a
// browser can clear by itself — Reddit's JS challenge is re-solved by any real
// browser, and a fresh context verifies through it every time.
//
// It is wrong for a gate that wants a human. A Google consent interstitial
// stopped verification on capabilities whose strategies were sound, so they
// stayed inactive candidates and read as broken.
//
// The distinction is structural, never a guess about the destination: a gate
// carries the requested URL as a parameter on wherever it sent you, because it
// intends to return you there. A moved or withdrawn page does not.

import test from 'node:test';
import assert from 'node:assert';

import { navigationReachMissFrom } from '../dist/execution/navigation-reach.js';
import { PostSaveVerificationProofSchema } from '../dist/strategies/post-save-verification-proof.js';

test('a gate is told apart from a moved page by how it carries the URL', async () => {
  const { NavigationReachError } = await import('../dist/execution/navigation-reach.js');
  const gate = new NavigationReachError(
    'gate',
    {
      requested: 'https://www.google.com/maps/place/X',
      reached: 'https://consent.google.com/m?continue=https://www.google.com/maps/place/X',
      requested_carried_as_parameter: true,
    },
    'photos',
  );
  const moved = new NavigationReachError(
    'moved',
    {
      requested: 'https://site.test/old',
      reached: 'https://site.test/not-found',
      requested_carried_as_parameter: false,
    },
    'photos',
  );
  assert.equal(navigationReachMissFrom(gate)?.requested_carried_as_parameter, true);
  assert.equal(navigationReachMissFrom(moved)?.requested_carried_as_parameter, false);
  // And through a wrapping error, which is how it actually surfaces.
  const wrapped = new Error('execute failed', { cause: gate });
  assert.equal(navigationReachMissFrom(wrapped)?.requested_carried_as_parameter, true);
});

test('the proof can record that it was obtained under the platform session', () => {
  const proof = {
    schema_version: 1,
    platform: 'p',
    capability: 'c',
    tier: 'page-script',
    strategy_digest: 'a'.repeat(64),
    runtime_build_id: 'b'.repeat(64),
    verifier_contract: 'post-save-verification-v1',
    session_context: 'platform_session',
  };
  assert.equal(PostSaveVerificationProofSchema.parse(proof).session_context, 'platform_session');
});

test('a proof written before the field existed still validates', () => {
  // Absent means fresh — that was the only path when those proofs were written.
  const legacy = {
    schema_version: 1,
    platform: 'p',
    capability: 'c',
    tier: 'fetch',
    strategy_digest: 'a'.repeat(64),
    runtime_build_id: 'b'.repeat(64),
    verifier_contract: 'post-save-verification-v1',
  };
  assert.equal(PostSaveVerificationProofSchema.parse(legacy).session_context, undefined);
});

test('an unknown session context is refused', () => {
  assert.throws(() =>
    PostSaveVerificationProofSchema.parse({
      schema_version: 1,
      platform: 'p',
      capability: 'c',
      tier: 'fetch',
      strategy_digest: 'a'.repeat(64),
      runtime_build_id: 'b'.repeat(64),
      verifier_contract: 'post-save-verification-v1',
      session_context: 'whatever',
    }),
  );
});

// The cascade usually does NOT throw a reach error: it folds the prereq failure
// into an `all_strategies_failed` body and returns normally. A retry that only
// inspected the throw path missed exactly that shape, and two google-maps
// capabilities stayed behind a consent gate the retry existed to clear.

test('the failure body carries reach misses structurally, not only in prose', async () => {
  const { finalizeCascadeFailure } = await import('../dist/execution/index.js');
  const miss = {
    requested: 'https://www.google.com/maps/place/X',
    reached: 'https://consent.google.com/m?continue=https://www.google.com/maps/place/X',
    requested_carried_as_parameter: true,
  };
  const result = finalizeCascadeFailure({}, ['page-script: never reached its target'], null, null, undefined, [miss]);
  const misses = result.body.navigation_reach_misses;
  assert.ok(Array.isArray(misses), 'no structured misses on the failure body');
  assert.equal(misses[0].requested_carried_as_parameter, true);
});

test('a failure with no reach miss carries no such field', () => {
  // Absence is meaningful: it means nothing gate-shaped happened.
  return import('../dist/execution/index.js').then(({ finalizeCascadeFailure }) => {
    const result = finalizeCascadeFailure({}, ['fetch: 404'], null, null);
    assert.equal(result.body.navigation_reach_misses, undefined);
  });
});
