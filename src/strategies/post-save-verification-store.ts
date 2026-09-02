import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR } from '../paths';
import { appendStrategyEvent } from '../working-dir/logbook';
import { withCapabilityMutationLock, writeJsonAtomically } from './capability-mutation';
import {
  assessPostSaveVerificationProof,
  createPostSaveVerificationProof,
  POST_SAVE_PROOF_ASSESSMENT_KINDS,
  type PostSaveVerificationProofV1,
  type PostSaveVerificationTarget,
} from './post-save-verification-proof';
import { STRATEGY_SUBDIR_MAP as SUBDIR_MAP } from './strategy-candidates';
import type { RuntimeMeta, Strategy } from './skills';

export function capturePostSaveVerificationTarget(
  platform: string,
  capability: string,
  tier: Strategy['strategy'],
): PostSaveVerificationTarget {
  const subdir = SUBDIR_MAP[tier];
  if (!subdir) {
    throw new Error(
      `post_save_validation_target_invalid: unsupported tier ${JSON.stringify(tier)}`,
    );
  }
  const filePath = path.join(SKILLS_DIR, platform, subdir, `${capability}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `post_save_validation_target_missing: no active ${tier} strategy exists for ${platform}/${capability}`,
    );
  }
  const strategy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Strategy;
  if (strategy.strategy !== tier) {
    throw new Error(
      `post_save_validation_target_invalid: expected ${tier}, found ${JSON.stringify(strategy.strategy)}`,
    );
  }
  return {
    strategy,
    proof: createPostSaveVerificationProof(platform, capability, strategy),
  };
}

export function loadCurrentPostSaveVerificationTarget(
  proof: PostSaveVerificationProofV1,
): PostSaveVerificationTarget | null {
  const subdir = SUBDIR_MAP[proof.tier];
  if (!subdir) return null;
  const filePath = path.join(SKILLS_DIR, proof.platform, subdir, `${proof.capability}.json`);
  if (!fs.existsSync(filePath)) return null;
  const strategy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Strategy;
  const assessment = assessPostSaveVerificationProof(strategy, proof, {
    platform: proof.platform,
    capability: proof.capability,
  });
  return assessment.kind === POST_SAVE_PROOF_ASSESSMENT_KINDS.current ? { strategy, proof } : null;
}

export function stampPostSaveValidationProof(
  proof: PostSaveVerificationProofV1,
  status: NonNullable<RuntimeMeta['post_save_validation']>,
  retainProof: boolean,
): boolean {
  return withCapabilityMutationLock(proof.platform, proof.capability, () => {
    const subdir = SUBDIR_MAP[proof.tier];
    if (!subdir) return false;
    const filePath = path.join(SKILLS_DIR, proof.platform, subdir, `${proof.capability}.json`);
    if (!fs.existsSync(filePath)) return false;
    const strategy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Strategy;
    const assessment = assessPostSaveVerificationProof(strategy, proof, {
      platform: proof.platform,
      capability: proof.capability,
    });
    if (assessment.kind !== POST_SAVE_PROOF_ASSESSMENT_KINDS.current) return false;

    const runtimeMeta: RuntimeMeta = {
      ...(strategy.runtime_meta ?? {}),
      post_save_validation: status,
    };
    if (retainProof) runtimeMeta.post_save_verification = proof;
    else delete runtimeMeta.post_save_verification;
    strategy.runtime_meta = runtimeMeta;
    writeJsonAtomically(filePath, strategy);
    return true;
  });
}

/**
 * Stamp why a strategy was archived onto the strategy itself.
 *
 * The event stream records archival, but a `.broken.json` is what someone
 * actually opens when they find one — an agent resuming next session, a person
 * reading the home. A file that records no reason for its own archival forces
 * them to go find a separate log to learn why it stopped being used, assuming
 * they know that log exists. The reason belongs where the evidence is.
 */
export function archivedStrategyWithReason(
  strategy: Strategy,
  detail: string,
  tier: string,
): Strategy {
  const meta = (strategy as { runtime_meta?: Record<string, unknown> }).runtime_meta ?? {};
  return {
    ...strategy,
    runtime_meta: {
      ...meta,
      archived_reason: detail,
      archived_at: Date.now(),
      archived_from_tier: tier,
    },
  } as Strategy;
}

export function archivePostSaveValidationTarget(
  proof: PostSaveVerificationProofV1,
  detail: string,
): boolean {
  return withCapabilityMutationLock(proof.platform, proof.capability, () => {
    const subdir = SUBDIR_MAP[proof.tier];
    if (!subdir) return false;
    const activePath = path.join(SKILLS_DIR, proof.platform, subdir, `${proof.capability}.json`);
    if (!fs.existsSync(activePath)) return false;
    const strategy = JSON.parse(fs.readFileSync(activePath, 'utf8')) as Strategy;
    const assessment = assessPostSaveVerificationProof(strategy, proof, {
      platform: proof.platform,
      capability: proof.capability,
    });
    if (assessment.kind !== POST_SAVE_PROOF_ASSESSMENT_KINDS.current) return false;

    const archivedPath = path.join(
      SKILLS_DIR,
      proof.platform,
      subdir,
      `${proof.capability}.broken.json`,
    );
    fs.writeFileSync(
      archivedPath,
      JSON.stringify(archivedStrategyWithReason(strategy, detail, proof.tier), null, 2),
    );
    fs.rmSync(activePath, { force: true });
    appendStrategyEvent(proof.platform, proof.capability, {
      strategy: proof.tier,
      kind: 'archived',
      detail,
    });
    return true;
  });
}
