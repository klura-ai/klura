// Save-strategy audit: the `Audit` instance that runs on `save_strategy`.
// Composes save-warning detectors + token-gated classifiers under one
// rejection envelope. See runtime/src/audit/index.ts for the Audit class.

import { Audit, type Detector, type ShapeCheck, type Issue, type AuditResult } from '../index';
import type { Strategy } from '../../strategies/skills';
import {
  loadStrategies as loadStrategiesForPlatformAndCapability,
  listPlatformSkills as listAllSkills,
} from '../../strategies/skills';
import {
  validateStrategyShape,
  validateNoSynthesizedAuthHeaders,
  validatePlaceholderReferences,
  validateNoOpaqueUserParams,
  validateCapabilityPrereqs,
  validateNoSelectorSelfReference,
} from '../../strategies/validate';
import type { Session } from '../../drivers/types/session';
import {
  findMissingCapturedQueryParams,
  findUnobservedStrategyUrls,
  firstObservableUrl,
} from '../../strategies/verify-observed';
import { loadLogbook } from '../../working-dir/logbook';
import { lookupSurface, urlKey } from '../../phases/surface-binding';
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
  detectUnreferencedPrereqBinding,
  detectCapabilitySourceMissingPrereq,
  detectLookupSiblingNotReferenced,
  type SaveWarning,
} from '../../gate/save-warnings';
import { detectSensitiveActionShape } from '../../gate/save-warnings-sensitive-shape';
import {
  validateLookupPrereqsAreCapabilities,
  type ObservedSiblingItem,
} from '../../gate/save-audit';
import {
  literalProvenanceClassifier,
  capabilityNameJustificationClassifier,
  observedSiblingsClassifier,
  userConfirmationClassifier,
} from './save-strategy-classifiers';
import {
  parameterizationDisclosureClassifier,
  mutatingVerificationClassifier,
  observedPropertyKeysClassifier,
  observedLiteralValuesClassifier,
} from './save-strategy-warning-classifiers';
import type { ParamObservation } from '../../response/session-observations';

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

// Catches js-eval prereqs whose declared `binds` name is never referenced
// elsewhere on the strategy. The shape silently corrupts warm execute:
// the prereq does real work (often firing the actual fetch + parse
// internally) but the runtime ignores the return value and fires the
// dead-shaped HTTP envelope on top, so the caller receives whatever the
// envelope returns instead of the prereq's parsed payload. ackable when
// the binding is a deliberate side-effect-only refresh.
const unreferencedPrereqBindingDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'unreferenced_prereq_binding',
  detect: (data) => asIssues(detectUnreferencedPrereqBinding(data)),
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

// notes.params.<X>.source: "capability:Y" must be paired with a
// prerequisites[].kind:"capability" entry targeting Y. Without the prereq
// the source declaration is cosmetic and the listing never fetches at
// warm-execute time. ackReason: 'none' — the declaration is either
// load-bearing (needs the prereq) or it's not (drop the source).
const capabilitySourcePrereqMismatchDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'capability_source_missing_prereq',
  detect: (data) => asIssues(detectCapabilitySourceMissingPrereq(data)),
  ackReason: 'none',
};

// Slug has _by_X / _for_X / lookup_X segments + a saved sibling on the
// platform looks lookup-shaped + this strategy has no capability prereq.
// The agent saved the lookup separately but forgot to wire it; at
// warm-execute the placeholder it would resolve stays unbound. Sibling
// detector to `lookupEmbeddedInPrereqDetector` (which catches the inverse
// shape: agent inlined the lookup as fetch-extract). ackReason:
// 'required' — legitimate ack path is "caller does lookup externally."
const lookupSiblingNotReferencedDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'lookup_sibling_not_referenced',
  detect: (data, ctx) => {
    const platform = ctx.session?.platform;
    const skill = platform ? listAllSkills().find((s) => s.platform === platform) : undefined;
    const namesForPlatform = skill ? skill.capabilities.map((c) => c.name) : [];
    return asIssues(
      detectLookupSiblingNotReferenced(
        data,
        ctx.capability,
        platform ? () => namesForPlatform : undefined,
      ),
    );
  },
  ackReason: 'required',
};

// Refuses save when strategy body or notes.params surface sensitive-shape
// field names (card_number, cvv, ssn, bank_account, password in body,
// etc.). The right tool for capturing those endpoints is
// `record_observed_capability` — save_strategy persists a runnable
// strategy the runtime fires on every warm execute, which for payment /
// identity / credential surfaces means firing the real action.
//
// `ackReason: 'none'` — the registered save-confirmation decider auto-
// resolves the user_confirmation Classifier, not Detectors. Bench
// harnesses that auto-approve safe saves still get that behavior; saves
// targeting irreversible / PII-bearing endpoints stay refused at the
// audit layer, before commit. Repro: v8 platform-map/map-lift-safe —
// agent saved `place_order` with body {address, card_number, exp, cvv}.
const sensitiveActionShapeDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'sensitive_action_must_be_recorded_not_saved',
  detect: (data) => asIssues(detectSensitiveActionShape(data)),
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
  // Ackable: multiplexed gateways (GraphQL, JSON-RPC, generic /api/v1/)
  // legitimately route many ops through one (path, query, method) tuple
  // and discriminate on body fields the canonical key can't see. The agent
  // articulates the structural diff in the ack reason; validateAck below
  // catches the lowest-effort canned replies. Two saves of the SAME op
  // under different slugs (the parallel-capability-bake anti-pattern) still
  // get the rejection — they just have to articulate why they think it's
  // different, and a reviewer reading the saved file sees the reason.
  ackReason: 'required',
  validateAck: (reason): string[] => {
    const trimmed = reason.trim();
    if (trimmed.length < 30) {
      return [
        `endpoint_collides_with_saved_capability ack reason must name the structural diff in ≥30 chars ` +
          `(body field, operationName, response shape, auth surface). Got ${trimmed.length} chars: "${trimmed.slice(0, 60)}".`,
      ];
    }
    return [];
  },
};

// `mutating_verification_required` and `parameterization_disclosure_required`
// are token-bound Classifiers in `save-strategy-warning-classifiers.ts`. They
// promote what would otherwise be Detector{ackReason:'required',validateAck}
// pairs to Level-3 (gates.md taxonomy) — anti-canned substring matching alone
// is bypassable when the agent's canned reason happens to overlap a candidate
// anchor; token binding closes that bypass.

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

// Query-param completeness: every query param that appeared in the captured
// request must appear in the saved strategy template too, either templated
// as {{X}} or hardcoded with static provenance. The "captured but dropped"
// shape is the canonical save-quality regression behind HTTP 4xx at warm
// time — Stack Exchange requires `site=stackoverflow` on every call, and a
// strategy that dropped it returns HTTP 400. ackReason: 'required' — agents
// can ack tracking-only params (`utm_*`, `gclid`, etc.) or server-tolerated
// optional params with a one-sentence justification.
const urlParamCompletenessDetector: Detector<Strategy, SaveStrategyCtx> = {
  kind: 'captured_query_param_missing_from_strategy',
  detect: (data, ctx) => {
    if (ctx.observedUrls === undefined) return [];
    const missing = findMissingCapturedQueryParams(
      data as unknown as Record<string, unknown>,
      ctx.observedUrls,
    );
    return missing.map((m) => ({
      kind: 'captured_query_param_missing_from_strategy',
      message:
        `The captured request URL included \`?${m.param}=${m.observed_value}\` but the saved ` +
        `strategy endpoint doesn't reference \`${m.param}\` anywhere. Saved strategies that drop a ` +
        `captured query param commonly fail at warm-execute time with 4xx — the server received the ` +
        `param at discovery and may require it. Fix one of: ` +
        `(a) hardcode \`?${m.param}=${m.observed_value}\` in the endpoint when the value doesn't vary per caller; ` +
        `(b) template as \`?${m.param}={{${m.param}}}\` with \`notes.params.${m.param}\` declared when callers should supply it; ` +
        `(c) ack with a one-sentence reason why it's safe to drop (tracking-only, server-tolerated optional, etc).`,
      hint:
        `Observed URL: ${m.observed_url}\nSaved URL: ${m.strategy_url}\nAck shape if dropping legitimately: ` +
        `audit_answers: {captured_query_param_missing_from_strategy: {"${m.param}": "<one-sentence reason>"}}`,
      context: { param: m.param, observed_value: m.observed_value },
    }));
  },
  ackReason: 'required',
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

// `observed_property_keys` and `observed_literal_values` are token-bound
// Classifiers in `save-strategy-warning-classifiers.ts` for the same reason
// as the parameterization / mutating-verification migration above —
// anti-canned-ack substring matching alone is bypassable.

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
    unreferencedPrereqBindingDetector,
    recordedPathInlinesLookupDetector,
    ungroundedEnumPlaceholderDetector,
    enumParamListingUnfactoredDetector,
    capabilitySourcePrereqMismatchDetector,
    lookupSiblingNotReferencedDetector,
    sensitiveActionShapeDetector,
    enumValueInCapabilitySlugDetector,
    endpointCollidesWithSavedCapabilityDetector,
    unobservedUrlDetector,
    urlParamCompletenessDetector,
    lookupPrereqMustBeCapabilityDetector,
    popupAddressingWithoutTriggerDetector,
  ],
  classifiers: [
    parameterizationDisclosureClassifier,
    mutatingVerificationClassifier,
    observedPropertyKeysClassifier,
    observedLiteralValuesClassifier,
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
