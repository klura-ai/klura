// Save-strategy audit: the `Audit` instance that runs on `save_strategy`.
// Composes save-warning detectors + token-gated classifiers under one
// rejection envelope. See runtime/src/audit/index.ts for the Audit class.

import { Audit, type Detector, type ShapeCheck, type Issue, type AuditResult } from './index';
import type { Strategy } from '../strategies/skills';
import {
  loadStrategies as loadStrategiesForPlatformAndCapability,
  listPlatformSkills as listAllSkills,
} from '../strategies/skills';
import {
  validateStrategyShape,
  validateNoSynthesizedAuthHeaders,
  validatePlaceholderReferences,
  validateNoOpaqueUserParams,
  validateCapabilityPrereqs,
  validateNoSelectorSelfReference,
} from '../strategies/validate';
import type { Session } from '../drivers/types/session';
import { findObservedKeys, findObservedLiterals } from '../observation-trace';
import { collectExecutableJsStrings } from '../gate/save-warnings';
import { findUnobservedStrategyUrls, firstObservableUrl } from '../strategies/verify-observed';
import { loadLogbook } from '../working-dir/logbook';
import { lookupSurface, urlKey } from '../session-phase/surface-binding';
import {
  detectSessionScopedIdExtraction,
  detectNameIdMismatch,
  detectEntityPinnedPrereqUrls,
  detectInlineMultiFetchPrereqs,
  detectPrereqBindKeyMismatch,
  detectLookupEmbeddedInPrereq,
  detectAuthGatedWithoutAuthPrereq,
  detectRecordedPathInlinesLookup,
  detectUngroundedEnumPlaceholder,
  detectEndpointCollidesWithSavedCapability,
  detectEnumParamListingUnfactored,
  detectEnumValueInCapabilitySlug,
  detectMutatingStrategyVerificationApproach,
  detectParameterizationDisclosureRequired,
  VERIFICATION_SHAPE_TAGS,
  FIRE_AND_FORGET_JUSTIFYING_NOUNS,
  NON_DOM_VERIFICATION_MARKERS,
  type SaveWarning,
} from '../gate/save-warnings';
import { validateLookupPrereqsAreCapabilities, type ObservedSiblingItem } from '../gate/save-audit';
import {
  literalProvenanceClassifier,
  capabilityNameJustificationClassifier,
  observedSiblingsClassifier,
  userConfirmationClassifier,
} from './save-strategy-classifiers';
import type { ParamObservation } from '../response/session-observations';

export interface SaveStrategyCtx {
  /** Session id of the discovery flow that produced this save. Several
   *  detectors use it to look up declared args / captured requests. */
  sessionId?: string;
  /** Platform slug — used by the Stage 0 shape checks that cross-reference
   *  platform-scoped logbook + saved-skill data (validateCapabilityPrereqs,
   *  validateNoOpaqueUserParams). */
  platform: string;
  /** Capability slug being saved. */
  capability: string;
  /** Live session for observation-trace queries (observed property keys
   *  in expression bodies). Null when saveStrategy runs without a live
   *  session (programmatic saves, tests). */
  session?: Session | null;
  /** Captured endpoint URLs from the session that aren't yet covered by
   *  a saved sibling strategy. Feeds the observed_siblings classifier:
   *  the agent classifies each as `recorded` or `not_worth_recording:<reason>`. */
  observedSiblings: ObservedSiblingItem[];
  /** Per-parameter observations gathered during the session (UI click →
   *  XHR correlation). Keyed by param name. Feeds the enum-param
   *  consistency check inside literal_provenance. */
  observedParamValues: Record<string, ParamObservation[]>;
  /** All endpoint origin+pathname pairs captured in the session. Used by
   *  the lookup-prereq-must-be-capability detector to check whether an
   *  inline lookup prereq matches a captured endpoint. */
  capturedEndpointPaths: Set<string>;
  /** All URLs the agent observed during discovery (network-log XHR/fetch
   *  + top-level document navigations). Used by the unobserved_url
   *  Detector to reject saves whose endpoint / prereq URL wasn't seen
   *  in the live capture — agent recalled from training data instead.
   *  Per principles.md §"Observe, not probe", this is runtime-enforced
   *  with `ackReason: 'none'`. */
  observedUrls?: readonly string[];
}

// Cast helper: existing detect functions return SaveWarning[]; the Audit's
// Issue interface has the same shape (`{kind, message, hint?}`) plus an
// optional `context` field, so the structural cast is safe.
function asIssues(ws: SaveWarning[]): Issue[] {
  return ws as Issue[];
}

// ---------- Detector specs ----------

// Every save must target a surface that's been triaged. Tier-agnostic:
// fetch / page-script / recorded-path all flow through this gate. The
// runtime knows the surface binding via `session.surfaceMap`, and the
// platform logbook holds the canonical per-surface plan. Without a
// matching plan the rejection forces the agent through `submit_triage_plan`
// for the surface the strategy targets — the justified verdict is the
// deliberate ownership the prior `recorded_path_in_triage` block was
// protecting, now generalized to all tiers.
const surfaceTriageMissingDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'surface_triage_missing',
  detect: (data, ctx) => {
    if (!ctx.session) return [];
    // Save-strategy is admissible only in lift / triage per the phase
    // catalog. Programmatic / out-of-phase saves (unit tests of other
    // detectors, internal callers) skip the gate — no triage flow has
    // run, no surface map exists by construction. Production saves
    // always carry phase=lift|triage by the time they reach the audit.
    const phase = ctx.session.phase;
    if (phase !== 'lift' && phase !== 'triage') return [];
    const targetUrl = firstObservableUrl(data as unknown as Record<string, unknown>);
    if (!targetUrl) return [];
    const surface = lookupSurface(ctx.session, targetUrl);
    const targetKey = urlKey(targetUrl) ?? targetUrl;
    const tier = (data as { strategy?: unknown }).strategy;
    const tierStr = typeof tier === 'string' ? tier : 'unknown';
    const urlSource = describeUrlSource(data as Record<string, unknown>, tierStr);
    const suggestedMethod = describeSuggestedMethod(data as Record<string, unknown>, tierStr);
    if (!surface) {
      const triagedSurfaces = listTriagedSurfaces(ctx.session.platform);
      const surfaceList =
        triagedSurfaces.length > 0
          ? triagedSurfaces
              .map(
                (s) =>
                  `  - "${s.label}" request_patterns: [${s.patterns.map((p) => JSON.stringify(p)).join(', ')}]`,
              )
              .join('\n')
          : '  <no triage plans submitted yet>';
      const fixOptions =
        triagedSurfaces.length > 0
          ? [
              `(a) Re-submit \`submit_triage_plan\` for an existing surface, adding \`${suggestedMethod} ${targetKey}\` to its \`request_patterns\` (re-use the prior plan's other fields);`,
              `(b) Submit a new \`submit_triage_plan\` with a fresh \`surface_label\` whose \`request_patterns\` includes \`${suggestedMethod} ${targetKey}\`.`,
            ]
          : [
              `Submit your first \`submit_triage_plan\` for this URL — pick a \`surface_label\`, include \`${suggestedMethod} ${targetKey}\` in \`request_patterns\`, declare the defense surface (third-party origins / scripts / cookies you observed), write a cited \`tier_justification\`.`,
            ];
      return [
        {
          kind: 'surface_triage_missing',
          message:
            `\`save_strategy\` (${tierStr}) ${tierStr === 'recorded-path' ? 'navigates to' : 'targets'} \`${targetKey}\` (${urlSource}). ` +
            `This URL doesn't match the \`request_patterns\` of any triaged surface in this session.\n` +
            `\n` +
            `Triaged surfaces (${triagedSurfaces.length}):\n` +
            surfaceList +
            `\n\n` +
            `Fix one of:\n` +
            fixOptions.map((opt) => `  ${opt}`).join('\n'),
          hint: `Surface→strategy URL binding is tier-aware (\`recorded-path\` binds the first \`navigate\` step URL; \`fetch\`/\`page-script\` bind the resolved endpoint). See klura://reference#triage-surface-binding.`,
          context: {
            target_url: targetKey,
            tier: tierStr,
            suggested_method: suggestedMethod,
            triaged_surfaces: triagedSurfaces,
          },
        },
      ];
    }
    if (!ctx.session.platform) {
      // No platform → can't look up logbook plans. Defer to other gates;
      // the surfaceMap lookup above already established intent.
      return [];
    }
    const logbook = loadLogbook(ctx.session.platform);
    // A triage plan is a per-surface description of the defense posture —
    // sibling capabilities that target the same surface (e.g. a data-load
    // and its listing endpoint on the same origin) inherit the surface's
    // plan rather than requiring a redundant re-triage. Pass when ANY
    // capability on this platform has a plan for this surface.
    const platformHasSurfacePlan = Object.values(logbook.per_capability).some(
      (entry) => entry.triage_plans_by_surface?.[surface],
    );
    if (!platformHasSurfacePlan) {
      return [
        {
          kind: 'surface_triage_missing',
          message:
            `\`save_strategy\` (${tierStr}) ${tierStr === 'recorded-path' ? 'navigates to' : 'targets'} \`${targetKey}\` (${urlSource}), bound to surface \`${surface}\`, but the platform logbook has no current triage plan for that surface. ` +
            `Re-submit via \`submit_triage_plan\` with \`surface_label: "${surface}"\` and \`${suggestedMethod} ${targetKey}\` in \`request_patterns\`.`,
          hint: 'Re-submit triage for the bound surface. See klura://reference#triage-surface-binding.',
          context: {
            target_url: targetKey,
            tier: tierStr,
            suggested_method: suggestedMethod,
            surface,
            capability: ctx.capability,
          },
        },
      ];
    }
    return [];
  },
  ackReason: 'none',
};

/** Describe where in the strategy the target URL came from, for the
 *  rejection prose. Recorded-path strategies anchor on the first navigate
 *  step; fetch/page-script anchor on the endpoint. */
function describeUrlSource(data: Record<string, unknown>, tier: string): string {
  if (tier === 'recorded-path') {
    const steps = data.steps;
    if (Array.isArray(steps)) {
      for (let i = 0; i < steps.length; i++) {
        const step: unknown = steps[i];
        if (
          step &&
          typeof step === 'object' &&
          (step as { action?: unknown }).action === 'navigate'
        ) {
          return `from steps[${i}].url`;
        }
      }
    }
    return 'from first navigate step';
  }
  if (tier === 'fetch' || tier === 'page-script') return 'from endpoint';
  return 'derived from strategy';
}

/** Suggest the METHOD token for the `request_patterns` entry the agent
 *  should add. Recorded-path navigate steps are document loads (GET);
 *  fetch/page-script use whatever method the strategy declares (default
 *  GET when omitted). */
function describeSuggestedMethod(data: Record<string, unknown>, tier: string): string {
  if (tier === 'recorded-path') return 'GET';
  if (tier === 'fetch' || tier === 'page-script') {
    const method = data.method;
    if (typeof method === 'string' && method.length > 0) return method.toUpperCase();
    return 'GET';
  }
  return 'GET';
}

/** List every (surface_label, request_patterns) pair the platform has on
 *  disk. One surface label may be shared across sibling capabilities; we
 *  surface the FIRST plan's request_patterns per label since `request_patterns`
 *  is a per-surface declaration that doesn't differ between siblings. */
function listTriagedSurfaces(
  platform: string | undefined,
): Array<{ label: string; patterns: string[] }> {
  if (!platform) return [];
  const logbook = loadLogbook(platform);
  const seen = new Map<string, string[]>();
  for (const entry of Object.values(logbook.per_capability)) {
    if (!entry.triage_plans_by_surface) continue;
    for (const [label, plan] of Object.entries(entry.triage_plans_by_surface)) {
      if (seen.has(label)) continue;
      seen.set(label, plan.defense_surface.request_patterns);
    }
  }
  return Array.from(seen, ([label, patterns]) => ({ label, patterns }));
}

// Tier downgrade vs. agent's own triage verdict. The agent submits a
// `submit_triage_plan` with an `expected_tier` (the cleanest answer it
// believes lives at this surface) and a `tier_justification` citing
// observed evidence. Saving a strictly worse tier than that verdict
// without revising the plan first means the agent committed to fetch and
// then bailed to recorded-path because some other gate / probe pushed
// back — leaving on disk a strategy that contradicts its own logbook
// entry. The detector cites the verdict back at the agent so it either
// fixes the actual blocker (probe failure, surface binding, etc.) or
// re-submits triage with a downgraded verdict and `tier_justification`.
//
// `ackReason: 'required'` — Level-2 acked-warning. Single-fire per
// (capability, surface, tier) hash, no token-gating per
// runtime/docs/gates.md §"once-per-session vs N-per-session".
const TIER_RANK: Record<string, number> = { fetch: 0, 'page-script': 1, 'recorded-path': 2 };
const tierBelowTriageVerdictDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'tier_below_triage_verdict',
  detect: (data, ctx) => {
    if (!ctx.session?.platform) return [];
    const savedTier = (data as { strategy?: unknown }).strategy;
    if (typeof savedTier !== 'string' || !(savedTier in TIER_RANK)) return [];
    const targetUrl = firstObservableUrl(data as unknown as Record<string, unknown>);
    if (!targetUrl) return [];
    const surface = lookupSurface(ctx.session, targetUrl);
    if (!surface) return [];
    const logbook = loadLogbook(ctx.session.platform);
    const plan = logbook.per_capability[ctx.capability]?.triage_plans_by_surface?.[surface];
    if (!plan) return [];
    const verdictTier = plan.expected_tier;
    if (typeof verdictTier !== 'string' || !(verdictTier in TIER_RANK)) return [];
    const savedRank = TIER_RANK[savedTier];
    const verdictRank = TIER_RANK[verdictTier];
    if (savedRank === undefined || verdictRank === undefined || savedRank <= verdictRank) return [];
    const verdictExcerpt =
      typeof plan.tier_justification === 'string' && plan.tier_justification.length > 0
        ? ` Verdict cited: ${JSON.stringify(plan.tier_justification.slice(0, 240))}.`
        : '';
    return [
      {
        kind: 'tier_below_triage_verdict',
        message:
          `\`save_strategy\` is committing tier=${JSON.stringify(savedTier)} for surface "${surface}", but ` +
          `the triage plan you approved for this surface called expected_tier=${JSON.stringify(verdictTier)}.${verdictExcerpt} ` +
          `If something pushed you off the cleaner tier (probe failure, save-time rejection, surface binding mismatch), fix that — ` +
          `don't bake the worse tier on disk. If the verdict was wrong, re-submit triage with a revised \`expected_tier\` + \`tier_justification\` ` +
          `before saving.`,
        hint:
          `Two ways to clear this: (a) save the strategy at the verdict's tier (${verdictTier}), or ` +
          `(b) re-submit \`submit_triage_plan\` with a revised \`expected_tier: "${savedTier}"\` and a ` +
          `\`tier_justification\` that names the structural blocker that pushed you off ${verdictTier}. ` +
          `No ack-bypass — if the verdict is right, fix the save; if it's wrong, fix the verdict.`,
        context: {
          saved_tier: savedTier,
          verdict_tier: verdictTier,
          surface,
          capability: ctx.capability,
        },
      },
    ];
  },
  ackReason: 'none',
};

const sessionScopedIdDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'unparametrized_session_id',
  detect: (data) => asIssues(detectSessionScopedIdExtraction(data)),
  ackReason: 'required',
};

const nameIdMismatchDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'unresolved_name_to_id_gap',
  detect: (data, ctx) => asIssues(detectNameIdMismatch(data, ctx.sessionId)),
  ackReason: 'required',
};

const entityPinnedPrereqUrlsDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'entity_pinned_infra_prereq',
  detect: (data, ctx) => asIssues(detectEntityPinnedPrereqUrls(data, ctx.sessionId)),
  ackReason: 'required',
};

const inlineMultiFetchPrereqsDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'inline_multi_fetch_prereq',
  detect: (data) => asIssues(detectInlineMultiFetchPrereqs(data)),
  ackReason: 'required',
};

const prereqBindKeyMismatchDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'prereq_bind_key_mismatch',
  detect: (data, ctx) => asIssues(detectPrereqBindKeyMismatch(data, ctx.sessionId)),
  ackReason: 'required',
};

const lookupEmbeddedInPrereqDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'lookup_embedded_in_prereq',
  detect: (data, ctx) => asIssues(detectLookupEmbeddedInPrereq(data, ctx.capability)),
  ackReason: 'required',
};

const authGatedWithoutAuthPrereqDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'auth_gated_without_auth_prereq',
  detect: (data, ctx) => asIssues(detectAuthGatedWithoutAuthPrereq(data, ctx.sessionId)),
  ackReason: 'required',
};

const recordedPathInlinesLookupDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'recorded_path_inlines_lookup',
  detect: (data, ctx) =>
    asIssues(detectRecordedPathInlinesLookup(data, ctx.capturedEndpointPaths, ctx.capability)),
  ackReason: 'none',
};

const ungroundedEnumPlaceholderDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'ungrounded_enum_placeholder',
  detect: (data, ctx) => asIssues(detectUngroundedEnumPlaceholder(data, ctx.observedParamValues)),
  // Ackable: the canonical escape hatch is `text_kind_justification` —
  // the agent's claim that the param really is text-shaped despite
  // observed click values (e.g. a search box accepting both typed text
  // and clicked suggestion tiles for the same param). The agent acks
  // with their justification text. The literal_provenance Classifier
  // (Stage 2) still scrutinizes the justification's quality once Stage
  // 1 clears.
  ackReason: 'required',
};

const enumParamListingUnfactoredDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'enum_param_listing_unfactored',
  detect: (data, ctx) => {
    const platform = ctx.session?.platform;
    const skill = platform ? listAllSkills().find((s) => s.platform === platform) : undefined;
    const namesForPlatform = skill ? skill.capabilities.map((c) => c.name) : [];
    return asIssues(
      detectEnumParamListingUnfactored(
        data,
        ctx.session ?? null,
        ctx.capability,
        platform ? (cap) => loadStrategiesForPlatformAndCapability(platform, cap) : undefined,
        platform ? () => namesForPlatform : undefined,
      ),
    );
  },
  // No ack-bypass: when the session captured a listing endpoint that
  // enumerates an enum param's values, the right shape is to save the
  // listing as its own capability — not bake static observed_values and
  // ack the warning. Paginated listings / partial subsets / auth-gated
  // listings can be expressed via separate capability shapes (the listing
  // capability itself can have its own prereqs); they don't need an
  // ack-bypass on this detector.
  ackReason: 'none',
};

const enumValueInCapabilitySlugDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'enum_value_baked_into_slug',
  detect: (data, ctx) => asIssues(detectEnumValueInCapabilitySlug(data, ctx.capability)),
  // Ackable: legitimate noun-overlap exists (e.g. `create_issue` whose
  // param `context` enumerates `issue` among other labels). Mirrors the
  // triage-time `enum_value_baked_into_slug` Detector severity so both
  // gates speak the same envelope.
  ackReason: 'required',
};

const endpointCollidesWithSavedCapabilityDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'endpoint_collides_with_saved_capability',
  detect: (data, ctx) => {
    const platform = ctx.session?.platform;
    if (!platform) return [];
    const skill = listAllSkills().find((s) => s.platform === platform);
    if (!skill) return [];
    const namesForPlatform = skill.capabilities.map((c) => c.name);
    return asIssues(
      detectEndpointCollidesWithSavedCapability(
        data,
        ctx.capability,
        (cap) => loadStrategiesForPlatformAndCapability(platform, cap),
        () => namesForPlatform,
      ),
    );
  },
  ackReason: 'none',
};

// Mutating-shaped strategies (HTTP POST/PUT/PATCH/DELETE on fetch /
// page-script, recorded-path with type/submit, page-script with WS
// publish/send) MUST verify the side effect actually landed before
// returning ok:true. status:200 alone proves the network call
// succeeded — not that the right entity was mutated. Almost every
// mutating action exposes some confirmation surface; truly-no-verify
// flows are rare. The agent must declare their verification approach
// in the ack reason; the runtime checks the reason is structurally
// grounded (anti-canned-ack + anchor-match).
//
// See `feedback_always_verify_mutating_actions.md` for the design rule.
const mutatingVerificationRequiredDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'mutating_verification_required',
  detect: (data) => asIssues(detectMutatingStrategyVerificationApproach(data)),
  ackReason: 'required',
  // Two-stage check.
  //
  // 1. Anti-canned: reason must contain at least one of (a) a path-shaped
  //    token naming a real element of the saved strategy (response.extract.<x>,
  //    prerequisites[N], frameFromPage, etc.), OR (b) a recognized shape tag
  //    (transaction-shape / chat-shape / dom-poll / intrinsic-to-caller /
  //    fire-and-forget). `fire-and-forget` ALSO requires a justifying noun
  //    so it can't be abused as a free pass.
  //
  // 2. Anchor-match: verification durability must match the strategy's
  //    notes.anchor_type. Module/protocol-anchored strategies whose ONLY
  //    verification claim is `dom-poll` make the DOM the new fragility
  //    bottleneck. Reject those — the agent must re-anchor verification
  //    or down-classify the strategy's anchor.
  validateAck: (reason, emittedIssues) => {
    const issue = emittedIssues[0];
    const ctx = (issue as { context?: { anchor_type?: unknown; valid_paths?: unknown } }).context;
    const anchorType =
      typeof ctx?.anchor_type === 'string'
        ? (ctx.anchor_type as 'module' | 'protocol' | 'dom' | 'unknown')
        : 'unknown';
    const validPaths = Array.isArray(ctx?.valid_paths) ? (ctx.valid_paths as string[]) : [];

    const out: string[] = [];

    // Detect shape tag(s) used. Case-sensitive literal substring.
    const shapeTagsUsed = VERIFICATION_SHAPE_TAGS.filter((t) => reason.includes(t));

    // Detect path-shaped tokens that name a real element of the strategy.
    // Sort longest-first so `response.extract.message_id` matches before
    // the bare `response.extract` fallback would.
    const matchedPaths = [...validPaths]
      .sort((a, b) => b.length - a.length)
      .filter((p) => reason.includes(p));

    if (shapeTagsUsed.length === 0 && matchedPaths.length === 0) {
      out.push(
        `reason must name the verification approach by structural anchor. Either reference a real path of the saved strategy (e.g. response.extract.<field>, prerequisites[N], frameFromPage.expression) OR include a shape tag (transaction-shape / chat-shape / dom-poll / intrinsic-to-caller / rpc-read / fire-and-forget). Prose-only reasons are rejected.`,
      );
      return out;
    }

    // fire-and-forget needs a justifying noun.
    if (shapeTagsUsed.includes('fire-and-forget')) {
      const lower = reason.toLowerCase();
      const justified = FIRE_AND_FORGET_JUSTIFYING_NOUNS.some((n) => lower.includes(n));
      if (!justified) {
        out.push(
          `fire-and-forget tag requires a justifying noun naming the kind of unverified action: one of ${FIRE_AND_FORGET_JUSTIFYING_NOUNS.join(', ')}. Most mutating actions have a confirmation surface — fire-and-forget is rare and must be specific.`,
        );
      }
    }

    // Anchor-match check. If the strategy is module- or protocol-anchored
    // AND the only signal in the ack reason is dom-poll (no module/protocol
    // marker, no transaction-shape / chat-shape / intrinsic-to-caller), the
    // DOM is now the fragility bottleneck.
    if (anchorType === 'module' || anchorType === 'protocol') {
      const hasOnlyDomPoll =
        shapeTagsUsed.includes('dom-poll') &&
        !shapeTagsUsed.some(
          (t) => t === 'transaction-shape' || t === 'chat-shape' || t === 'intrinsic-to-caller',
        );
      const hasNonDomMarker = NON_DOM_VERIFICATION_MARKERS.some((m) => reason.includes(m));
      if (hasOnlyDomPoll && !hasNonDomMarker) {
        out.push(
          `anchor mismatch: strategy is ${anchorType}-anchored but verification is DOM-anchored (dom-poll). DOM polling becomes the fragility bottleneck — when the UI rewrites, verification breaks even though the underlying ${anchorType} call still works. Either re-anchor verification to ${anchorType}-tier surfaces (response.extract / window.require page-global readback / frameFromPage parsing the wire response), or down-classify notes.anchor_type to "dom".`,
        );
      }
    }

    return out;
  },
};

// Parameterization-disclosure detector — every saved strategy must declare
// the caller-varying axes (`notes.params`) or explicitly justify why none
// apply. End-drive's auto-derive populates `notes.params` only from
// caller-typed literals; sessions driven with `args:{}` land paramless
// strategies that warm callers can't customize. The detector fires on
// every tier when notes.params is empty/undefined; the ack reason must
// reference at least one structural anchor of the saved strategy
// (anti-canned). See `save-warnings-parameterization.ts`.
const parameterizationDisclosureRequiredDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'parameterization_disclosure_required',
  detect: (data) => asIssues(detectParameterizationDisclosureRequired(data)),
  ackReason: 'required',
  // Anti-canned: ack reason must include at least one path-shaped token
  // from the candidate-anchors list emitted by the detector. Forces the
  // agent to read the rejection's specifics rather than canned-acking.
  validateAck: (reason, emittedIssues) => {
    const issue = emittedIssues[0];
    const ctx = (issue as { context?: { candidate_anchors?: unknown } }).context;
    const anchors = Array.isArray(ctx?.candidate_anchors)
      ? ctx.candidate_anchors.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];

    if (anchors.length === 0) {
      // Degenerate strategy: no body, no headers, no endpoint, no prereqs,
      // no steps — nothing to anchor on. Fail-closed: a strategy with no
      // structural surface can't be a real capability.
      return [
        `strategy has no structural anchors (endpoint, body, headers, prereqs, steps all empty). ` +
          `Either populate the strategy with the captured request data or save a recorded-path with steps.`,
      ];
    }

    // Sort longest-first so multi-segment paths like `body.recipient_id`
    // match before the bare `body` fallback.
    const matched = [...anchors]
      .sort((a, b) => b.length - a.length)
      .filter((a) => reason.includes(a));
    if (matched.length === 0) {
      const sample = anchors.slice(0, 8).join(', ');
      return [
        `reason must reference at least one structural anchor of the saved strategy. Candidates include: ` +
          `${sample}${anchors.length > 8 ? ', …' : ''}. Bare prose like "no params apply" or "this capability ` +
          `takes no input" is rejected — name the body field / endpoint segment / prereq / header that proves ` +
          `the rejection was read.`,
      ];
    }
    return [];
  },
};

// ---------- Unconditional detector (was validateLookupPrereqsAreCapabilities) ----------

// Every endpoint / prereq URL in the saved strategy must match a host+path
// the agent saw in the discovery session's network log (or a top-level
// document navigation). Catches the agent recalling a brand-name public
// API host from training data instead of the canonical-site XHR endpoint
// the web app actually called. Per principles.md §"Observe, not probe",
// this is runtime-enforced — no legitimate ack-through path because
// allowing the agent to bypass would mean URL hallucination from training
// data could land on disk. ackReason: 'none'.
const unobservedUrlDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'unobserved_url',
  detect: (data, ctx) => {
    // Tolerate ctx omitting observedUrls (programmatic saves, detector-unit
    // tests). Production save paths pass the captured URL list explicitly;
    // an explicit empty list still means "the session captured nothing" and
    // should fire.
    if (ctx.observedUrls === undefined) return [];
    const observedUrls = ctx.observedUrls;
    const issues = findUnobservedStrategyUrls(
      data as unknown as Record<string, unknown>,
      observedUrls,
    );
    return issues.map((i) => ({
      kind: 'unobserved_url',
      message: i.message,
      context: { where: i.where, url: i.url },
    }));
  },
  ackReason: 'none',
};

// Lookup-shaped slug + inline lookup-shaped prereq → must be split into a
// sibling capability prereq. No legitimate ack path: the issue is "your
// lookup is duplicated inline; split it." Per principles.md §"Observe, not
// probe", this is runtime-enforced. ackReason: 'none'.
const lookupPrereqMustBeCapabilityDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'lookup_prereq_must_be_capability',
  detect: (data, ctx) => {
    const issues = validateLookupPrereqsAreCapabilities(
      ctx.capability,
      data,
      ctx.capturedEndpointPaths,
    );
    return issues.map((message) => ({
      kind: 'lookup_prereq_must_be_capability',
      message,
    }));
  },
  ackReason: 'none',
};

// ---------- Observed-property-keys detector (was minified-offset gate) ----------

// Property-access chains in expression bodies (frameFromPage.expression,
// js-eval prereqs) where the keys came from runtime observation in this
// session — i.e., names the agent saw via Object.keys output, find_in_page
// match, etc. Observed names are fragile (rotate on every minified /
// obfuscated / refactor-heavy deploy). Same provenance check the legacy
// minified-offset gate ran; folded into the consolidated audit as one
// Detector with a per-detector ack-validator that preserves the
// anti-canned-ack property (ack must reference a flagged key).
const observedPropertyKeysDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'observed_property_keys',
  detect: (data, ctx) => {
    if (!ctx.session) return [];
    const issues: Issue[] = [];
    for (const { location, text } of collectExecutableJsStrings(data)) {
      const flagged = findObservedKeys(text, ctx.session);
      if (flagged.length === 0) continue;
      const observed_keys = Array.from(new Set(flagged.map((f) => f.key)));
      issues.push({
        kind: 'observed_property_keys',
        message:
          `${location} bakes observed property keys [${observed_keys.map((k) => JSON.stringify(k)).join(', ')}] ` +
          `inside ${JSON.stringify(text).slice(0, 120)}…`,
        hint:
          `Replace with a shape-walk: Object.values(window.X).find(v => typeof v?.<knownField> === "string"). ` +
          `See klura://reference#save-strategy-audit.`,
        context: { location, observed_keys, expression: text },
      });
    }
    return issues;
  },
  ackReason: 'required',
  // Anti-canned-ack: the reason must reference at least one flagged key
  // with a word boundary (no substring matches inside common English
  // words). Forces the agent to read the rejection's specifics.
  validateAck: (reason, emittedIssues) => {
    const allKeys = new Set<string>();
    for (const issue of emittedIssues) {
      const ctx = (issue as { context?: { observed_keys?: unknown } }).context;
      const keys = ctx?.observed_keys;
      if (Array.isArray(keys)) {
        for (const k of keys) if (typeof k === 'string') allKeys.add(k);
      }
    }
    if (allKeys.size === 0) return [];
    const referenced = [...allKeys].some((k) => {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i');
      return re.test(reason);
    });
    if (!referenced) {
      const quotedKeys = [...allKeys].map((k) => `"${k}"`).join(', ');
      return [
        `must reference at least one flagged key (${quotedKeys}) ` +
          `to prove the rejection was read — a generic "intentional" doesn't pass`,
      ];
    }
    return [];
  },
};

// ---------- Observed-literal-values detector ----------

// Same provenance mechanism as observed_property_keys, applied to header /
// body / recorded-path step VALUES rather than expression keys. Catches
// the canonical baked-rotating-token case: agent observes a per-page nonce
// at runtime (via find_in_page or js_eval), pastes it verbatim into
// `headers["x-nonce"]` instead of templating it through a prereq, save
// proceeds, next deploy rotates the nonce, the saved strategy 401s.
//
// STABLE_LITERAL_VALUES allowlist filters common HTTP / wire vocabulary
// (`application/json`, `GET`, `keep-alive`, etc.) that may legitimately
// match observed strings without indicating fragility.
const observedLiteralValuesDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'observed_literal_values',
  detect: (data, ctx) => {
    if (!ctx.session) return [];
    const flagged = findObservedLiterals(data, ctx.session);
    return flagged.map((l) => ({
      kind: 'observed_literal_values',
      message:
        `${l.location} bakes the literal value ${JSON.stringify(l.value).slice(0, 80)} ` +
        `which the agent observed during this session — that's by-construction a per-session ` +
        `or per-deploy artifact (rotating token, nonce, signed header), not a stable contract.`,
      hint:
        `Template via a prereq: declare a js-eval prereq that re-derives the value from ` +
        `the live page on every call, bind it (e.g. \`binds: "nonce"\`), and reference \`{{nonce}}\` ` +
        `in the header / body. See klura://reference#save-strategy-audit.`,
      context: { location: l.location, value: l.value },
    }));
  },
  ackReason: 'required',
  // Anti-canned-ack: ack must reference a flagged value. Same shape as
  // observed_property_keys. Forces the agent to read the rejection's
  // specifics rather than canned-acking by kind.
  validateAck: (reason, emittedIssues) => {
    const allValues = new Set<string>();
    for (const issue of emittedIssues) {
      const ctx = (issue as { context?: { value?: unknown } }).context;
      const v = ctx?.value;
      if (typeof v === 'string') allValues.add(v);
    }
    if (allValues.size === 0) return [];
    const referenced = [...allValues].some((v) => reason.includes(v));
    if (!referenced) {
      // Show only the first 12 chars of each value in the error so the
      // ack-issue is readable for long tokens.
      const previews = [...allValues].map((v) => JSON.stringify(v.slice(0, 12) + '…'));
      return [
        `must reference at least one flagged literal value (e.g. ${previews.join(', ')}) ` +
          `to prove the rejection was read — a generic "intentional" doesn't pass`,
      ];
    }
    return [];
  },
};

// ---------- Popup-addressing-without-trigger detector ----------

// Recorded-path strategies can pin individual steps to a tracked sub-page
// (e.g. an OAuth consent popup) via `step.page: "popup-1"`. At warm replay,
// the runtime needs `popup-1` to actually open at the right point in the
// flow — usually because an earlier step clicked the trigger that fired
// `window.open()` / followed a `target=_blank` link. When the discovery
// session never observed any popup at all (`session.subPages` is empty or
// missing), saving a strategy that depends on `popup-1` is virtually
// guaranteed to fail at warm-replay: nothing in the flow opens the popup
// the saved steps target. Surface as a save_warning so the agent can fix
// the steps (or ack with a reason — e.g. they're saving a strategy whose
// popup is opened via a side channel like a browser extension; rare but
// not zero). ackReason: 'required'.
function detectPopupAddressingWithoutTrigger(
  data: Strategy,
  session: Session | null | undefined,
): SaveWarning[] {
  if (data.strategy !== 'recorded-path') return [];
  const steps = (data as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const stepArray = steps as unknown[];
  const offending: Array<{ index: number; id: string; page: string }> = [];
  for (let i = 0; i < stepArray.length; i += 1) {
    const step = stepArray[i];
    if (!step || typeof step !== 'object') continue;
    const page = (step as { page?: unknown }).page;
    if (typeof page !== 'string' || page === 'main') continue;
    offending.push({
      index: i,
      id:
        typeof (step as { id?: unknown }).id === 'string'
          ? (step as { id: string }).id
          : `step_${i}`,
      page,
    });
  }
  if (offending.length === 0) return [];
  // Distinct popup handles the steps reference.
  const referenced = Array.from(new Set(offending.map((o) => o.page)));
  // Did the discovery session observe any of these popups?
  const observed = new Set((session?.subPages ?? []).map((p) => p.id));
  const unobserved = referenced.filter((id) => !observed.has(id));
  if (unobserved.length === 0) return [];
  const referencedFmt = referenced.map((p) => JSON.stringify(p)).join(', ');
  const unobservedFmt = unobserved.map((p) => JSON.stringify(p)).join(', ');
  const stepsFmt = offending
    .filter((o) => unobserved.includes(o.page))
    .map((o) => `steps[${o.index}] (id ${JSON.stringify(o.id)}, page ${JSON.stringify(o.page)})`)
    .join('; ');
  return [
    {
      kind: 'popup_addressing_without_trigger',
      message:
        `Recorded-path references popup handles [${referencedFmt}] but the discovery session ` +
        `never observed [${unobservedFmt}] — no step in this flow opens the popup that these ` +
        `steps target, so warm replay will fail at the first popup-pinned step. Offending: ` +
        `${stepsFmt}.`,
      hint:
        `Either (a) add the click that triggers window.open() / opens the target=_blank link ` +
        `as a step before the popup-pinned ones, (b) re-discover the flow so the popup is ` +
        `actually observed (session.subPages will fill in), or (c) ack via ` +
        `notes.save_warnings_acked: [{kind: "popup_addressing_without_trigger", reason: "..."}] ` +
        `if the popup is opened by a side channel (browser extension, prior tab) — describe ` +
        `the channel. See klura://reference#popups.`,
    },
  ];
}

const popupAddressingWithoutTriggerDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'popup_addressing_without_trigger',
  detect: (data, ctx) => asIssues(detectPopupAddressingWithoutTrigger(data, ctx.session ?? null)),
  ackReason: 'required',
};

// ---------- Stage 0 shape checks ----------
// Each check is a thin wrapper around a throw-style validator from
// `runtime/src/strategies/validate/`. The Audit framework catches the
// `invalid_strategy: ...` throw, unpacks bundled "N issues — fix all" errors
// via `extractBundledIssues`, and returns one combined `invalid_shape`
// rejection. This keeps shape, semantic detectors, and token-gated
// classifiers under the same rejection envelope.
const strategyShapeCheck: ShapeCheck<Strategy, SaveStrategyCtx> = {
  kind: 'strategy_shape',
  check: (data) => {
    validateStrategyShape(data);
  },
};
const noSynthesizedAuthHeadersCheck: ShapeCheck<Strategy, SaveStrategyCtx> = {
  kind: 'no_synthesized_auth_headers',
  check: (data) => {
    validateNoSynthesizedAuthHeaders(data);
  },
};
const placeholderReferencesCheck: ShapeCheck<Strategy, SaveStrategyCtx> = {
  kind: 'placeholder_references',
  check: (data) => {
    validatePlaceholderReferences(data);
  },
};
const noOpaqueUserParamsCheck: ShapeCheck<Strategy, SaveStrategyCtx> = {
  kind: 'no_opaque_user_params',
  check: (data, ctx) => {
    validateNoOpaqueUserParams(data, ctx.sessionId, ctx.platform);
  },
};
const capabilityPrereqsCheck: ShapeCheck<Strategy, SaveStrategyCtx> = {
  kind: 'capability_prereqs',
  check: (data, ctx) => {
    validateCapabilityPrereqs(data, ctx.platform, ctx.capability);
  },
};
const noSelectorSelfReferenceCheck: ShapeCheck<Strategy, SaveStrategyCtx> = {
  kind: 'no_selector_self_reference',
  check: (data) => {
    validateNoSelectorSelfReference(data);
  },
};

// ---------- Audit instance ----------

export const saveStrategyAudit = new Audit<Strategy, SaveStrategyCtx>({
  kind: 'save_strategy',
  shapeChecks: [
    strategyShapeCheck,
    noSynthesizedAuthHeadersCheck,
    placeholderReferencesCheck,
    noOpaqueUserParamsCheck,
    capabilityPrereqsCheck,
    noSelectorSelfReferenceCheck,
  ],
  detectors: [
    surfaceTriageMissingDetector,
    tierBelowTriageVerdictDetector,
    sessionScopedIdDetector,
    nameIdMismatchDetector,
    entityPinnedPrereqUrlsDetector,
    inlineMultiFetchPrereqsDetector,
    prereqBindKeyMismatchDetector,
    lookupEmbeddedInPrereqDetector,
    authGatedWithoutAuthPrereqDetector,
    recordedPathInlinesLookupDetector,
    ungroundedEnumPlaceholderDetector,
    enumParamListingUnfactoredDetector,
    enumValueInCapabilitySlugDetector,
    endpointCollidesWithSavedCapabilityDetector,
    mutatingVerificationRequiredDetector,
    parameterizationDisclosureRequiredDetector,
    unobservedUrlDetector,
    lookupPrereqMustBeCapabilityDetector,
    observedPropertyKeysDetector,
    observedLiteralValuesDetector,
    popupAddressingWithoutTriggerDetector,
  ],
  classifiers: [
    literalProvenanceClassifier,
    capabilityNameJustificationClassifier,
    observedSiblingsClassifier,
    userConfirmationClassifier,
  ],
});

// ---------- Helpers for skills.ts integration ----------

/**
 * Pull the existing `notes.save_warnings_acked: [{kind, reason}]` array off
 * a strategy and convert it to the Audit's acks-map shape. Keeps the
 * on-disk shape unchanged — agents continue to write `notes.save_warnings_acked`
 * as a list of `{kind, reason}` tuples; the Audit consumes the same data
 * via its acks input.
 */
export function extractAcksFromNotes(data: Strategy): Record<string, string> {
  const out: Record<string, string> = {};
  const notes = (data as { notes?: Record<string, unknown> }).notes;
  if (!notes || typeof notes !== 'object') return out;
  const raw = notes.save_warnings_acked;
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.kind !== 'string' || typeof e.reason !== 'string') continue;
    out[e.kind] = e.reason;
  }
  return out;
}

/**
 * Persist the issues that fired (whether acked or not) onto the saved
 * strategy's `runtime_meta.save_warnings` array, so a later session reading
 * `list_platform_skills` / `get_strategy` sees what concerns the save acknowledged.
 */
export function persistWarningsOnRuntimeMeta(data: Strategy, warnings: Issue[]): void {
  if (warnings.length === 0) return;
  const meta = (data as { runtime_meta?: Record<string, unknown> }).runtime_meta ?? {};
  const existing = Array.isArray(meta.save_warnings) ? (meta.save_warnings as Issue[]) : [];
  meta.save_warnings = [...existing, ...warnings];
  (data as { runtime_meta?: Record<string, unknown> }).runtime_meta = meta;
}

export type { AuditResult };
