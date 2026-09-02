// Save authoring contract — the structured brief the agent reads at LIFT
// entry so they can author save_strategy correctly on the first attempt
// instead of cycling through audit rejections.
//
// Composed structurally from session state. Every constraint's
// `detector_kind` names a concern on the save-strategy audit — a Detector
// on `saveStrategyAudit` (audit/lift/save-strategy.ts) or a token-gated
// Classifier (audit/lift/save-strategy-classifiers.ts, e.g.
// `literal_provenance`) — and the contract surfaces *what would fire*
// before the agent commits a shape. The audit stays as the safety net for
// what the agent missed. Concerns whose facts both sides need (tier rank,
// triage verdict, slug collision) live as shared extractors under
// `runtime/src/audit/concerns/`; the projection parity is enforced by
// runtime/test/authoring-contract-parity.test.js.
//
// The contract is computed once when the agent transitions from triage
// to lift (`submit_triage_plan`) or directly from drive to close
// (`end_drive`), cached on `session.saveAuthoringContract`, and echoed on
// the submit_triage_plan response + the end_drive triage handoff.

import type { Session } from '../../drivers/types/session';
import type { InterceptedRequest } from '../../drivers/types/network';
import {
  collectDataLoadCandidates,
  collectListingCandidates,
  type DataLoadCandidate,
  type ListingCandidate,
} from '../../strategies/synthesize-on-close';
import { getAllParamObservations } from '../../response/session-observations';
import { observedValuesAreIntegerRange } from '../../gate/observation-shape';
import { AUTH_GATE_MUTATING_METHODS } from '../../gate/save-warnings-collision';
import * as skills from '../../strategies/skills';
import { AUDIT_KINDS, WARNING_KINDS } from '../../vocab';
import { tierRank } from '../../audit/concerns/tier-rank';
import { findFirstTriageVerdict, findTriageVerdict } from '../../audit/concerns/triage-verdict';
import { lookupSurface } from '../surface-binding';

export { tierRank };

export interface SaveAuthoringContract {
  capability: string;
  declared_args: Record<string, unknown>;
  /** Inferred from session capture: page-script when any captured request
   *  carried a Cookie header (warm replay needs a live page); fetch
   *  otherwise. The agent can override based on RE findings (signed
   *  bodies → page-script even without cookies, etc.). */
  inferred_tier: 'fetch' | 'page-script';

  /** Structural patterns the runtime detected in session captures.
   *  These are the same shapes that feed individual detectors at save
   *  time — surfaced here so the agent sees them before authoring. */
  detected_patterns: {
    /** Captured XHRs ranked as data-load candidates. The agent picks one
     *  as the strategy's primary request. Same shape `end_drive`
     *  surfaces in the LIFT handoff. */
    data_loads: DataLoadCandidate[];
    /** Captures whose response enumerates values used as URL-param
     *  values on the data_loads. Each must be saved as its own
     *  `list_<entity>` capability and linked via
     *  `notes.params.<X>.source: "capability:list_<entity>"`. */
    listings: ListingCandidate[];
    /** Auth-gating signals — origins that set session-shape cookies in
     *  this session. Triggers the auth-prereq constraint when any saved
     *  capability targets these origins. */
    auth_gated: {
      cookie_setter_origins: string[];
      saved_auth_capabilities: string[];
    };
  };

  /** Each constraint corresponds to a detector that would fire if
   *  violated, with the specific session evidence already substituted. */
  constraints: SaveConstraint[];

  /** Number of sibling capabilities that must exist on disk before this
   *  capability's `notes.params.<X>.source: "capability:..."` resolves at
   *  execute time. Save those siblings first; this capability second.
   *  Names are not prescribed — the agent chooses slugs. */
  required_siblings: number;
}

export type SaveConstraint =
  | {
      kind: 'slug_no_arg_value';
      rule: string;
      reject_tokens: string[];
      arg_names: string[];
      detector_kind: typeof WARNING_KINDS.enumValueBakedIntoSlug;
    }
  | {
      kind: 'enum_param_grounded';
      rule: string;
      param: string;
      url_param_in_data_load: string;
      observed_value_count: number;
      observed_via: 'ui_click' | 'url_variance' | 'mixed';
      listing_capture_index?: number;
      /** Captured (label, value) pairs from UI-click observations on this
       *  param. When the agent declares notes.params.<placeholder>.kind:
       *  "enum" with observed_values, they can paste these directly —
       *  pre-grounded by the runtime's click→XHR correlator so the save-
       *  time `ungrounded_enum_placeholder` audit accepts them without a
       *  rejection round-trip. Empty when observations are url_variance
       *  only (no UI labels). */
      ui_label_examples?: ReadonlyArray<{ label: string; value: string }>;
      detector_kind: typeof WARNING_KINDS.ungroundedEnumPlaceholder;
    }
  | {
      kind: 'listing_must_be_saved_separately';
      rule: string;
      listing_url: string;
      enumerated_value_count: number;
      url_param_consumed_in: string;
      link_via_shape: string;
      detector_kind: typeof WARNING_KINDS.enumParamListingUnfactored;
    }
  | {
      kind: 'required_query_params_in_template';
      rule: string;
      /** The captured data-load URL these params live on (index into
       *  detected_patterns.data_loads). Multiple captured query params on
       *  the same URL collapse into one constraint with a list. */
      data_load_index: number;
      data_load_url: string;
      params: ReadonlyArray<{ name: string; observed_value: string }>;
      detector_kind: typeof AUDIT_KINDS.capturedQueryParamMissingFromStrategy;
    }
  | {
      kind: 'auth_gated_chain_auth_prereq';
      rule: string;
      cookie_setter_origins: string[];
      auth_capability_slug: string;
      detector_kind: typeof AUDIT_KINDS.authGatedWithoutAuthPrereq;
    }
  | {
      kind: 'literal_provenance_default_suspicious';
      rule: string;
      auto_classifiable: Array<{ path: string; classification: string }>;
      detector_kind: typeof AUDIT_KINDS.literalProvenance;
    }
  | {
      kind: 'tier_floor_from_triage';
      rule: string;
      verdict_tier: 'fetch' | 'page-script' | 'recorded-path';
      surface_label: string;
      detector_kind: typeof AUDIT_KINDS.tierBelowTriageVerdict;
    }
  | {
      kind: 'surface_already_bound';
      rule: string;
      surface_label: string;
      detector_kind: typeof AUDIT_KINDS.surfaceTriageMissing;
    };

/**
 * Compose the contract from session state. Pure: doesn't mutate session.
 * Caller is responsible for caching the result on `session.saveAuthoringContract`.
 */
export function composeSaveAuthoringContract(
  session: Session,
  capability: string,
  args: Record<string, unknown>,
  platform: string,
): SaveAuthoringContract {
  const intercepted = session.intercepted;
  const observedParamValues = getAllParamObservations(session.id);
  const dataLoads = collectDataLoadCandidates(session, capability, intercepted, 5);
  const listings = collectListingCandidates(intercepted, observedParamValues, 5);

  // Auth-gated detection: any capture whose Set-Cookie header set a
  // session-shape cookie name (consumed by save-warnings'
  // detectAuthGatedWithoutAuthPrereq). Surface origins so the agent can
  // tell whether their save will trip the auth-prereq detector.
  const cookieSetterOrigins = collectCookieSetterOrigins(intercepted);
  const savedAuthCaps = collectSavedAuthCapabilities(platform);

  const inferredTier = inferTier(intercepted);
  const constraints: SaveConstraint[] = [];

  // 1. Slug-no-arg-value: agent's `args` must not be tokenized in the slug.
  // The declared arg VALUES are the compose-time proxy for what the save-
  // time detector checks (`notes.params.*.observed_values` — which don't
  // exist yet); the rule text states the prediction explicitly.
  const slugTokenRejects = collectArgValuesAsRejectTokens(args);
  if (slugTokenRejects.tokens.length > 0) {
    constraints.push({
      kind: 'slug_no_arg_value',
      rule: 'Capability slug must not contain any value the user passed via args. Slug names what the capability does in the abstract; values are parameters. The save-time detector fires when a slug token matches an observed_values entry under notes.params — your declared arg values are the values most likely to end up observed, so a slug containing one predicts that rejection.',
      reject_tokens: slugTokenRejects.tokens,
      arg_names: slugTokenRejects.argNames,
      detector_kind: WARNING_KINDS.enumValueBakedIntoSlug,
    });
  }

  // 2. Surface-already-bound (informational): if the data load's URL is
  // already bound to a triaged surface, the agent doesn't need to
  // re-triage. Resolution rides the same `lookupSurface` the
  // surface_triage_missing detector uses — templated `{id}` pattern keys
  // unify here exactly as they will at save time.
  const primaryUrl = dataLoads[0]?.url;
  const boundSurface = primaryUrl ? lookupSurface(session, primaryUrl) : undefined;
  if (boundSurface) {
    constraints.push({
      kind: 'surface_already_bound',
      rule: `The primary data load's URL is already bound to surface "${boundSurface}" by a prior triage plan. Save uses this surface; no re-triage needed.`,
      surface_label: boundSurface,
      detector_kind: AUDIT_KINDS.surfaceTriageMissing,
    });
  }

  // 3. Tier-floor: if the agent's own triage_plan declared `expected_tier`,
  // saves below that tier trip `tier_below_triage_verdict`. Resolve the
  // verdict for the surface the primary data load is bound to (the same
  // surface the detector will resolve at save time); fall back to the
  // first planned surface only when the URL is unbound.
  const tierVerdict = boundSurface
    ? findTriageVerdict(platform, capability, boundSurface)
    : findFirstTriageVerdict(platform, capability);
  if (tierVerdict) {
    constraints.push({
      kind: 'tier_floor_from_triage',
      rule: `Your triage plan for surface "${tierVerdict.surface}" declared expected_tier="${tierVerdict.tier}". Saving a strictly worse tier trips the tier_below_triage_verdict detector — it's not ack-bypassable. If reality contradicts the verdict, re-submit triage with a revised expected_tier first.`,
      verdict_tier: tierVerdict.tier,
      surface_label: tierVerdict.surface,
      detector_kind: AUDIT_KINDS.tierBelowTriageVerdict,
    });
  }

  // 4. Enum-param-grounded: every URL-param on the primary data load that
  // the agent would template needs `notes.params.<placeholder>` declared
  // as kind:"enum" with grounded observed_values OR
  // source:"capability:<listing-slug>". Match by URL param name (the
  // ungrounded_enum_placeholder detector resolves placeholder→urlParam).
  const enumConstraints = composeEnumParamConstraints(
    dataLoads,
    listings,
    observedParamValues,
    intercepted,
  );
  for (const c of enumConstraints) constraints.push(c);

  // 5. Listing-must-be-saved-separately: every detected listing has to
  // become its own `list_<entity>` capability. The detector
  // `enum_param_listing_unfactored` is `ackReason: 'none'` so this is a
  // hard requirement. The contract surfaces structural facts (URL, param
  // name, count) but NOT the values themselves or a suggested slug — the
  // agent does the naming + picks the slug from observation.
  for (const listing of listings) {
    constraints.push({
      kind: 'listing_must_be_saved_separately',
      rule: `Captured ${listing.url} enumerates ${listing.enumerated_values.length} value(s) used as ?${listing.used_as.url_param}=... in the data-load capture. Save it as its own list_<entity> capability before the data-load capability; the data-load's notes.params.<placeholder>.source must reference whatever slug you choose for the listing.`,
      listing_url: listing.url,
      enumerated_value_count: listing.enumerated_values.length,
      url_param_consumed_in: listing.used_as.url_param,
      link_via_shape: `notes.params.<placeholder>.source = "capability:<your-listing-slug>"`,
      detector_kind: WARNING_KINDS.enumParamListingUnfactored,
    });
  }

  // 5c. Required-query-params-in-template: every query param on the primary
  // data-load URL must appear in the saved fetch / page-script template,
  // either templated as {{X}} or hardcoded with static provenance. Dropping
  // a captured param commonly returns 4xx at warm-execute (the server
  // received it at discovery and may require it — e.g. a required
  // `site=<value>` scope param on a search endpoint). Audit is
  // `captured_query_param_missing_from_strategy` (ackReason: 'required'
  // for tracking-only / server-tolerated optionals).
  for (let i = 0; i < dataLoads.length; i += 1) {
    const dl = dataLoads[i];
    if (!dl) continue;
    let parsed: URL;
    try {
      parsed = new URL(dl.url);
    } catch {
      continue;
    }
    const params: Array<{ name: string; observed_value: string }> = [];
    const seenNames = new Set<string>();
    for (const [name, value] of parsed.searchParams) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      params.push({ name, observed_value: value });
    }
    if (params.length === 0) continue;
    constraints.push({
      kind: 'required_query_params_in_template',
      rule: `Captured data-load #${i} (${dl.url}) has ${params.length} query param(s). Every one MUST appear in the saved template — either templated as ?<name>={{<placeholder>}} with notes.params.<placeholder> declared, or hardcoded with literal_provenance:"static". Tracking-only / server-tolerated optionals can be ack'd with a one-sentence justification; the audit demands the agent decide explicitly per param instead of silently dropping.`,
      data_load_index: i,
      data_load_url: dl.url,
      params,
      detector_kind: AUDIT_KINDS.capturedQueryParamMissingFromStrategy,
    });
  }

  // 6. Auth-gated chain: if cookies are set on a saved capability's
  // origin AND there's a saved capability advertising `provides:["auth"]`
  // (or with the canonical `login` slug per legacy), the data-load save
  // must declare an auth prereq. The rule states the detector's actual
  // scope (mutating fetch/page-script saves on a cookie-setter origin) so
  // the prediction matches what fires.
  const firstAuthCap = savedAuthCaps[0];
  if (cookieSetterOrigins.length > 0 && firstAuthCap !== undefined) {
    const mutatingScope = [...AUTH_GATE_MUTATING_METHODS].join('/');
    constraints.push({
      kind: 'auth_gated_chain_auth_prereq',
      rule:
        `Captures set session cookies on ${cookieSetterOrigins.join(', ')}, and platform has saved auth capability "${firstAuthCap}". ` +
        `A mutating (${mutatingScope}) fetch / page-script save targeting one of these origins must declare a prerequisite chained to it ` +
        `(the runtime auto-injects when missing, but declaring upfront avoids the rejection cycle). ` +
        `Reads (GET) and recorded-path saves don't trip this detector — cookies auto-ride same-origin requests, so the signal is only load-bearing on mutations.`,
      cookie_setter_origins: cookieSetterOrigins,
      auth_capability_slug: firstAuthCap,
      detector_kind: AUDIT_KINDS.authGatedWithoutAuthPrereq,
    });
  }

  // 7. Literal-provenance default-suspicious: standing teaching, applies
  // to every save. Surfaced once in the contract so the agent reads the
  // policy upfront instead of discovering it via rejections. The concern
  // is a token-gated Classifier (audit/lift/save-strategy-classifiers.ts),
  // not a Detector — the agent answers it via audit_answers, not acks.
  constraints.push({
    kind: 'literal_provenance_default_suspicious',
    rule: 'Every literal in the strategy is classified at save time. DEFAULT SUSPICIOUS: only "static" for tokens that won\'t rotate across callers (API paths, query-param KEYS like ?foo=, hostnames, HTTP methods). Anything from observed traffic, anything you typed, any value that could rotate → caller_input or prereq_output.',
    auto_classifiable: [],
    detector_kind: AUDIT_KINDS.literalProvenance,
  });

  return {
    capability,
    declared_args: args,
    inferred_tier: inferredTier,
    detected_patterns: {
      data_loads: dataLoads,
      listings: listings.map(redactListingValues),
      auth_gated: {
        cookie_setter_origins: cookieSetterOrigins,
        saved_auth_capabilities: savedAuthCaps,
      },
    },
    constraints,
    required_siblings: listings.length,
  };
}

/** Strip the verbatim enumerated values from a listing candidate before
 *  surfacing in the contract. The fact that capture #N is a listing for
 *  URL-param X is a structural signal the agent has earned via their own
 *  drives + the click→XHR correlator; the values themselves are agent
 *  judgment territory and should come from get_network_log if needed.
 *  Surfacing the values verbatim in the contract over-coaches: the agent
 *  doesn't have to read the listing response, just copy the contract's
 *  enumeration. */
function redactListingValues(l: ListingCandidate): ListingCandidate {
  return {
    i: l.i,
    method: l.method,
    url: l.url,
    status: l.status,
    enumerated_values: [],
    used_as: l.used_as,
  };
}

export function inferTier(intercepted: ReadonlyArray<InterceptedRequest>): 'fetch' | 'page-script' {
  for (const req of intercepted) {
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'cookie' && typeof v === 'string' && v.length > 0) {
        return 'page-script';
      }
    }
  }
  return 'fetch';
}

function collectArgValuesAsRejectTokens(args: Record<string, unknown>): {
  tokens: string[];
  argNames: string[];
} {
  const tokens: string[] = [];
  const argNames: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const lc = value.toLowerCase();
    if (lc.length < 3) continue;
    if (!tokens.includes(lc)) tokens.push(lc);
    if (!argNames.includes(name)) argNames.push(name);
  }
  return { tokens, argNames };
}

function collectCookieSetterOrigins(intercepted: ReadonlyArray<InterceptedRequest>): string[] {
  const origins = new Set<string>();
  for (const req of intercepted) {
    const setCookies = (req as { setCookieNames?: unknown }).setCookieNames;
    if (!Array.isArray(setCookies) || setCookies.length === 0) continue;
    try {
      const u = new URL(req.url);
      origins.add(`${u.protocol}//${u.host}`);
    } catch {
      // skip malformed
    }
  }
  return [...origins];
}

function collectSavedAuthCapabilities(platform: string): string[] {
  const skill = skills.listPlatformSkills().find((s) => s.platform === platform);
  if (!skill) return [];
  const out: string[] = [];
  for (const cap of skill.capabilities) {
    const strategies = skills.loadStrategies(platform, cap.name);
    for (const strat of strategies) {
      const provides = (strat as { provides?: unknown }).provides;
      if (Array.isArray(provides) && provides.includes('auth')) {
        if (!out.includes(cap.name)) out.push(cap.name);
        break;
      }
    }
    if (cap.name === 'login' && !out.includes('login')) out.push('login');
  }
  return out;
}

function composeEnumParamConstraints(
  dataLoads: ReadonlyArray<DataLoadCandidate>,
  listings: ReadonlyArray<ListingCandidate>,
  observedParamValues: Record<string, unknown[]>,
  intercepted: ReadonlyArray<InterceptedRequest>,
): Array<Extract<SaveConstraint, { kind: 'enum_param_grounded' }>> {
  const out: Array<Extract<SaveConstraint, { kind: 'enum_param_grounded' }>> = [];
  const seen = new Set<string>();
  for (const dl of dataLoads) {
    let parsed: URL;
    try {
      parsed = new URL(dl.url);
    } catch {
      continue;
    }
    for (const [paramName] of parsed.searchParams) {
      if (seen.has(paramName)) continue;
      const obsList = observedParamValues[paramName] as
        | ReadonlyArray<{ value?: unknown; source?: { kind?: unknown; label?: unknown } }>
        | undefined;
      if (!obsList || obsList.length === 0) continue;
      const seenValues = new Set<string>();
      let clickCount = 0;
      let varianceCount = 0;
      // Collect (label, value) pairs from UI clicks so the agent can paste
      // them into `notes.params.<placeholder>.observed_values` directly.
      // Dedup by value (first label wins — multiple clicks on the same
      // tile shouldn't repeat).
      const labelPairs: Array<{ label: string; value: string }> = [];
      for (const o of obsList) {
        if (typeof o !== 'object') continue;
        const k = o.source?.kind;
        if (k !== 'ui_click' && k !== 'url_variance') continue;
        const v = o.value;
        if (typeof v !== 'string' || seenValues.has(v)) continue;
        seenValues.add(v);
        if (k === 'ui_click') {
          clickCount += 1;
          const label = typeof o.source?.label === 'string' ? o.source.label : '';
          if (label) labelPairs.push({ label, value: v });
        } else {
          varianceCount += 1;
        }
      }
      if (seenValues.size === 0) continue;
      // Range-shaped URL params (?limit=, ?offset=, ?page=) where every
      // observed value is a bare integer aren't structurally enum-grounding
      // candidates: callers pass arbitrary integers in the API's range, not
      // members of an enumerable set. Mirrors the same skip in
      // `detectUngroundedEnumPlaceholder` so the contract doesn't pre-coach
      // the agent into a shape the detector wouldn't enforce.
      if (observedValuesAreIntegerRange([...seenValues].map((v) => ({ value: v })))) {
        seen.add(paramName);
        continue;
      }
      seen.add(paramName);
      const matchingListing = listings.find((l) => l.used_as.url_param === paramName);
      let listingCaptureIndex: number | undefined;
      if (matchingListing) {
        for (let i = 0; i < intercepted.length; i += 1) {
          if (intercepted[i]?.url === matchingListing.url) {
            listingCaptureIndex = i;
            break;
          }
        }
      }
      const observedVia: 'ui_click' | 'url_variance' | 'mixed' = (() => {
        if (clickCount > 0 && varianceCount > 0) return 'mixed';
        if (clickCount > 0) return 'ui_click';
        return 'url_variance';
      })();
      out.push({
        kind: 'enum_param_grounded',
        rule: matchingListing
          ? `?${paramName}=... has ${seenValues.size} observed value(s) AND a listing capture (#${listingCaptureIndex}) enumerates them. Declare notes.params.<placeholder> = {kind: "enum", source: "capability:<your-listing-slug>"} after saving the listing capability — the runtime resolves source:capability:... at execute time, refreshing the value set on every warm execute.`
          : `?${paramName}=... has ${seenValues.size} observed value(s) but no listing capture was found. Declare notes.params.<placeholder> = {kind: "enum", observed_values: [{value, label}, ...]} grounded in the captured pairs.`,
        param: paramName,
        url_param_in_data_load: paramName,
        observed_value_count: seenValues.size,
        observed_via: observedVia,
        listing_capture_index: listingCaptureIndex,
        ui_label_examples: labelPairs.length > 0 ? labelPairs : undefined,
        detector_kind: WARNING_KINDS.ungroundedEnumPlaceholder,
      });
    }
  }
  return out;
}
