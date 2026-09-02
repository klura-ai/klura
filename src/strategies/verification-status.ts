// What a capability's verification stamp is actually worth, in one shape.
//
// `runtime_meta.post_save_validation` records that a strategy once passed
// post-save verification. It does not record WHICH verifier passed it, and the
// verifier changes: a contract revision, a stricter execution context, a new
// structural check. A stamp earned under a retired contract is a claim about a
// run nobody would accept today, and read on its own it is indistinguishable
// from one earned a minute ago.
//
// `assessPostSaveVerificationProof` already answers that question — it compares
// the stored proof's contract, scope and artifact digest against the current
// ones. What was missing is that nothing carried the answer to the surfaces an
// agent consults when deciding whether to trust a capability. The claim and its
// qualifier were stored together and reported apart.
//
// This projects both into one value. Nothing here re-verifies anything; it
// reports what is already on disk.

import {
  assessPostSaveVerificationProof,
  POST_SAVE_PROOF_ASSESSMENT_KINDS,
} from './post-save-verification-proof';
import type { Strategy } from './skills';

/** How much weight a stamp carries, given the proof standing behind it. */
export interface VerificationStatus {
  /** The stamp as stored: `passed`, `transport_passed`, or absent. */
  stamp: string | null;
  /**
   * Assessment of the proof behind the stamp. `current` is the only value that
   * means "this verifier would grant it again"; `missing` means the strategy
   * predates the proof entirely.
   */
  proof: string;
  /**
   * Present whenever `proof` is anything but `current` — one line saying what
   * the stamp does and does not establish, so a reader who sees only this field
   * is not misled by the stamp beside it.
   */
  advisory?: string;
}

function advisoryFor(stamp: string, proof: string): string | undefined {
  if (proof === POST_SAVE_PROOF_ASSESSMENT_KINDS.current) return undefined;
  if (proof === POST_SAVE_PROOF_ASSESSMENT_KINDS.missing) {
    return (
      `stamped "${stamp}" with no verification proof attached — the strategy predates the proof ` +
      `record, so which verifier granted it is unknown and today's would not necessarily agree. ` +
      `Treat as unverified under the current contract until it is re-verified.`
    );
  }
  if (proof === POST_SAVE_PROOF_ASSESSMENT_KINDS.verifierChanged) {
    return (
      `stamped "${stamp}" by a retired verifier contract. The run behind this stamp is not one the ` +
      `current verifier performed, so the stamp does not establish that it would pass now.`
    );
  }
  if (proof === POST_SAVE_PROOF_ASSESSMENT_KINDS.artifactChanged) {
    return (
      `stamped "${stamp}", but the proof describes different strategy bytes than the ones on disk — ` +
      `the strategy changed after it was verified, so the stamp describes an artifact that no longer exists.`
    );
  }
  if (proof === POST_SAVE_PROOF_ASSESSMENT_KINDS.scopeChanged) {
    return (
      `stamped "${stamp}", but the proof was issued for a different platform/capability pair. ` +
      `It does not describe this capability.`
    );
  }
  return (
    `stamped "${stamp}" with a proof that could not be read (${proof}), so the stamp cannot be ` +
    `traced to a verification run.`
  );
}

/**
 * Verification status for one saved strategy, or `null` when it carries no
 * stamp at all — an unstamped strategy makes no claim, so there is nothing to
 * qualify and nothing worth spending response budget on.
 */
export function verificationStatus(
  strategy: Strategy,
  expected: { platform: string; capability: string },
): VerificationStatus | null {
  const meta = (strategy as { runtime_meta?: Record<string, unknown> }).runtime_meta;
  const stamp = typeof meta?.post_save_validation === 'string' ? meta.post_save_validation : null;
  if (!stamp) return null;
  const assessment = assessPostSaveVerificationProof(
    strategy,
    meta?.post_save_verification,
    expected,
  );
  const advisory = advisoryFor(stamp, assessment.kind);
  return { stamp, proof: assessment.kind, ...(advisory ? { advisory } : {}) };
}
