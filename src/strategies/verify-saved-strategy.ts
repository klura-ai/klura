// Post-commit verification for a just-saved strategy.
//
// `save_strategy` commits a strategy, then emits the `post_save_validation_consent`
// checkpoint. When the agent resolves that checkpoint with consent, the runtime
// calls `verifySavedStrategy` — it runs the saved strategy end-to-end through
// `execute()`. A strategy that doesn't actually work (wrong header, stale token,
// bad endpoint) is archived to `.broken.json` here, in the same turn, so it
// never reaches another session's warm run.
//
// Verification loads one exact active tier and runs the full prereq chain with
// those immutable strategy bytes as an execution override, inside a run-scoped
// fresh verification context (`withFreshVerificationPool`).
// A boolean `body.ok` is the local factory's explicit semantic signal: false
// fails validation even on HTTP 2xx. A 2xx body without that field proves only
// end-to-end transport; published semantic outcomes remain the signed package
// manifest's responsibility. An explicit `body.ok:true` over a collection the
// strategy declared and that came back empty proves transport too, and no more
// — it carries the same strength as a bare 2xx and goes to semantic review.
// The irreducible "did the mutation hit the right entity" question stays at the
// mutating-verification + user layer.

import { execute } from '../execution';
import {
  classifyFactoryExecutionResult,
  describeFactoryExecutionFailure,
  type FactoryExecutionClassification,
} from '../execution/result-classification';
import {
  assessDeclaredCollectionEmptiness,
  describeDeclaredCollectionEmptiness,
  type DeclaredCollectionEmptiness,
  type SemanticReviewReason,
} from '../execution/collection-emptiness';
import {
  capturePostSaveVerificationTarget,
  loadCurrentPostSaveVerificationTarget,
  loadStrategy,
  stampPostSaveValidationProof,
} from './skills';
import { archivePostSaveValidationTarget } from './post-save-verification-store';
import {
  createPostSaveVerificationProof,
  type PostSaveVerificationProofV1,
  type PostSaveVerificationTarget,
} from './post-save-verification-proof';
import {
  loadStrategyCandidate,
  promoteStrategyCandidate,
  writeStrategyCandidateExecutionEvidence,
  type StrategyCandidateRef,
} from './strategy-candidates';
import type { BrowserPool } from '../drivers/types/session';
import { refUrl, REF_LINKS, TOOL_NAMES } from '../vocab';
import { markHealed } from './health';
import { withFreshVerificationPool } from '../pool/fresh-context-pool';

export interface VerifySavedStrategyResult {
  /** True only when the local strategy explicitly returned `body.ok:true`. */
  ok: boolean;
  /** Structural strength of the factory-side verification. */
  classification: FactoryExecutionClassification;
  /** The HTTP status `execute()` returned; 0 when execute threw. */
  status: number;
  /** True when transport failure or explicit `body.ok:false` caused archival. */
  archived: boolean;
  /** Bounded response evidence for LLM review; absent when validation was not run. */
  body_preview?: string;
  /** Agent-facing reason or rejection envelope for non-passed results. */
  message?: string;
  /** Exact strategy artifact and runtime build against which verification ran. */
  proof?: PostSaveVerificationProofV1;
  /** False when the target changed before the proof could be committed. */
  proof_current?: boolean;
  /** Typed reason a 2xx run was routed to semantic review instead of promotion. */
  semantic_review_reason?: SemanticReviewReason;
  /** Body keys whose declared collection came back empty. */
  collection_keys?: string[];
}

export interface VerifyStrategyCandidateResult extends VerifySavedStrategyResult {
  candidate_id: string;
  state: 'candidate' | 'active';
  active: boolean;
  path: string;
  evidence_digest?: string;
  evidence_reviewable?: boolean;
  semantic_review_required?: boolean;
}

export function previewBody(body: unknown): string {
  let s: string;
  if (typeof body === 'string') s = body;
  else {
    try {
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        typeof (body as Record<string, unknown>).error === 'string'
      ) {
        const record = body as Record<string, unknown>;
        const decisionFirst: Record<string, unknown> = { error: record.error };
        for (const key of ['details', 'diagnosis', 'needs_rediscovery', 'executionState']) {
          if (key in record) decisionFirst[key] = record[key];
        }
        for (const [key, value] of Object.entries(record)) {
          if (!(key in decisionFirst)) decisionFirst[key] = value;
        }
        s = JSON.stringify(decisionFirst);
      } else {
        s = JSON.stringify(body);
      }
    } catch {
      s = String(body);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 800 ? `${s.slice(0, 800)}…` : s;
}

/**
 * Rejection prose for an active save whose 2xx returned an empty declared
 * collection. Distinct from the bare-transport wording: this body DID carry an
 * explicit `ok:true`, so "no explicit boolean body.ok" would be false here.
 */
function emptyCollectionMessage(
  capability: string,
  status: number,
  emptiness: DeclaredCollectionEmptiness,
  bodyPreview: string,
): string {
  return (
    `post_save_validation_empty_collection: the saved \`${capability}\` strategy returned HTTP ${status} ` +
    `and an explicit body.ok, but ${describeDeclaredCollectionEmptiness(emptiness)}. Transport is proven; ` +
    `reading rows is not — the strategy is stamped \`transport_passed\`, not verified.` +
    `\n  Response: ${bodyPreview}` +
    `\n  Decide which this is: the target genuinely holds zero rows for these args (re-run with args that ` +
    `have rows, or leave it at transport_passed), or the selector / query / prereq chain silently missed ` +
    `(fix and re-save this session). See ${refUrl(REF_LINKS.selfVerifyingStrategies)}.`
  );
}

/**
 * Run the just-saved `{platform, capability}` strategy via `execute()`. On a
 * clean explicit run the active file is stamped
 * `runtime_meta.post_save_validation: "passed"`. A transport-only 2xx — and an
 * explicit `body.ok` over a declared collection that came back empty — is
 * stamped `"transport_passed"`. On an execute throw, non-2xx status, or
 * explicit `body.ok:false`, the strategy is archived to `.broken.json` and a
 * `post_save_validation_failed:` envelope is returned for the agent to fix and
 * re-save this session.
 */
export async function verifySavedStrategy(
  platform: string,
  capability: string,
  args: Record<string, unknown>,
  pool: BrowserPool,
  expectedProof?: PostSaveVerificationProofV1,
): Promise<VerifySavedStrategyResult> {
  let target: PostSaveVerificationTarget | null;
  if (expectedProof) {
    target =
      expectedProof.platform === platform && expectedProof.capability === capability
        ? loadCurrentPostSaveVerificationTarget(expectedProof)
        : null;
  } else {
    const current = loadStrategy(platform, capability);
    target = current
      ? capturePostSaveVerificationTarget(platform, capability, current.strategy)
      : null;
  }
  if (!target) {
    return {
      ok: false,
      classification: 'not_run',
      status: 0,
      archived: false,
      ...(expectedProof ? { proof: expectedProof, proof_current: false } : {}),
      message:
        `post_save_validation_target_changed: the exact ${platform}/${capability} strategy ` +
        `selected for verification is no longer active. No request was sent and no proof was committed.`,
    };
  }
  const { strategy, proof } = target;
  let status: number;
  let bodyPreview: string;
  let classification: FactoryExecutionClassification = 'transport_failure';
  let emptiness: DeclaredCollectionEmptiness | null = null;
  try {
    const result = await withFreshVerificationPool(pool, (verificationPool) =>
      execute(platform, capability, args, verificationPool, null, {
        _strategyOverride: [strategy],
        _suppressStrategyState: true,
      }),
    );
    status = result.status;
    bodyPreview = previewBody(result.body);
    classification = classifyFactoryExecutionResult(result);
    if (classification === 'explicit_success') {
      emptiness = assessDeclaredCollectionEmptiness(strategy, result.body);
      // An explicit ok:true over an empty declared collection carries exactly
      // the strength of a bare 2xx: transport worked, the semantic outcome is
      // unproven. Route it down the transport branch so it is never stamped
      // "passed".
      if (emptiness) classification = 'transport_accepted';
    }
  } catch (err) {
    status = 0;
    bodyPreview = err instanceof Error ? err.message : String(err);
  }

  if (classification === 'explicit_success') {
    const proofCurrent = stampPostSaveValidationProof(proof, 'passed', true);
    if (proofCurrent) {
      // The verification run itself is health-silent (`_suppressStrategyState`),
      // which is what keeps grading traffic out of caller-visible health. This
      // is the one deliberate write through that wall, and the twin of the
      // `markHealed` on candidate promotion below: a tier that broke, was
      // re-saved, and just proved itself end-to-end must not stay quarantined
      // — health is keyed by capability + tier, so the replacement bytes
      // inherit the prior record. An empty declared collection never reaches
      // here; it is downgraded to `transport_accepted` above and routed to
      // semantic review, which is exactly where "is zero rows right?" belongs.
      markHealed(platform, capability, strategy.strategy);
    }
    return proofCurrent
      ? {
          ok: true,
          classification,
          status,
          archived: false,
          body_preview: bodyPreview,
          proof,
          proof_current: true,
        }
      : {
          ok: false,
          classification,
          status,
          archived: false,
          body_preview: bodyPreview,
          proof,
          proof_current: false,
          message:
            `post_save_validation_target_changed: ${platform}/${capability} changed while its ` +
            `exact saved strategy was being verified. The result was not attached to the new bytes.`,
        };
  }

  if (classification === 'transport_accepted') {
    const proofCurrent = stampPostSaveValidationProof(proof, 'transport_passed', true);
    let message: string | undefined;
    if (!proofCurrent) {
      message =
        `post_save_validation_target_changed: ${platform}/${capability} changed while its ` +
        `exact saved strategy was being verified. The transport result was not attached to the new bytes.`;
    } else if (emptiness) {
      message = emptyCollectionMessage(capability, status, emptiness, bodyPreview);
    }
    return {
      ok: false,
      classification,
      status,
      archived: false,
      body_preview: bodyPreview,
      proof,
      proof_current: proofCurrent,
      ...(emptiness
        ? { semantic_review_reason: emptiness.reason, collection_keys: emptiness.keys }
        : {}),
      ...(message ? { message } : {}),
    };
  }
  if (classification === 'not_run' || classification === 'delivery_unknown') {
    const statusLabel = describeFactoryExecutionFailure(classification, status);
    return {
      ok: false,
      classification,
      status,
      archived: false,
      body_preview: bodyPreview,
      proof,
      proof_current: true,
      message:
        `post_save_validation_inconclusive: ${capability} ${statusLabel}. The active strategy ` +
        `was not archived or retried automatically.`,
    };
  }

  const statusLabel = describeFactoryExecutionFailure(classification, status);
  const archived = archivePostSaveValidationTarget(
    proof,
    `post-save validation failed: ${statusLabel}`,
  );

  return {
    ok: false,
    classification,
    status,
    archived,
    body_preview: bodyPreview,
    proof,
    proof_current: archived,
    message:
      `post_save_validation_failed: the saved \`${capability}\` strategy returned ${statusLabel} ` +
      `when executed end-to-end — it does not work as saved` +
      (archived ? ' and has been archived (.broken.json).' : '.') +
      `\n  Response: ${bodyPreview}` +
      `\n  Fix the strategy and re-save it this session — the capability has no working strategy until you do. ` +
      `See ${refUrl(REF_LINKS.selfVerifyingStrategies)}.`,
  };
}

/**
 * Verify exactly one inactive read candidate. Active sibling tiers are never
 * loaded, and verification cannot change active health or archive state.
 */
export async function verifyStrategyCandidate(
  ref: StrategyCandidateRef,
  args: Record<string, unknown>,
  pool: BrowserPool,
  changelog?: string,
): Promise<VerifyStrategyCandidateResult> {
  const candidate = loadStrategyCandidate(ref);
  if (!candidate) {
    return {
      ok: false,
      classification: 'not_run',
      status: 0,
      archived: false,
      candidate_id: ref.candidate_id,
      state: 'candidate',
      active: false,
      path: ref.path,
      message: `strategy_candidate_missing: ${ref.candidate_id}`,
    };
  }
  if (candidate.strategy !== 'fetch' && candidate.strategy !== 'page-script') {
    return {
      ok: false,
      classification: 'not_run',
      status: 0,
      archived: false,
      candidate_id: ref.candidate_id,
      state: 'candidate',
      active: false,
      path: ref.path,
      message:
        `strategy_candidate_not_verifiable: ${candidate.strategy} candidates are outside the ` +
        `read HTTP verification slice`,
    };
  }

  let status = 0;
  let bodyPreview: string;
  let body: unknown;
  let finalUrl: string | undefined;
  let classification: FactoryExecutionClassification = 'transport_failure';
  let emptiness: DeclaredCollectionEmptiness | null = null;
  try {
    const result = await withFreshVerificationPool(pool, (verificationPool) =>
      execute(ref.platform, ref.capability, args, verificationPool, null, {
        _strategyOverride: [candidate],
        _suppressStrategyState: true,
      }),
    );
    status = result.status;
    body = result.body;
    finalUrl = result.finalUrl;
    bodyPreview = previewBody(result.body);
    classification = classifyFactoryExecutionResult(result);
    if (classification === 'explicit_success') {
      emptiness = assessDeclaredCollectionEmptiness(candidate, result.body);
      // Same downgrade as the active twin — plus it keeps the candidate
      // inactive and routes it to `review_strategy_candidate`, which is where
      // "is zero rows the right answer here?" can actually be answered.
      if (emptiness) classification = 'transport_accepted';
    }
  } catch (err) {
    bodyPreview = err instanceof Error ? err.message : String(err);
    body = { error: 'candidate_execute_threw', details: bodyPreview };
  }

  const evidence = {
    classification,
    status,
    checked_at_ms: Date.now(),
    ...(bodyPreview ? { body_preview: bodyPreview } : {}),
  };
  const proof = createPostSaveVerificationProof(ref.platform, ref.capability, candidate);
  let postSaveValidation:
    | { post_save_validation: 'passed' }
    | { post_save_validation: 'transport_passed' }
    | Record<string, never> = {};
  if (classification === 'explicit_success') {
    postSaveValidation = { post_save_validation: 'passed' };
  } else if (classification === 'transport_accepted') {
    postSaveValidation = { post_save_validation: 'transport_passed' };
  }
  const storedEvidence = writeStrategyCandidateExecutionEvidence(
    ref,
    {
      ...postSaveValidation,
      post_save_verification: proof,
      candidate_verification: evidence,
    },
    {
      classification,
      status,
      checked_at_ms: evidence.checked_at_ms,
      body,
      ...(finalUrl ? { final_url: finalUrl } : {}),
    },
  );

  if (classification === 'explicit_success') {
    const activePath = promoteStrategyCandidate(ref, changelog);
    // Health is keyed by capability + tier, while candidates are immutable
    // content-addressed replacements. A verified promotion must not inherit a
    // prior candidate's broken state or the executor will skip the replacement
    // before its first normal call.
    markHealed(ref.platform, ref.capability, ref.tier);
    return {
      ok: true,
      classification,
      status,
      archived: false,
      candidate_id: ref.candidate_id,
      state: 'active',
      active: true,
      path: activePath,
      body_preview: bodyPreview,
      evidence_digest: storedEvidence.evidence_digest,
      evidence_reviewable: storedEvidence.reviewable,
      proof,
      proof_current: true,
    };
  }

  const statusLabel = describeFactoryExecutionFailure(classification, status);
  let message: string;
  if (classification === 'transport_accepted') {
    const unproven = emptiness
      ? `returned an explicit body.ok, but ${describeDeclaredCollectionEmptiness(emptiness)} — ` +
        `transport is proven, reading rows is not`
      : 'returned no explicit boolean body.ok';
    message =
      `strategy_candidate_semantic_review_required: ${ref.capability} completed transport with ` +
      `HTTP ${status}, but ${unproven}. The candidate remains inactive. ` +
      (storedEvidence.reviewable
        ? `Inspect its exact candidate-bound evidence with ${TOOL_NAMES.reviewStrategyCandidate}, then submit a typed verdict.`
        : `Its exact result exceeded the review artifact bound; narrow the sample result or add structural extraction before re-saving.`);
  } else if (classification === 'not_run') {
    message = `strategy_candidate_not_run: ${ref.capability} was not sent. The candidate remains inactive.`;
  } else if (classification === 'delivery_unknown') {
    message =
      `strategy_candidate_delivery_unknown: ${ref.capability} was sent without confirmation. ` +
      `The candidate remains inactive and must not be retried automatically.`;
  } else {
    message =
      `strategy_candidate_failed: ${ref.capability} returned ${statusLabel}. The candidate ` +
      `remains inactive and the prior active strategy is unchanged.`;
  }
  return {
    ok: false,
    classification,
    status,
    archived: false,
    candidate_id: ref.candidate_id,
    state: 'candidate',
    active: false,
    path: ref.path,
    body_preview: bodyPreview,
    evidence_digest: storedEvidence.evidence_digest,
    evidence_reviewable: storedEvidence.reviewable,
    proof,
    proof_current: true,
    ...(classification === 'transport_accepted' && storedEvidence.reviewable
      ? { semantic_review_required: true }
      : {}),
    ...(emptiness
      ? { semantic_review_reason: emptiness.reason, collection_keys: emptiness.keys }
      : {}),
    message,
  };
}
