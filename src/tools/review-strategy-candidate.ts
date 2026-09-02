import { buildTokenGate } from '../gate';
import { sliceLargeString } from '../response/response-size';
import {
  loadStrategyCandidate,
  loadStrategyCandidateReviewContext,
  loadStrategyCandidateVerification,
  promoteStrategyCandidate,
  recordStrategyCandidateSemanticReview,
  resolveStrategyCandidateRef,
  StrategyCandidateError,
  type StrategyCandidateReviewContext,
  type StrategyCandidateReviewVerdict,
} from '../strategies/strategy-candidates';
import {
  assessDeclaredCollectionEmptiness,
  assessUniformNullFields,
  describeCollectionIntegrityFinding,
  SEMANTIC_REVIEW_REASONS,
  type CollectionIntegrityFinding,
} from '../execution/collection-emptiness';
import { markHealed } from '../strategies/health';
import { DECISION_VALUES, REF_LINKS, TOOL_NAMES, refUrl } from '../vocab';
import type { ToolDef } from './types';

interface ReviewStrategyCandidateArgs {
  platform: string;
  capability: string;
  candidate_id: string;
  evidence_digest: string;
  review_token?: string;
  verdict?: StrategyCandidateReviewVerdict;
  rationale?: string;
  evidence_offset?: number;
  evidence_length?: number;
}

interface CandidateReviewPayload {
  platform: string;
  capability: string;
  candidate_id: string;
  candidate_digest: string;
  evidence_digest: string;
  classification: string;
  status: number;
  checked_at_ms: number;
  body_sha256: string;
  baseline_active: StrategyCandidateReviewContext['baseline_active'];
}

interface CandidateReviewAnswers {
  verdict?: StrategyCandidateReviewVerdict;
  rationale?: string;
}

const candidateReviewGate = buildTokenGate<CandidateReviewPayload, CandidateReviewAnswers>({
  kind: 'strategy_candidate.semantic_review',
  buildChecklist: (payload) => ({
    prompt:
      `Inspect the exact candidate-bound execution evidence in this response. Decide whether it ` +
      `semantically satisfies the requested read capability. Runtime validates the typed verdict ` +
      `and evidence binding only; it does not interpret response prose or application fields.`,
    items: {
      candidate_id: payload.candidate_id,
      evidence_digest: payload.evidence_digest,
      allowed_verdicts: [
        DECISION_VALUES.verifiedSuccess,
        DECISION_VALUES.verifiedFailure,
        DECISION_VALUES.inconclusive,
      ],
      required_rationale:
        'One concrete sentence explaining what in the returned evidence supports the verdict.',
    },
  }),
  validateAnswers: (_payload, answers) => {
    const issues: string[] = [];
    if (
      answers.verdict !== DECISION_VALUES.verifiedSuccess &&
      answers.verdict !== DECISION_VALUES.verifiedFailure &&
      answers.verdict !== DECISION_VALUES.inconclusive
    ) {
      issues.push(
        `verdict must be one of ${JSON.stringify([
          DECISION_VALUES.verifiedSuccess,
          DECISION_VALUES.verifiedFailure,
          DECISION_VALUES.inconclusive,
        ])}`,
      );
    }
    if (typeof answers.rationale !== 'string' || answers.rationale.trim().length < 20) {
      issues.push('rationale must be a concrete non-empty sentence of at least 20 characters');
    }
    return issues;
  },
});

function reviewPayload(context: StrategyCandidateReviewContext): CandidateReviewPayload {
  return {
    platform: context.ref.platform,
    capability: context.ref.capability,
    candidate_id: context.ref.candidate_id,
    candidate_digest: context.candidate_digest,
    evidence_digest: context.evidence.evidence_digest,
    classification: context.evidence.classification,
    status: context.evidence.status,
    checked_at_ms: context.evidence.checked_at_ms,
    body_sha256: context.evidence.body_sha256,
    baseline_active: context.baseline_active,
  };
}

/**
 * Every collection-integrity finding this candidate carries.
 *
 * Body-only assessments are re-derived from the two digest-bound artifacts the
 * reviewer is looking at — the candidate strategy bytes and the exact evidence
 * body — because derivation cannot drift out of agreement with the evidence it
 * explains. Multi-run assessments compare two executions, which the single
 * stored body cannot reproduce, so those are read back from the verification
 * sidecar and merged in.
 */
function collectionIntegrityFindings(
  context: StrategyCandidateReviewContext,
): CollectionIntegrityFinding[] {
  const findings: CollectionIntegrityFinding[] = [];
  if (context.evidence.body_kind === 'json' && context.evidence.body_text !== undefined) {
    let body: unknown;
    try {
      body = JSON.parse(context.evidence.body_text);
      const candidate = loadStrategyCandidate(context.ref);
      const emptiness = assessDeclaredCollectionEmptiness(candidate, body);
      if (emptiness) findings.push(emptiness);
      else findings.push(...assessUniformNullFields(candidate, body));
    } catch {
      /* an unparseable body derives nothing; the sidecar findings still apply */
    }
  }
  const derivedReasons = new Set(findings.map((finding) => finding.reason));
  const persisted =
    loadStrategyCandidateVerification(context.ref)?.candidate_verification?.collection_integrity ??
    [];
  findings.push(...persisted.filter((finding) => !derivedReasons.has(finding.reason)));
  return findings;
}

/** Why this candidate needs a verdict, in the shape the review response carries. */
function semanticReviewReason(
  context: StrategyCandidateReviewContext,
): Record<string, unknown> | null {
  const findings = collectionIntegrityFindings(context);
  const first = findings[0];
  if (!first) return null;
  let detail: string;
  if (first.reason === SEMANTIC_REVIEW_REASONS.declaredCollectionEmpty) {
    detail =
      `${describeCollectionIntegrityFinding(first)}. Transport succeeded; whether zero rows is the ` +
      `correct answer for these arguments is what your verdict decides.`;
  } else {
    const checks =
      findings.length === 1 ? '1 structural check' : `${findings.length} structural checks`;
    detail =
      `Transport succeeded and rows came back, but the collection failed ${checks}: ` +
      `${findings.map(describeCollectionIntegrityFinding).join('; ')}. Whether each one is a real ` +
      `defect or correct for this site is what your verdict decides.`;
  }
  return {
    semantic_review_reason: first.reason,
    ...(first.reason === SEMANTIC_REVIEW_REASONS.declaredCollectionEmpty
      ? { collection_keys: first.keys }
      : {}),
    collection_integrity: findings,
    semantic_review_detail: detail,
  };
}

function evidenceSlice(
  context: StrategyCandidateReviewContext,
  offset: number | undefined,
  length: number | undefined,
): Record<string, unknown> {
  const body = context.evidence.body_text ?? '';
  const sliced = sliceLargeString(body, {
    offset,
    length,
    defaultMaxLength: 12_000,
    hintFetchNext: (end, remaining) =>
      remaining > 0
        ? `${remaining} evidence characters remain. Call ${TOOL_NAMES.reviewStrategyCandidate} again with the same candidate and evidence digest plus evidence_offset:${end}.`
        : 'This slice reaches the end of the exact evidence body.',
  });
  return {
    status: context.evidence.status,
    classification: context.evidence.classification,
    body_kind: context.evidence.body_kind,
    body_sha256: context.evidence.body_sha256,
    body: sliced.slice,
    body_total_chars: sliced.total_chars,
    body_slice_start: sliced.slice_start,
    body_slice_end: sliced.slice_end,
    body_truncated: sliced.truncated,
    ...(context.evidence.final_url ? { final_url: context.evidence.final_url } : {}),
    ...(sliced.hint ? { body_hint: sliced.hint } : {}),
  };
}

export function reviewStrategyCandidate(
  args: ReviewStrategyCandidateArgs,
): Record<string, unknown> {
  const ref = resolveStrategyCandidateRef(args.platform, args.capability, args.candidate_id);
  const context = loadStrategyCandidateReviewContext(ref);
  if (args.evidence_digest !== context.evidence.evidence_digest) {
    throw new StrategyCandidateError(
      'strategy_candidate_evidence_mismatch',
      `${args.candidate_id} expected ${context.evidence.evidence_digest}, received ${args.evidence_digest}`,
    );
  }
  if (!context.evidence.reviewable) {
    return {
      ok: false,
      state: 'candidate',
      active: false,
      candidate_id: args.candidate_id,
      evidence_digest: context.evidence.evidence_digest,
      reason: 'strategy_candidate_evidence_unreviewable',
      _hint:
        'The exact result exceeded the local review artifact bound or could not be serialized. ' +
        'Narrow the sample response or add structural extraction, then re-save.',
    };
  }

  const payload = reviewPayload(context);
  const gateResult = candidateReviewGate.process(payload, {
    token: args.review_token,
    answers:
      args.verdict === undefined && args.rationale === undefined
        ? undefined
        : { verdict: args.verdict, rationale: args.rationale },
  });
  if (gateResult.status !== 'committed') {
    return {
      ok: false,
      state: 'candidate',
      active: false,
      review_required: true,
      candidate_id: args.candidate_id,
      evidence_digest: context.evidence.evidence_digest,
      evidence: evidenceSlice(context, args.evidence_offset, args.evidence_length),
      ...(semanticReviewReason(context) ?? {}),
      reason: gateResult.rejection.reason,
      review_token: gateResult.rejection.token,
      checklist: gateResult.rejection.checklist,
      ...(gateResult.rejection.issues ? { issues: gateResult.rejection.issues } : {}),
      ...(gateResult.rejection.payload_diff
        ? { payload_diff: gateResult.rejection.payload_diff }
        : {}),
    };
  }

  const verdict = args.verdict as StrategyCandidateReviewVerdict;
  const rationale = (args.rationale as string).trim();
  recordStrategyCandidateSemanticReview(ref, context.evidence.evidence_digest, verdict, rationale);
  if (verdict === DECISION_VALUES.verifiedSuccess) {
    const activePath = promoteStrategyCandidate(ref);
    markHealed(ref.platform, ref.capability, ref.tier);
    return {
      ok: true,
      state: 'active',
      active: true,
      candidate_id: args.candidate_id,
      evidence_digest: context.evidence.evidence_digest,
      verdict,
      path: activePath,
    };
  }
  return {
    ok: true,
    state: 'candidate',
    active: false,
    candidate_id: args.candidate_id,
    evidence_digest: context.evidence.evidence_digest,
    verdict,
    path: ref.path,
    _hint:
      verdict === DECISION_VALUES.verifiedFailure
        ? 'The candidate remains inactive. Fix the strategy and re-save it.'
        : 'The candidate remains inactive. Gather clearer evidence or revise the strategy before re-saving.',
  };
}

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.reviewStrategyCandidate,
  phasePolicy: { category: 'none' },
  description:
    `Review exact execution evidence for an inactive safe-read candidate, then submit a typed semantic verdict. ` +
    `See ${refUrl(REF_LINKS.selfVerifyingStrategies)}.`,
  inputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string' },
      capability: { type: 'string' },
      candidate_id: { type: 'string' },
      evidence_digest: { type: 'string' },
      review_token: { type: 'string' },
      verdict: {
        type: 'string',
        enum: [
          DECISION_VALUES.verifiedSuccess,
          DECISION_VALUES.verifiedFailure,
          DECISION_VALUES.inconclusive,
        ],
      },
      rationale: { type: 'string' },
      evidence_offset: { type: 'integer', minimum: 0 },
      evidence_length: { type: 'integer', minimum: 1 },
    },
    required: ['platform', 'capability', 'candidate_id', 'evidence_digest'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: (args) => reviewStrategyCandidate(args as ReviewStrategyCandidateArgs),
};
