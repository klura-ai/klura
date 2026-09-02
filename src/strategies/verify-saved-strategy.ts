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
// strategy declared proves transport too, and no more, whenever that collection
// fails a structural integrity check (`execution/collection-emptiness.ts`) — no
// rows at all, a declared item field null in every row, two runs that disagree,
// or two pages that overlap. Each carries the same strength as a bare 2xx and
// goes to semantic review with its evidence attached.
// The irreducible "did the mutation hit the right entity" question stays at the
// mutating-verification + user layer.

import { execute } from '../execution';
import {
  classifyFactoryExecutionResult,
  describeFactoryExecutionFailure,
  isOversizeBodyEnvelope,
  type FactoryExecutionClassification,
} from '../execution/result-classification';
import {
  assessCollectionIntegrity,
  assessDeclaredCollectionEmptiness,
  describeCollectionIntegrityFinding,
  describeDeclaredCollectionEmptiness,
  SEMANTIC_REVIEW_REASONS,
  type CollectionIntegrityFinding,
  type DeclaredCollectionEmptiness,
  type SemanticReviewReason,
} from '../execution/collection-emptiness';
import { loadConfig } from '../config/handler';
import {
  capturePostSaveVerificationTarget,
  loadCurrentPostSaveVerificationTarget,
  loadStrategy,
  stampPostSaveValidationProof,
  type Strategy,
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
import { navigationReachMissFrom, type NavigationReachMiss } from '../execution/navigation-reach';
import { EXECUTE_RESULT_BODY_INLINE_BUDGET } from '../response/response-size';

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
  /** Every collection-integrity finding that routed this run to semantic review. */
  collection_integrity?: CollectionIntegrityFinding[];
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
 * One verification firing of an exact strategy, plus every collection-integrity
 * assessment that applies to what came back.
 *
 * Every execution the assessors need happens inside a single
 * `withFreshVerificationPool` scope, so check B's re-run and check C's page-2
 * run reuse the context the first run established rather than paying for a new
 * browser each.
 */
interface VerificationRun {
  result: Awaited<ReturnType<typeof execute>>;
  classification: FactoryExecutionClassification;
  emptiness: DeclaredCollectionEmptiness | null;
  /** Emptiness, when present, is the sole finding — the later checks need rows. */
  integrity: CollectionIntegrityFinding[];
  /**
   * Set when a prereq navigation resolved somewhere other than its target, so
   * the strategy never ran against the page it reads. Distinct from every
   * failure classification: there is no evidence the strategy is wrong.
   */
  reachMiss: NavigationReachMiss | null;
  /**
   * Which browser state produced this run.
   *
   * `fresh` is the default and the stronger proof: nothing the authoring
   * session established was available. `platform_session` means the fresh run
   * was stopped by a gate holding the requested URL, and the platform's own
   * primed session was used instead — a real proof of the strategy, under
   * weaker conditions, and recorded as such rather than passed off as fresh.
   */
  sessionContext: 'fresh' | 'platform_session';
}

/**
 * A gate standing in front of the page, as opposed to a page that moved.
 *
 * The distinction is structural, not a guess about the destination: when the
 * origin carries the requested URL as a parameter on wherever it sent us, it is
 * holding that URL to return to afterwards. Consent walls, login walls and
 * interstitials all do this; a renamed or withdrawn page does not.
 *
 * It matters because a fresh verification context cannot clear a gate that
 * wants a human. Reddit's JS challenge is machine-solvable and a fresh context
 * re-solves it every time, so that path stays honest; a Google consent
 * interstitial is not, and refusing the capability over it says nothing true
 * about the strategy.
 */
function isGateInFront(miss: NavigationReachMiss | null): boolean {
  return Boolean(miss?.requested_carried_as_parameter);
}

/**
 * The same question, asked of a failed result rather than a thrown error.
 *
 * The cascade does not always throw: when a prereq's navigation misses, the
 * error is usually folded into an `all_strategies_failed` body and the run
 * returns normally. Reading only the throw path meant two google-maps
 * capabilities sat behind a consent gate the retry was written to clear.
 * `navigation_reach_misses` is the structured field the cascade stamps for
 * exactly this — no prose is parsed.
 */
function resultShowsGateInFront(result: Awaited<ReturnType<typeof execute>> | null): boolean {
  const body = result?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const misses = (body as { navigation_reach_misses?: unknown }).navigation_reach_misses;
  if (!Array.isArray(misses)) return false;
  return misses.some((m) => isGateInFront(m as NavigationReachMiss));
}

async function runVerification(
  platform: string,
  capability: string,
  strategy: Strategy,
  args: Record<string, unknown>,
  pool: BrowserPool,
): Promise<VerificationRun> {
  const fresh = await runVerificationIn(platform, capability, strategy, args, pool, 'fresh');
  // Only a gate earns the second attempt. Every other failure — a bad selector,
  // a stale endpoint, an empty collection — is a verdict on the strategy, and
  // re-running it with more state would launder exactly the dependency the
  // fresh context exists to expose.
  if (!isGateInFront(fresh.reachMiss) && !resultShowsGateInFront(fresh.result)) return fresh;
  const primed = await runVerificationIn(
    platform,
    capability,
    strategy,
    args,
    pool,
    'platform_session',
  );
  // A gate on the retry too: report the fresh run, whose reach-miss names the
  // gate. Nothing was proved either way.
  const primedStillGated = isGateInFront(primed.reachMiss) || resultShowsGateInFront(primed.result);
  return primedStillGated ? fresh : primed;
}

async function runVerificationIn(
  platform: string,
  capability: string,
  strategy: Strategy,
  args: Record<string, unknown>,
  pool: BrowserPool,
  sessionContext: 'fresh' | 'platform_session',
): Promise<VerificationRun> {
  const audit = loadConfig().audit;
  const runIn = async (verificationPool: BrowserPool): Promise<VerificationRun> => {
    const fire = (callArgs: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(platform, capability, callArgs, verificationPool, null, {
        _strategyOverride: [strategy],
        _suppressStrategyState: true,
        // The fresh pool strips the browser context's storage; this carries the
        // same exclusion to the Node fire path, which reads the cookie jar off
        // disk and would otherwise hand the run the discovery state it exists
        // to exclude.
        ...(sessionContext === 'fresh' ? { _suppressPersistedCookies: true } : {}),
      });
    let result: Awaited<ReturnType<typeof execute>>;
    try {
      result = await fire(args);
    } catch (err) {
      // A navigation that never arrived is not a verdict on the strategy, so it
      // is carried out of here as its own fact rather than collapsing into the
      // transport-failure branch that archives.
      const miss = navigationReachMissFrom(err);
      if (!miss) throw err;
      return {
        result: { status: 0, body: { error: 'verification_target_unreachable' } } as Awaited<
          ReturnType<typeof execute>
        >,
        classification: 'not_run',
        emptiness: null,
        integrity: [],
        reachMiss: miss,
        sessionContext,
      };
    }
    const classification = classifyFactoryExecutionResult(result);
    if (classification !== 'explicit_success') {
      return {
        result,
        classification,
        emptiness: null,
        integrity: [],
        reachMiss: null,
        sessionContext,
      };
    }
    const emptiness = assessDeclaredCollectionEmptiness(strategy, result.body);
    if (emptiness) {
      return {
        result,
        classification,
        emptiness,
        integrity: [emptiness],
        reachMiss: null,
        sessionContext,
      };
    }
    const integrity = await assessCollectionIntegrity({
      strategy,
      body: result.body,
      args,
      rerun: fire,
      stability: audit.verifyCollectionStability,
      pagination: audit.verifyPaginationDisjointness,
      // The ceiling the delivery path will apply to this exact body. Measuring
      // it here is what stops a strategy from being verified against bytes its
      // own caller never receives.
      deliveryBudgetChars: EXECUTE_RESULT_BODY_INLINE_BUDGET,
    });
    return { result, classification, emptiness: null, integrity, reachMiss: null, sessionContext };
  };

  // The fresh pool is what strips browser storage; the platform-session attempt
  // runs on the ordinary pool so the primed state is present.
  return sessionContext === 'fresh'
    ? await withFreshVerificationPool(pool, runIn)
    : await runIn(pool);
}

/**
 * How to make an oversized result small enough, for the format the strategy
 * actually declares.
 *
 * `response.extract` is a CSS-selector extractor: it reads an HTML document and
 * has nothing to say about a JSON body. Telling an agent holding 30 KB of JSON
 * to "add structural extraction" names an affordance that does not apply to it,
 * and the agent has no way to discover that from the message — it can only try
 * `extract` and fail. For JSON the shaping belongs where the value is produced:
 * the prereq expression is arbitrary JS, so it returns the fields the capability
 * needs instead of the whole payload.
 */
function narrowResultRemedy(strategy: unknown): string {
  const response = (strategy as { response?: { format?: unknown } } | undefined)?.response;
  if (response?.format === 'html') {
    // `format: "html"` cannot be saved without a non-empty `extract`, so one is
    // already here and telling the agent to add it would describe work it did.
    // Oversize means the extract it wrote is too broad.
    return (
      'This declares `response.extract`, so the fix is to narrow it rather than add one: tighten the ' +
      'row selector so it matches only the rows the capability returns, and drop fields a caller does ' +
      'not need.'
    );
  }
  return (
    'This returns JSON, which `response.extract` cannot narrow — it is a CSS extractor and reads only ' +
    'HTML. Shape the value where it is produced: have the prereq return just the fields the capability ' +
    'needs (map the collection down to its rows) instead of the whole payload, or narrow the request itself.'
  );
}

/**
 * The one structural fact about a verification run the agent cannot see from
 * its own session: everything discovery established was excluded.
 *
 * The browser tiers get a fresh context; a `fetch` fired from Node gets an empty
 * cookie jar. Without this, an authenticated or challenge-gated capability reads
 * as a broken strategy — the agent watches the same URL work in its session and
 * concludes the request is wrong, when the difference is state the run withheld
 * on purpose. A 401/403 is the signature of exactly that, so it gets named.
 *
 * Every branch that reports a failed verification carries this. Attaching it to
 * one classification only means the agent's diagnosis depends on which way the
 * site happened to reject the call.
 */
export function coldRunNotice(tier: string | undefined, status: number): string {
  const sessionShaped = status === 401 || status === 403;
  return (
    ` This ran with everything your authoring session established stripped away: a fresh browser ` +
    `context for the page tiers, and an empty cookie jar for a fetch fired from Node. Nothing you ` +
    `clicked, logged into, or were handed on first visit was in place. If the mechanism depends on ` +
    `that state — an in-page module the app only registers on some routes, a logged-in variant, a ` +
    `consent or anti-abuse cookie minted when a real browser first loaded the site — a prereq has ` +
    `to establish it; prereqs execute inside this same run and their side effects persist for the ` +
    `rest of it.` +
    remedyForColdFailure(tier, status, sessionShaped)
  );
}

/** The half of the cold-run notice that depends on how this particular run
 *  failed: which tier is holding the strategy, and whether the status is the
 *  shape a withheld session produces. */
function remedyForColdFailure(
  tier: string | undefined,
  status: number,
  sessionShaped: boolean,
): string {
  if (sessionShaped) {
    return (
      ` HTTP ${status} against a URL that works in your session is that dependency showing, not a ` +
      `wrong request — re-sending the same call will keep failing. On \`fetch\` the browser-bound ` +
      `prereq kinds are rejected outright, so a capability that needs a live page to establish its ` +
      `session belongs on \`page-script\`, which fires in-page and carries that state.`
    );
  }
  if (tier === 'page-script') {
    return (
      ` On \`page-script\` the concrete shape is a \`browser\` prereq ordered before the one that ` +
      `reads: its steps navigate to the page a real visitor would land on, which is what lets the ` +
      `site hand this context whatever it hands a first-time visitor. A prereq that fetches an API ` +
      `path without a preceding page load starts from nothing, so a site that gates on that state ` +
      `answers with its interstitial — an in-page fetch parsing JSON then fails on the HTML it got ` +
      `back rather than on anything the expression does wrong.`
    );
  }
  if (tier === 'fetch') {
    return ` Re-sending the same call will keep failing; the fix is a prereq that establishes the state.`;
  }
  return ` A cold page that looks unfamiliar is that dependency showing, not a timing race.`;
}

/**
 * Agent-facing evidence block for integrity findings over a collection that DID
 * carry rows. One line per finding, each naming what is wrong and the evidence
 * behind it, so the agent can fix the extractor or ack a finding with a reason.
 */
function integrityEvidence(findings: CollectionIntegrityFinding[]): string {
  return findings
    .map((finding) => `\n  - [${finding.reason}] ${describeCollectionIntegrityFinding(finding)}`)
    .join('');
}

/**
 * Rejection prose for a 2xx whose declared collection carried rows but failed a
 * structural integrity check. Distinct from the empty-collection wording:
 * rows came back and every value in them may be correct — what is unproven is
 * that the collection is complete, reproducible, or actually paginated.
 */
function integrityMessage(
  capability: string,
  status: number,
  findings: CollectionIntegrityFinding[],
  bodyPreview: string,
  strategy?: unknown,
): string {
  const plural = findings.length > 1 ? 's' : '';
  // The size finding is the one whose remedy is not "fix the extraction" in the
  // general sense — it names where the shaping has to happen for this format.
  const oversize = findings.some(
    (f) => f.reason === SEMANTIC_REVIEW_REASONS.collectionExceedsDeliveryBudget,
  );
  return (
    `post_save_validation_collection_integrity: the saved \`${capability}\` strategy returned HTTP ${status} ` +
    `and rows, but ${findings.length} structural check${plural} over those rows did not hold. The strategy is ` +
    `stamped \`transport_passed\`, not verified.` +
    integrityEvidence(findings) +
    (oversize ? `\n  ${narrowResultRemedy(strategy)}` : '') +
    `\n  Response: ${bodyPreview}` +
    `\n  Fix the extraction and re-save this session, or — when a finding is correct for this site (a field ` +
    `genuinely absent for these args, a field that legitimately changes second to second) — say so explicitly ` +
    `in the changelog and leave it at transport_passed. See ${refUrl(REF_LINKS.selfVerifyingStrategies)}.`
  );
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
  let integrity: CollectionIntegrityFinding[] = [];
  let reachMiss: NavigationReachMiss | null = null;
  let sessionContext: 'fresh' | 'platform_session' = 'fresh';
  try {
    const run = await runVerification(platform, capability, strategy, args, pool);
    status = run.result.status;
    bodyPreview = previewBody(run.result.body);
    classification = run.classification;
    emptiness = run.emptiness;
    integrity = run.integrity;
    reachMiss = run.reachMiss;
    sessionContext = run.sessionContext;
    // An explicit ok:true whose declared collection is empty, or carries rows
    // that fail a structural integrity check, carries exactly the strength of a
    // bare 2xx: transport worked, the semantic outcome is unproven. Route it
    // down the transport branch so it is never stamped "passed".
    if (classification === 'explicit_success' && integrity.length > 0) {
      classification = 'transport_accepted';
    }
  } catch (err) {
    status = 0;
    bodyPreview = err instanceof Error ? err.message : String(err);
  }

  if (classification === 'explicit_success') {
    // Stamp the conditions the proof was obtained under, so a gated platform's
    // weaker proof is legible rather than indistinguishable from a fresh one.
    const provenProof =
      sessionContext === 'fresh' ? proof : { ...proof, session_context: sessionContext };
    const proofCurrent = stampPostSaveValidationProof(provenProof, 'passed', true);
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
    } else if (integrity.length > 0) {
      message = integrityMessage(capability, status, integrity, bodyPreview, strategy);
    }
    return {
      ok: false,
      classification,
      status,
      archived: false,
      body_preview: bodyPreview,
      proof,
      proof_current: proofCurrent,
      ...(emptiness ? { collection_keys: emptiness.keys } : {}),
      ...(integrity.length > 0
        ? {
            semantic_review_reason: (integrity[0] as CollectionIntegrityFinding).reason,
            collection_integrity: integrity,
          }
        : {}),
      ...(message ? { message } : {}),
    };
  }
  if (reachMiss) {
    return {
      ok: false,
      classification: 'not_run',
      status,
      archived: false,
      body_preview: bodyPreview,
      proof,
      proof_current: true,
      message:
        `post_save_validation_target_unreachable: \`${capability}\` never reached the page it reads. ` +
        `It asked for ${JSON.stringify(reachMiss.requested)} and the document that loaded was ` +
        `${JSON.stringify(reachMiss.reached)}, so the expression ran against nothing. The strategy ` +
        `is INCOMPLETE, not wrong — what it does may be correct; it does not yet get to where it ` +
        `does it. It has NOT been archived.` +
        (reachMiss.requested_carried_as_parameter
          ? `\n  The destination carries the requested URL as a query parameter, so it is holding it ` +
            `to return to: something stands in front of the page. That is ambient page state — a ` +
            `consent banner, a region gate — and getting through it is the strategy's job, not the ` +
            `runtime's. Add a prereq step that clears it before the read; verification keeps that ` +
            `side effect for the rest of the run. Note this is not an artifact of verification ` +
            `being cookieless: a caller reaching this site with no history hits the same thing.`
          : `\n  The requested URL does not appear on the destination, which reads as a moved, ` +
            `renamed or withdrawn page. Re-check the URL the prereq navigates to.`) +
        `\n  Do not rewrite the expression on this evidence — it never ran. Fix how the strategy ` +
        `gets to the page, then re-save.`,
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
      coldRunNotice(proof.tier, status) +
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
  let integrity: CollectionIntegrityFinding[] = [];
  let reachMiss: NavigationReachMiss | null = null;
  let sessionContext: 'fresh' | 'platform_session' = 'fresh';
  try {
    const run = await runVerification(ref.platform, ref.capability, candidate, args, pool);
    reachMiss = run.reachMiss;
    sessionContext = run.sessionContext;
    status = run.result.status;
    body = run.result.body;
    finalUrl = run.result.finalUrl;
    bodyPreview = previewBody(run.result.body);
    classification = run.classification;
    emptiness = run.emptiness;
    integrity = run.integrity;
    // Same downgrade as the active twin — plus it keeps the candidate inactive
    // and routes it to `review_strategy_candidate`, which is where "are these
    // the right rows?" can actually be answered.
    if (classification === 'explicit_success' && integrity.length > 0) {
      classification = 'transport_accepted';
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
      post_save_verification:
        sessionContext === 'fresh' ? proof : { ...proof, session_context: sessionContext },
      candidate_verification: {
        ...evidence,
        // Checks B and C compare two executions, so the review gate cannot
        // re-derive them from the single stored evidence body the way it
        // re-derives the body-only assessments. Carry them on the sidecar.
        ...(integrity.length > 0 ? { collection_integrity: integrity } : {}),
        // Whoever reviews this candidate needs to know a gate forced the
        // weaker conditions; the evidence body alone does not say so.
        ...(sessionContext === 'fresh' ? {} : { session_context: sessionContext }),
      },
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
  if (reachMiss) {
    // Never reached the page it reads, so nothing here is evidence about the
    // strategy. Same inactive resting place as any other non-promotion, but the
    // agent is told not to go fixing an expression that did not run.
    message =
      `strategy_candidate_target_unreachable: verification asked for ` +
      `${JSON.stringify(reachMiss.requested)} and the document that loaded was ` +
      `${JSON.stringify(reachMiss.reached)}, so ${ref.capability} never ran. The candidate remains ` +
      `inactive: it is incomplete rather than wrong — it does not yet get to the page it reads.` +
      (reachMiss.requested_carried_as_parameter
        ? ` The destination carries the requested URL as a query parameter, so it is holding it to ` +
          `return to — something stands in front of the page. That is ambient page state the strategy ` +
          `clears itself, via a prereq step before the read; the side effect persists for the rest of ` +
          `the run. A caller arriving with no history hits the same thing, so this is not an artifact ` +
          `of verification being cookieless.`
        : ` The requested URL does not appear on the destination, which reads as a moved or withdrawn ` +
          `page rather than a gate.`) +
      ` The expression never ran, so do not rewrite it — fix how the strategy reaches the page.`;
  } else if (classification === 'transport_accepted') {
    let unproven: string;
    if (emptiness) {
      unproven =
        `returned an explicit body.ok, but ${describeDeclaredCollectionEmptiness(emptiness)} — ` +
        `transport is proven, reading rows is not`;
    } else if (integrity.length > 0) {
      const plural = integrity.length > 1 ? 's' : '';
      unproven =
        `returned rows that failed ${integrity.length} structural check${plural} over the collection ` +
        `contract:${integrityEvidence(integrity)}`;
    } else {
      unproven = 'returned no explicit boolean body.ok';
    }
    message =
      `strategy_candidate_semantic_review_required: ${ref.capability} completed transport with ` +
      `HTTP ${status}, but ${unproven}. The candidate remains inactive. ` +
      (storedEvidence.reviewable
        ? `Inspect its exact candidate-bound evidence with ${TOOL_NAMES.reviewStrategyCandidate}, then submit a typed verdict.`
        : `Its exact result exceeded the review artifact bound, so there is nothing reviewable to ` +
          `submit a verdict against — the candidate cannot be promoted until the result is smaller. ` +
          narrowResultRemedy(candidate));
  } else if (classification === 'not_run') {
    message = `strategy_candidate_not_run: ${ref.capability} was not sent. The candidate remains inactive.`;
  } else if (classification === 'delivery_unknown') {
    message =
      `strategy_candidate_delivery_unknown: ${ref.capability} was sent without confirmation. ` +
      `The candidate remains inactive and must not be retried automatically.`;
  } else {
    // The strategy reported its own typed failure, so the runtime cannot say
    // why. It can say the one structural fact about the run the agent may not
    // have: this executed cold. A mechanism that only exists once the page is
    // an established session — an in-page module registry, a logged-in route,
    // a token the app mints after first visit — is absent here and present in
    // the authoring session, which reads as an inexplicable failure unless the
    // contract is stated. Responsibility sits with the strategy: prereqs run
    // inside this same context and their side effects persist for the run.
    message =
      `strategy_candidate_failed: ${ref.capability} returned ${statusLabel}. The candidate ` +
      `remains inactive and the prior active strategy is unchanged.` +
      (isOversizeBodyEnvelope(body)
        ? ` The bytes arrived — what failed is that the strategy returns the whole payload, which ` +
          `blew the output budget, so a caller gets this envelope instead of data. ` +
          narrowResultRemedy(candidate) +
          ` The evidence body carries a preview (or a trimmed a11y tree) of what came back — pick ` +
          `fields from that rather than re-driving.`
        : '') +
      (!isOversizeBodyEnvelope(body) ? coldRunNotice(ref.tier, status) : '');
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
    ...(emptiness ? { collection_keys: emptiness.keys } : {}),
    ...(integrity.length > 0
      ? {
          semantic_review_reason: (integrity[0] as CollectionIntegrityFinding).reason,
          collection_integrity: integrity,
        }
      : {}),
    message,
  };
}
