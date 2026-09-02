import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, type JsonValueV1 } from '../public/contracts/json';
import { STRATEGY_TIERS } from '../vocab';
import type { Strategy } from './skills';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const POST_SAVE_VERIFIER_CONTRACT = 'post-save-verification-v1' as const;

export const PostSaveVerificationProofSchema = z
  .object({
    schema_version: z.literal(1),
    platform: z.string().min(1),
    capability: z.string().min(1),
    tier: z.enum(STRATEGY_TIERS),
    strategy_digest: z.string().regex(SHA256_PATTERN),
    runtime_build_id: z.string().regex(SHA256_PATTERN),
    verifier_contract: z.string().min(1).max(100),
  })
  .strict();

export type PostSaveVerificationProofV1 = z.infer<typeof PostSaveVerificationProofSchema>;

export interface PostSaveVerificationTarget {
  strategy: Strategy;
  proof: PostSaveVerificationProofV1;
}

export const POST_SAVE_PROOF_ASSESSMENT_KINDS = {
  current: 'current',
  missing: 'missing',
  malformed: 'malformed',
  scopeChanged: 'scope_changed',
  artifactChanged: 'artifact_changed',
  verifierChanged: 'verifier_changed',
} as const;

export type PostSaveProofAssessment =
  | {
      kind: typeof POST_SAVE_PROOF_ASSESSMENT_KINDS.current;
      proof: PostSaveVerificationProofV1;
    }
  | { kind: typeof POST_SAVE_PROOF_ASSESSMENT_KINDS.missing }
  | {
      kind: typeof POST_SAVE_PROOF_ASSESSMENT_KINDS.malformed;
      issues: Array<{ path: string; message: string }>;
    }
  | {
      kind: typeof POST_SAVE_PROOF_ASSESSMENT_KINDS.scopeChanged;
      fields: Array<'platform' | 'capability'>;
    }
  | {
      kind: typeof POST_SAVE_PROOF_ASSESSMENT_KINDS.artifactChanged;
      fields: Array<'tier' | 'strategy_digest'>;
      actual_strategy_digest: string;
    }
  | {
      kind: typeof POST_SAVE_PROOF_ASSESSMENT_KINDS.verifierChanged;
      expected_contract: typeof POST_SAVE_VERIFIER_CONTRACT;
      proof_contract: string;
    };

function strategyPayload(strategy: Strategy): JsonValueV1 {
  const payload = JSON.parse(JSON.stringify(strategy)) as Record<string, JsonValueV1>;
  const runtimeMeta = payload.runtime_meta;
  if (runtimeMeta && typeof runtimeMeta === 'object' && !Array.isArray(runtimeMeta)) {
    const retained = { ...(runtimeMeta as Record<string, JsonValueV1>) };
    delete retained.post_save_validation;
    delete retained.post_save_verification;
    delete retained.candidate_verification;
    delete retained.semantic_review;
    if (Object.keys(retained).length > 0) payload.runtime_meta = retained;
    else delete payload.runtime_meta;
  }
  return payload;
}

export function postSaveStrategyDigest(strategy: Strategy): string {
  return crypto
    .createHash('sha256')
    .update(canonicalJson(strategyPayload(strategy)))
    .digest('hex');
}

export function readRuntimeBuildId(): string {
  const buildInfoPath = path.join(__dirname, '..', 'build-info.json');
  const parsed = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')) as {
    build_id?: unknown;
  };
  if (typeof parsed.build_id !== 'string' || !SHA256_PATTERN.test(parsed.build_id)) {
    throw new Error(
      'runtime_build_invalid: dist/build-info.json does not contain a valid build_id. Run `npm run build`.',
    );
  }
  return parsed.build_id;
}

export function createPostSaveVerificationProof(
  platform: string,
  capability: string,
  strategy: Strategy,
  runtimeBuildId = readRuntimeBuildId(),
): PostSaveVerificationProofV1 {
  return PostSaveVerificationProofSchema.parse({
    schema_version: 1,
    platform,
    capability,
    tier: strategy.strategy,
    strategy_digest: postSaveStrategyDigest(strategy),
    runtime_build_id: runtimeBuildId,
    verifier_contract: POST_SAVE_VERIFIER_CONTRACT,
  });
}

export function assessPostSaveVerificationProof(
  strategy: Strategy,
  proofInput: unknown,
  expected: { platform: string; capability: string },
): PostSaveProofAssessment {
  if (proofInput === undefined || proofInput === null) {
    return { kind: POST_SAVE_PROOF_ASSESSMENT_KINDS.missing };
  }
  const parsed = PostSaveVerificationProofSchema.safeParse(proofInput);
  if (!parsed.success) {
    return {
      kind: POST_SAVE_PROOF_ASSESSMENT_KINDS.malformed,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    };
  }
  const proof = parsed.data;
  const scopeFields: Array<'platform' | 'capability'> = [];
  if (proof.platform !== expected.platform) scopeFields.push('platform');
  if (proof.capability !== expected.capability) scopeFields.push('capability');
  if (scopeFields.length > 0) {
    return {
      kind: POST_SAVE_PROOF_ASSESSMENT_KINDS.scopeChanged,
      fields: scopeFields,
    };
  }
  if (proof.verifier_contract !== POST_SAVE_VERIFIER_CONTRACT) {
    return {
      kind: POST_SAVE_PROOF_ASSESSMENT_KINDS.verifierChanged,
      expected_contract: POST_SAVE_VERIFIER_CONTRACT,
      proof_contract: proof.verifier_contract,
    };
  }
  const actualDigest = postSaveStrategyDigest(strategy);
  const artifactFields: Array<'tier' | 'strategy_digest'> = [];
  if (proof.tier !== strategy.strategy) artifactFields.push('tier');
  if (proof.strategy_digest !== actualDigest) artifactFields.push('strategy_digest');
  if (artifactFields.length > 0) {
    return {
      kind: POST_SAVE_PROOF_ASSESSMENT_KINDS.artifactChanged,
      fields: artifactFields,
      actual_strategy_digest: actualDigest,
    };
  }
  return { kind: POST_SAVE_PROOF_ASSESSMENT_KINDS.current, proof };
}
