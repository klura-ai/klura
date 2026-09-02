import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SKILLS_DIR, STRATEGY_CANDIDATES_DIR } from '../paths';
import { asIdentifierSlug, asPlatformSlug } from '../validators';
import { DECISION_VALUES, STRATEGY_TIERS } from '../vocab';
import { appendStrategyEvent } from '../working-dir/logbook';
import {
  withCapabilityMutationLock,
  writeJsonAtomically,
  writeTextAtomically,
} from './capability-mutation';
import type { RuntimeMeta, Strategy } from './skills';
import {
  assessPostSaveVerificationProof,
  POST_SAVE_PROOF_ASSESSMENT_KINDS,
} from './post-save-verification-proof';

const MAX_REVIEWABLE_EVIDENCE_CHARS = 1_000_000;

export const STRATEGY_SUBDIR_MAP: Record<string, string> = {
  fetch: 'fetch',
  'page-script': 'scripts',
  'recorded-path': 'paths',
};

export interface StrategyCandidateRef {
  platform: string;
  capability: string;
  candidate_id: string;
  tier: Strategy['strategy'];
  path: string;
}

export type ActiveStrategyBaseline = { state: 'absent' } | { state: 'present'; sha256: string };

interface StrategyCandidateSidecarV2 {
  schema_version: 2;
  candidate_id: string;
  candidate_digest: string;
  baseline_active: ActiveStrategyBaseline;
  verification?: {
    runtime_meta: Partial<RuntimeMeta>;
  };
}

export type StrategyCandidateReviewVerdict =
  | typeof DECISION_VALUES.verifiedSuccess
  | typeof DECISION_VALUES.verifiedFailure
  | typeof DECISION_VALUES.inconclusive;

interface StrategyCandidateEvidenceV1 {
  schema_version: 1;
  candidate_id: string;
  candidate_digest: string;
  classification: NonNullable<RuntimeMeta['candidate_verification']>['classification'];
  status: number;
  checked_at_ms: number;
  body_kind: 'json' | 'text' | 'null' | 'undefined' | 'unserializable';
  body_sha256: string;
  body_total_chars: number;
  reviewable: boolean;
  body_text?: string;
  final_url?: string;
}

export interface LoadedStrategyCandidateEvidence extends StrategyCandidateEvidenceV1 {
  evidence_digest: string;
  path: string;
}

export interface StrategyCandidateReviewContext {
  ref: StrategyCandidateRef;
  candidate_digest: string;
  baseline_active: ActiveStrategyBaseline;
  evidence: LoadedStrategyCandidateEvidence;
}

export type StrategyCandidateErrorCode =
  | 'strategy_candidate_verification_missing'
  | 'strategy_candidate_verification_invalid'
  | 'strategy_candidate_not_verified'
  | 'strategy_candidate_evidence_missing'
  | 'strategy_candidate_evidence_invalid'
  | 'strategy_candidate_evidence_mismatch'
  | 'strategy_candidate_evidence_unreviewable'
  | 'strategy_candidate_promotion_locked'
  | 'strategy_candidate_promotion_conflict';

export class StrategyCandidateError extends Error {
  constructor(
    public readonly code: StrategyCandidateErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'StrategyCandidateError';
  }
}

function candidateDirectory(platform: string, capability: string): string {
  return path.join(STRATEGY_CANDIDATES_DIR, platform, capability);
}

const CANDIDATE_ID_RE = new RegExp(`^(?:${STRATEGY_TIERS.join('|')})-[a-f0-9]{64}$`);

function candidatePath(ref: StrategyCandidateRef): string {
  asPlatformSlug(ref.platform, 'candidate.platform');
  asIdentifierSlug(ref.capability, 'candidate.capability');
  if (!CANDIDATE_ID_RE.test(ref.candidate_id)) {
    throw new Error(`strategy_candidate_invalid_id: ${JSON.stringify(ref.candidate_id)}`);
  }
  return path.join(candidateDirectory(ref.platform, ref.capability), `${ref.candidate_id}.json`);
}

function candidateVerificationPath(ref: StrategyCandidateRef): string {
  return path.join(
    candidateDirectory(ref.platform, ref.capability),
    `${ref.candidate_id}.verification.json`,
  );
}

function candidateEvidencePath(ref: StrategyCandidateRef): string {
  return path.join(
    candidateDirectory(ref.platform, ref.capability),
    `${ref.candidate_id}.evidence.json`,
  );
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function resolveStrategyCandidateRef(
  platform: string,
  capability: string,
  candidateId: string,
): StrategyCandidateRef {
  const tier = STRATEGY_TIERS.find((candidateTier) => candidateId.startsWith(`${candidateTier}-`));
  if (!tier) {
    throw new Error(`strategy_candidate_invalid_id: ${JSON.stringify(candidateId)}`);
  }
  const ref: StrategyCandidateRef = {
    platform,
    capability,
    candidate_id: candidateId,
    tier,
    path: '',
  };
  ref.path = candidatePath(ref);
  return ref;
}

interface CheckedStrategyCandidate {
  strategy: Strategy;
  digest: string;
}

function loadCheckedStrategyCandidateRecord(
  ref: StrategyCandidateRef,
): CheckedStrategyCandidate | null {
  const filePath = candidatePath(ref);
  if (!fs.existsSync(filePath)) return null;
  const sourceBytes = fs.readFileSync(filePath, 'utf8');
  const digest = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const expectedId = `${ref.tier}-${digest}`;
  if (expectedId !== ref.candidate_id) {
    throw new Error(
      `strategy_candidate_digest_mismatch: expected ${ref.candidate_id}, found ${expectedId}`,
    );
  }
  const strategy = JSON.parse(sourceBytes) as Strategy;
  if (strategy.strategy !== ref.tier) {
    throw new Error(
      `strategy_candidate_tier_mismatch: expected ${ref.tier}, found ${strategy.strategy}`,
    );
  }
  return { strategy, digest };
}

function loadCheckedStrategyCandidate(ref: StrategyCandidateRef): Strategy | null {
  return loadCheckedStrategyCandidateRecord(ref)?.strategy ?? null;
}

function activeStrategyBaseline(platform: string, capability: string): ActiveStrategyBaseline {
  const activeDigests: Array<{ tier: Strategy['strategy']; sha256: string }> = [];
  for (const tier of STRATEGY_TIERS) {
    const subdir = STRATEGY_SUBDIR_MAP[tier] ?? tier;
    const activePath = path.join(SKILLS_DIR, platform, subdir, `${capability}.json`);
    if (!fs.existsSync(activePath)) continue;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(activePath)).digest('hex');
    activeDigests.push({ tier, sha256: digest });
  }
  if (activeDigests.length === 0) return { state: 'absent' };
  return {
    state: 'present',
    sha256: crypto.createHash('sha256').update(JSON.stringify(activeDigests)).digest('hex'),
  };
}

function baselinesMatch(
  expected: ActiveStrategyBaseline,
  current: ActiveStrategyBaseline,
): boolean {
  if (expected.state === 'absent') return current.state === 'absent';
  return current.state === 'present' && expected.sha256 === current.sha256;
}

function describeBaseline(baseline: ActiveStrategyBaseline): string {
  return baseline.state === 'absent' ? 'absent' : baseline.sha256;
}

function withCandidatePromotionLock<Value>(
  platform: string,
  capability: string,
  operation: () => Value,
): Value {
  return withCapabilityMutationLock(platform, capability, operation, {
    lockedError: () =>
      new StrategyCandidateError(
        'strategy_candidate_promotion_locked',
        `${platform}/${capability} is being updated by another process`,
      ),
  });
}

function parseCandidateSidecar(
  ref: StrategyCandidateRef,
  raw: unknown,
): StrategyCandidateSidecarV2 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StrategyCandidateError(
      'strategy_candidate_verification_invalid',
      `${ref.candidate_id} sidecar must be an object`,
    );
  }
  const record = raw as Record<string, unknown>;
  const baseline = record.baseline_active;
  const validBaseline =
    !!baseline &&
    typeof baseline === 'object' &&
    !Array.isArray(baseline) &&
    (((baseline as Record<string, unknown>).state === 'absent' &&
      Object.keys(baseline).length === 1) ||
      ((baseline as Record<string, unknown>).state === 'present' &&
        typeof (baseline as Record<string, unknown>).sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test((baseline as Record<string, unknown>).sha256 as string)));
  const verification = record.verification;
  const validVerification =
    verification === undefined ||
    (!!verification &&
      typeof verification === 'object' &&
      !Array.isArray(verification) &&
      !!(verification as Record<string, unknown>).runtime_meta &&
      typeof (verification as Record<string, unknown>).runtime_meta === 'object' &&
      !Array.isArray((verification as Record<string, unknown>).runtime_meta));
  if (
    record.schema_version !== 2 ||
    record.candidate_id !== ref.candidate_id ||
    typeof record.candidate_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.candidate_digest) ||
    !validBaseline ||
    !validVerification
  ) {
    throw new StrategyCandidateError('strategy_candidate_verification_invalid', ref.candidate_id);
  }
  return record as unknown as StrategyCandidateSidecarV2;
}

function loadCandidateSidecar(ref: StrategyCandidateRef): StrategyCandidateSidecarV2 | null {
  const filePath = candidateVerificationPath(ref);
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseCandidateSidecar(ref, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error instanceof StrategyCandidateError) throw error;
    throw new StrategyCandidateError('strategy_candidate_verification_invalid', ref.candidate_id);
  }
}

function encodeEvidenceBody(body: unknown): {
  body_kind: StrategyCandidateEvidenceV1['body_kind'];
  body_text: string;
} {
  if (body === null) return { body_kind: 'null', body_text: 'null' };
  if (body === undefined) return { body_kind: 'undefined', body_text: 'undefined' };
  if (typeof body === 'string') return { body_kind: 'text', body_text: body };
  try {
    const encoded = JSON.stringify(body);
    if (typeof encoded === 'string') return { body_kind: 'json', body_text: encoded };
  } catch {
    return { body_kind: 'unserializable', body_text: '' };
  }
  return { body_kind: 'unserializable', body_text: '' };
}

function buildEvidenceArtifact(
  ref: StrategyCandidateRef,
  candidateDigest: string,
  input: {
    classification: NonNullable<RuntimeMeta['candidate_verification']>['classification'];
    status: number;
    checked_at_ms: number;
    body: unknown;
    final_url?: string;
  },
): StrategyCandidateEvidenceV1 {
  const encoded = encodeEvidenceBody(input.body);
  const reviewable =
    encoded.body_kind !== 'unserializable' &&
    encoded.body_text.length <= MAX_REVIEWABLE_EVIDENCE_CHARS;
  return {
    schema_version: 1,
    candidate_id: ref.candidate_id,
    candidate_digest: candidateDigest,
    classification: input.classification,
    status: input.status,
    checked_at_ms: input.checked_at_ms,
    body_kind: encoded.body_kind,
    body_sha256: crypto.createHash('sha256').update(encoded.body_text).digest('hex'),
    body_total_chars: encoded.body_text.length,
    reviewable,
    ...(reviewable ? { body_text: encoded.body_text } : {}),
    ...(input.final_url ? { final_url: input.final_url } : {}),
  };
}

function parseCandidateEvidence(
  ref: StrategyCandidateRef,
  raw: unknown,
): StrategyCandidateEvidenceV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StrategyCandidateError('strategy_candidate_evidence_invalid', ref.candidate_id);
  }
  const record = raw as Record<string, unknown>;
  const bodyKind = record.body_kind;
  const bodyKindValid =
    bodyKind === 'json' ||
    bodyKind === 'text' ||
    bodyKind === 'null' ||
    bodyKind === 'undefined' ||
    bodyKind === 'unserializable';
  const classification = record.classification;
  const classificationValid =
    classification === 'explicit_success' ||
    classification === 'explicit_failure' ||
    classification === 'transport_accepted' ||
    classification === 'transport_failure' ||
    classification === 'not_run' ||
    classification === 'delivery_unknown';
  if (
    record.schema_version !== 1 ||
    record.candidate_id !== ref.candidate_id ||
    typeof record.candidate_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.candidate_digest) ||
    !classificationValid ||
    typeof record.status !== 'number' ||
    !Number.isSafeInteger(record.status) ||
    typeof record.checked_at_ms !== 'number' ||
    !Number.isSafeInteger(record.checked_at_ms) ||
    !bodyKindValid ||
    typeof record.body_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.body_sha256) ||
    typeof record.body_total_chars !== 'number' ||
    !Number.isSafeInteger(record.body_total_chars) ||
    record.body_total_chars < 0 ||
    typeof record.reviewable !== 'boolean' ||
    (record.reviewable && typeof record.body_text !== 'string') ||
    (!record.reviewable && record.body_text !== undefined) ||
    (record.final_url !== undefined && typeof record.final_url !== 'string')
  ) {
    throw new StrategyCandidateError('strategy_candidate_evidence_invalid', ref.candidate_id);
  }
  if (
    record.reviewable &&
    ((record.body_text as string).length !== record.body_total_chars ||
      crypto
        .createHash('sha256')
        .update(record.body_text as string)
        .digest('hex') !== record.body_sha256)
  ) {
    throw new StrategyCandidateError('strategy_candidate_evidence_invalid', ref.candidate_id);
  }
  return record as unknown as StrategyCandidateEvidenceV1;
}

function loadCheckedCandidateEvidence(
  ref: StrategyCandidateRef,
  sidecar: StrategyCandidateSidecarV2,
): LoadedStrategyCandidateEvidence {
  const verification = sidecar.verification?.runtime_meta.candidate_verification;
  const expectedDigest = verification?.evidence_digest;
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new StrategyCandidateError('strategy_candidate_evidence_missing', ref.candidate_id);
  }
  const filePath = candidateEvidencePath(ref);
  if (!fs.existsSync(filePath)) {
    throw new StrategyCandidateError('strategy_candidate_evidence_missing', ref.candidate_id);
  }
  let source: string;
  let parsed: StrategyCandidateEvidenceV1;
  try {
    source = fs.readFileSync(filePath, 'utf8');
    parsed = parseCandidateEvidence(ref, JSON.parse(source));
  } catch (error) {
    if (error instanceof StrategyCandidateError) throw error;
    throw new StrategyCandidateError('strategy_candidate_evidence_invalid', ref.candidate_id);
  }
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  if (digest !== expectedDigest) {
    throw new StrategyCandidateError(
      'strategy_candidate_evidence_mismatch',
      `${ref.candidate_id} expected ${expectedDigest}, found ${digest}`,
    );
  }
  if (
    parsed.candidate_digest !== sidecar.candidate_digest ||
    parsed.classification !== verification?.classification ||
    parsed.status !== verification.status ||
    parsed.checked_at_ms !== verification.checked_at_ms
  ) {
    throw new StrategyCandidateError(
      'strategy_candidate_evidence_mismatch',
      `${ref.candidate_id} evidence does not match its candidate-bound verification metadata`,
    );
  }
  return { ...parsed, evidence_digest: digest, path: filePath };
}

export function stageStrategyCandidate(
  platform: string,
  capability: string,
  data: Strategy,
): StrategyCandidateRef {
  const serialized = serializeJson(data);
  const digest = crypto.createHash('sha256').update(serialized).digest('hex');
  const ref: StrategyCandidateRef = {
    platform,
    capability,
    candidate_id: `${data.strategy}-${digest}`,
    tier: data.strategy,
    path: '',
  };
  ref.path = candidatePath(ref);
  withCandidatePromotionLock(platform, capability, () => {
    const baseline = activeStrategyBaseline(platform, capability);
    writeTextAtomically(ref.path, serialized);
    try {
      fs.unlinkSync(candidateEvidencePath(ref));
    } catch {
      // A freshly staged candidate has no verification evidence yet.
    }
    writeJsonAtomically(candidateVerificationPath(ref), {
      schema_version: 2,
      candidate_id: ref.candidate_id,
      candidate_digest: digest,
      baseline_active: baseline,
    } satisfies StrategyCandidateSidecarV2);
  });
  return ref;
}

export function loadStrategyCandidate(ref: StrategyCandidateRef): Strategy | null {
  return loadCheckedStrategyCandidate(ref);
}

export function writeStrategyCandidateVerification(
  ref: StrategyCandidateRef,
  patch: Partial<RuntimeMeta>,
): void {
  withCandidatePromotionLock(ref.platform, ref.capability, () => {
    const checked = loadCheckedStrategyCandidateRecord(ref);
    if (!checked) {
      throw new Error(`strategy_candidate_missing: ${ref.candidate_id}`);
    }
    const sidecar = loadCandidateSidecar(ref);
    if (!sidecar) {
      throw new StrategyCandidateError('strategy_candidate_verification_missing', ref.candidate_id);
    }
    if (sidecar.candidate_digest !== checked.digest) {
      throw new StrategyCandidateError(
        'strategy_candidate_verification_invalid',
        `${ref.candidate_id} sidecar digest does not match candidate bytes`,
      );
    }
    writeJsonAtomically(candidateVerificationPath(ref), {
      ...sidecar,
      verification: {
        runtime_meta: {
          ...(sidecar.verification?.runtime_meta ?? {}),
          ...patch,
        },
      },
    } satisfies StrategyCandidateSidecarV2);
  });
}

export function writeStrategyCandidateExecutionEvidence(
  ref: StrategyCandidateRef,
  patch: Partial<RuntimeMeta> & {
    candidate_verification: NonNullable<RuntimeMeta['candidate_verification']>;
  },
  input: {
    classification: NonNullable<RuntimeMeta['candidate_verification']>['classification'];
    status: number;
    checked_at_ms: number;
    body: unknown;
    final_url?: string;
  },
): { evidence_digest: string; reviewable: boolean } {
  return withCandidatePromotionLock(ref.platform, ref.capability, () => {
    const checked = loadCheckedStrategyCandidateRecord(ref);
    if (!checked) {
      throw new Error(`strategy_candidate_missing: ${ref.candidate_id}`);
    }
    const sidecar = loadCandidateSidecar(ref);
    if (!sidecar) {
      throw new StrategyCandidateError('strategy_candidate_verification_missing', ref.candidate_id);
    }
    if (sidecar.candidate_digest !== checked.digest) {
      throw new StrategyCandidateError(
        'strategy_candidate_verification_invalid',
        `${ref.candidate_id} sidecar digest does not match candidate bytes`,
      );
    }
    const evidence = buildEvidenceArtifact(ref, checked.digest, input);
    const serializedEvidence = serializeJson(evidence);
    const evidenceDigest = crypto.createHash('sha256').update(serializedEvidence).digest('hex');
    writeTextAtomically(candidateEvidencePath(ref), serializedEvidence);
    const priorMeta = sidecar.verification?.runtime_meta ?? {};
    writeJsonAtomically(candidateVerificationPath(ref), {
      ...sidecar,
      verification: {
        runtime_meta: {
          ...priorMeta,
          ...patch,
          candidate_verification: {
            ...patch.candidate_verification,
            evidence_digest: evidenceDigest,
            evidence_reviewable: evidence.reviewable,
          },
        },
      },
    } satisfies StrategyCandidateSidecarV2);
    return { evidence_digest: evidenceDigest, reviewable: evidence.reviewable };
  });
}

export function loadStrategyCandidateVerification(
  ref: StrategyCandidateRef,
): Partial<RuntimeMeta> | null {
  const checked = loadCheckedStrategyCandidateRecord(ref);
  const sidecar = loadCandidateSidecar(ref);
  if (!sidecar) return null;
  if (checked && sidecar.candidate_digest !== checked.digest) {
    throw new StrategyCandidateError(
      'strategy_candidate_verification_invalid',
      `${ref.candidate_id} sidecar digest does not match candidate bytes`,
    );
  }
  return sidecar.verification?.runtime_meta ?? null;
}

export function loadStrategyCandidateReviewContext(
  ref: StrategyCandidateRef,
): StrategyCandidateReviewContext {
  const checked = loadCheckedStrategyCandidateRecord(ref);
  if (!checked) throw new Error(`strategy_candidate_missing: ${ref.candidate_id}`);
  const sidecar = loadCandidateSidecar(ref);
  if (!sidecar) {
    throw new StrategyCandidateError('strategy_candidate_verification_missing', ref.candidate_id);
  }
  if (sidecar.candidate_digest !== checked.digest) {
    throw new StrategyCandidateError(
      'strategy_candidate_verification_invalid',
      `${ref.candidate_id} sidecar digest does not match candidate bytes`,
    );
  }
  return {
    ref,
    candidate_digest: checked.digest,
    baseline_active: sidecar.baseline_active,
    evidence: loadCheckedCandidateEvidence(ref, sidecar),
  };
}

export function recordStrategyCandidateSemanticReview(
  ref: StrategyCandidateRef,
  evidenceDigest: string,
  verdict: StrategyCandidateReviewVerdict,
  rationale: string,
): void {
  withCandidatePromotionLock(ref.platform, ref.capability, () => {
    const checked = loadCheckedStrategyCandidateRecord(ref);
    if (!checked) throw new Error(`strategy_candidate_missing: ${ref.candidate_id}`);
    const sidecar = loadCandidateSidecar(ref);
    if (!sidecar) {
      throw new StrategyCandidateError('strategy_candidate_verification_missing', ref.candidate_id);
    }
    if (sidecar.candidate_digest !== checked.digest) {
      throw new StrategyCandidateError(
        'strategy_candidate_verification_invalid',
        `${ref.candidate_id} sidecar digest does not match candidate bytes`,
      );
    }
    const evidence = loadCheckedCandidateEvidence(ref, sidecar);
    if (evidence.evidence_digest !== evidenceDigest) {
      throw new StrategyCandidateError(
        'strategy_candidate_evidence_mismatch',
        `${ref.candidate_id} expected ${evidence.evidence_digest}, received ${evidenceDigest}`,
      );
    }
    if (!evidence.reviewable) {
      throw new StrategyCandidateError(
        'strategy_candidate_evidence_unreviewable',
        `${ref.candidate_id} evidence is too large or not serializable`,
      );
    }
    if (evidence.classification !== 'transport_accepted') {
      throw new StrategyCandidateError(
        'strategy_candidate_not_verified',
        `${ref.candidate_id} semantic review requires transport_accepted evidence`,
      );
    }
    const priorMeta = sidecar.verification?.runtime_meta ?? {};
    writeJsonAtomically(candidateVerificationPath(ref), {
      ...sidecar,
      verification: {
        runtime_meta: {
          ...priorMeta,
          ...(verdict === DECISION_VALUES.verifiedSuccess
            ? { post_save_validation: 'passed' as const }
            : { post_save_validation: 'transport_passed' as const }),
          semantic_review: {
            verdict,
            candidate_id: ref.candidate_id,
            evidence_digest: evidenceDigest,
            reviewed_at_ms: Date.now(),
            rationale,
          },
        },
      },
    } satisfies StrategyCandidateSidecarV2);
  });
}

export function promoteStrategyCandidate(ref: StrategyCandidateRef, changelog?: string): string {
  return withCandidatePromotionLock(ref.platform, ref.capability, () => {
    const checked = loadCheckedStrategyCandidateRecord(ref);
    if (!checked) {
      throw new Error(`strategy_candidate_missing: ${ref.candidate_id}`);
    }
    const sidecar = loadCandidateSidecar(ref);
    if (!sidecar) {
      throw new StrategyCandidateError('strategy_candidate_verification_missing', ref.candidate_id);
    }
    if (sidecar.candidate_digest !== checked.digest) {
      throw new StrategyCandidateError(
        'strategy_candidate_verification_invalid',
        `${ref.candidate_id} sidecar digest does not match candidate bytes`,
      );
    }
    const verification = sidecar.verification?.runtime_meta;
    const proofAssessment = assessPostSaveVerificationProof(
      checked.strategy,
      verification?.post_save_verification,
      {
        platform: ref.platform,
        capability: ref.capability,
      },
    );
    if (proofAssessment.kind !== POST_SAVE_PROOF_ASSESSMENT_KINDS.current) {
      throw new StrategyCandidateError(
        'strategy_candidate_verification_invalid',
        `${ref.candidate_id} post-save proof is ${proofAssessment.kind}`,
      );
    }
    const explicitSuccess =
      verification?.post_save_validation === 'passed' &&
      verification.candidate_verification?.classification === 'explicit_success';
    const reviewedSuccessMetadata =
      verification?.post_save_validation === 'passed' &&
      verification.candidate_verification?.classification === 'transport_accepted' &&
      verification.semantic_review?.verdict === DECISION_VALUES.verifiedSuccess &&
      verification.semantic_review.candidate_id === ref.candidate_id &&
      verification.semantic_review.evidence_digest ===
        verification.candidate_verification.evidence_digest;
    const reviewedSuccess =
      reviewedSuccessMetadata &&
      loadCheckedCandidateEvidence(ref, sidecar).evidence_digest ===
        verification.semantic_review?.evidence_digest;
    if (!explicitSuccess && !reviewedSuccess) {
      throw new StrategyCandidateError(
        'strategy_candidate_not_verified',
        `${ref.candidate_id} requires explicit_success evidence or a bound verified_success semantic review`,
      );
    }
    const currentBaseline = activeStrategyBaseline(ref.platform, ref.capability);
    if (!baselinesMatch(sidecar.baseline_active, currentBaseline)) {
      throw new StrategyCandidateError(
        'strategy_candidate_promotion_conflict',
        `${ref.candidate_id} baseline=${describeBaseline(sidecar.baseline_active)} ` +
          `current=${describeBaseline(currentBaseline)}`,
      );
    }

    const candidate = checked.strategy;
    const subdir = STRATEGY_SUBDIR_MAP[candidate.strategy] || 'api';
    const targetDir = path.join(SKILLS_DIR, ref.platform, subdir);
    fs.mkdirSync(targetDir, { recursive: true });
    const activePath = path.join(targetDir, `${ref.capability}.json`);
    const existed = fs.existsSync(activePath);
    writeJsonAtomically(activePath, {
      ...candidate,
      runtime_meta: { ...(candidate.runtime_meta ?? {}), ...verification },
    });
    for (const filePath of [
      candidatePath(ref),
      candidateVerificationPath(ref),
      candidateEvidencePath(ref),
    ]) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Active loading and export never inspect retained candidate artifacts.
      }
    }
    appendStrategyEvent(ref.platform, ref.capability, {
      strategy: candidate.strategy,
      kind: existed ? 'rediscovered' : 'discovered',
      detail:
        (typeof changelog === 'string' && changelog) ||
        (existed
          ? 'verified candidate replaced active strategy'
          : `verified ${candidate.strategy} candidate promoted`),
    });
    return activePath;
  });
}
