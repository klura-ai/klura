// Audit instance for `submit_triage_plan`. Same shape as the save-strategy
// audit: composable detectors, structured rejection envelope. The agent
// reads one error format across both lifecycle gates.
//
// Detectors here cover (a) request_pattern URL ground-truthing, (b)
// capability declaration, (c) tier_justification citation, (d) slug-baked
// query values, and (e) recorded-path navigate-URL coverage. (a), (d) and
// (e) ground-check agent-emitted plan content; (b) and (c) are structural
// prerequisites of the triage flow itself.
//
// Severity:
//  - `request_pattern_url_extractable`, `request_pattern_url_observed`,
//    `capability_not_declared`, `tier_justification_unciteable`:
//    `ackReason: 'none'` — these are structural prereqs the agent must
//    fix, no exception path.
//  - `enum_value_baked_into_slug`, `recorded_path_navigate_url_unbound`:
//    `ackReason: 'required'` — legitimate ack-with-reason paths exist
//    (canonical noun-overlap; deliberately XHR-scoped surface).
//
// Shared primitives: `findObservedMatch`
// (`runtime/src/strategies/verify-observed.ts`) for URL-vs-captured-URL
// checks, and the concern modules under `runtime/src/audit/concerns/`
// (citeable-artifacts, slug-collision) whose facts also project into the
// triage authoring contract — parity locked by
// runtime/test/authoring-contract-parity.test.js.

import { Audit, type Detector, type Issue } from '../index';
import { AUDIT_KINDS, WARNING_KINDS, type StrategyTier } from '../../vocab';
import { escapeRegExp } from '../../utils/regex';
import type { Session } from '../../drivers/types/session';
import type { DefenseSurface } from '../../working-dir/schema';
import { findObservedMatch } from '../../strategies/verify-observed';
import { urlKey } from '../../phases/surface-binding';
import { collectCiteableArtifacts } from '../concerns/citeable-artifacts';
import { findSlugQueryValueCollisions } from '../concerns/slug-collision';

export interface TriagePlanPayload {
  surface_label: string;
  defense_surface: DefenseSurface;
  tier_justification: string;
  expected_tier: StrategyTier;
}

export interface TriagePlanCtx {
  session: Pick<
    Session,
    'intercepted' | 'id' | 'platform' | 'declaredCapabilities' | 'domNavigations'
  >;
  capability: string;
}

/** Pull the first URL or absolute-path token out of a `request_patterns`
 *  entry. Patterns are agent-emitted; documented shape is "<METHOD> <URL>"
 *  or just "<URL>" but the agent occasionally appends prose ("POST /api/x
 *  with JSON body ..."). Lenient extraction; returns null when no token
 *  matches, leaving the `request_pattern_url_extractable` detector to fire.
 *  Exported for reuse by the binding loop in `submit-triage-plan.ts`. */
export function extractUrlToken(pattern: string): string | null {
  const tokens = pattern.trim().split(/\s+/);
  for (const tok of tokens) {
    if (tok.startsWith('http://') || tok.startsWith('https://')) return tok;
    if (tok.startsWith('/')) return tok;
  }
  return null;
}

/** Resolve a relative path token against the first observed_origin so
 *  downstream URL parsing canonicalizes it. Absolute URLs pass through
 *  untouched. Returns null when a relative path can't be resolved
 *  (no observed_origins entries). */
export function resolveAgainstOrigin(
  token: string,
  observedOrigins: readonly string[],
): string | null {
  if (token.startsWith('http://') || token.startsWith('https://')) return token;
  if (!token.startsWith('/')) return null;
  const origin = observedOrigins[0];
  if (!origin) return null;
  return origin.endsWith('/') ? origin.slice(0, -1) + token : origin + token;
}

function originOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Detector 1: each `request_patterns` entry must contain an extractable
 *  URL or absolute-path token. Catches prose-only entries ("send the data
 *  with JSON body...") that would otherwise silently fail downstream URL
 *  parsing and skip surface binding. */
const requestPatternUrlExtractable: Detector<TriagePlanPayload, TriagePlanCtx> = {
  kind: AUDIT_KINDS.requestPatternUrlExtractable,
  ackReason: 'none',
  detect: (payload) => {
    const issues: Issue[] = [];
    payload.defense_surface.request_patterns.forEach((pattern, i) => {
      if (extractUrlToken(pattern) === null) {
        issues.push({
          kind: AUDIT_KINDS.requestPatternUrlExtractable,
          message: `request_patterns[${i}] = ${JSON.stringify(pattern)}: no URL or absolute path token found.`,
          hint: `Use "<METHOD> <URL>" or just "<URL>". Examples: "POST /api/send", "GET https://api.example.com/v1/list". Describe headers / body shape in mechanism_hypothesis instead.`,
          context: { index: i, pattern },
        });
      }
    });
    return issues;
  },
};

/** Detector 2: each extracted URL token must either match a captured URL
 *  this session OR sit on an `observed_origins` entry (forward claim is OK
 *  for endpoints the agent expects but hasn't yet exercised). Catches
 *  hallucinated URLs (recalled from training data) by cross-checking
 *  against the runtime's actual capture log. Skips entries that already
 *  failed `request_pattern_url_extractable` to avoid duplicate noise. */
const requestPatternUrlObserved: Detector<TriagePlanPayload, TriagePlanCtx> = {
  kind: AUDIT_KINDS.requestPatternUrlObserved,
  ackReason: 'none',
  detect: (payload, ctx) => {
    const observedUrls = ctx.session.intercepted
      .map((r) => r.url)
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    const observedOriginSet = new Set<string>();
    for (const o of payload.defense_surface.observed_origins) {
      const origin = originOf(o);
      if (origin) observedOriginSet.add(origin);
    }
    const issues: Issue[] = [];
    payload.defense_surface.request_patterns.forEach((pattern, i) => {
      const token = extractUrlToken(pattern);
      if (token === null) return;
      const resolved = resolveAgainstOrigin(token, payload.defense_surface.observed_origins);
      if (resolved === null) {
        issues.push({
          kind: AUDIT_KINDS.requestPatternUrlObserved,
          message: `request_patterns[${i}] = ${JSON.stringify(pattern)}: relative path ${JSON.stringify(token)} could not be resolved (observed_origins is empty).`,
          hint: `Add the page origin to observed_origins, or use an absolute URL in the pattern.`,
          context: { index: i, pattern, token },
        });
        return;
      }
      const tokenOrigin = originOf(resolved);
      const onObservedOrigin = tokenOrigin !== null && observedOriginSet.has(tokenOrigin);
      const match = findObservedMatch(resolved, observedUrls);
      if (!onObservedOrigin && !match) {
        const captureSample = observedUrls.slice(0, 5);
        issues.push({
          kind: AUDIT_KINDS.requestPatternUrlObserved,
          message: `request_patterns[${i}] = ${JSON.stringify(pattern)}: URL ${JSON.stringify(resolved)} is neither on an observed_origin (${[...observedOriginSet].join(', ') || '<none>'}) nor matches a captured URL this session.`,
          hint: `Captured URLs (sample): ${captureSample.length > 0 ? captureSample.join(', ') : '<none>'}. Pick one that the runtime actually captured, or add the origin to observed_origins.`,
          context: { index: i, pattern, resolved },
        });
      }
    });
    return issues;
  },
};

/** Detector 3: capability slug must be in this session's declared
 *  capabilities. Hard structural prereq — the plan can't bind to a
 *  capability the session doesn't know about. */
const capabilityNotDeclared: Detector<TriagePlanPayload, TriagePlanCtx> = {
  kind: AUDIT_KINDS.capabilityNotDeclared,
  ackReason: 'none',
  detect: (_payload, ctx) => {
    const declared = (ctx.session.declaredCapabilities ?? []).map((c) => c.capability);
    if (declared.length === 0) return [];
    if (declared.includes(ctx.capability)) return [];
    return [
      {
        kind: AUDIT_KINDS.capabilityNotDeclared,
        message: `capability '${ctx.capability}' is not in this session's declared capabilities (${declared.join(', ')}).`,
        hint: `Declare it via start_session or declare_capability first, then re-submit the triage plan.`,
        context: { declared },
      },
    ];
  },
};

function citeableCandidatesPreview(set: Set<string>, max = 10): string {
  const items = [...set].slice(0, max);
  const more = set.size > max ? ` (+${set.size - max} more)` : '';
  return `${items.map((s) => JSON.stringify(s)).join(', ')}${more}`;
}

function justificationCitesArtifact(justification: string, artifacts: Set<string>): boolean {
  if (justification.trim().length === 0) return false;
  for (const artifact of artifacts) {
    const escaped = escapeRegExp(artifact);
    const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i');
    if (re.test(justification)) return true;
  }
  return false;
}

/** Detector 4: tier_justification must reference at least one verbatim
 *  artifact actually present in the session's captured traffic — an origin
 *  from `intercepted[].url`, a script URL, a cookie name from
 *  `setCookieNames`, or a URL from `domNavigations`. Empty justification
 *  or zero matches → reject with the candidate list. Artifact universe
 *  comes from the shared extractor (`audit/concerns/citeable-artifacts`),
 *  the same one the triage authoring contract samples from. */
const tierJustificationUnciteable: Detector<TriagePlanPayload, TriagePlanCtx> = {
  kind: AUDIT_KINDS.tierJustificationUnciteable,
  ackReason: 'none',
  detect: (payload, ctx) => {
    const artifacts = collectCiteableArtifacts(ctx.session, payload.defense_surface);
    if (justificationCitesArtifact(payload.tier_justification, artifacts)) return [];
    const preview = citeableCandidatesPreview(artifacts);
    const noun =
      artifacts.size === 0 ? 'no artifacts have been captured yet' : `must cite one of: ${preview}`;
    return [
      {
        kind: AUDIT_KINDS.tierJustificationUnciteable,
        message:
          `tier_justification must reference at least one verbatim artifact from the session — ` +
          `an origin / host, script URL or filename, cookie name, or observed navigation URL. ` +
          `Generic prose without a cited artifact does not pass. ${noun}.`,
        hint: `Quote a captured artifact verbatim in tier_justification (case-insensitive, word-boundary). See klura://reference#triage.`,
      },
    ];
  },
};

/** Slug-baking pre-check: a capability slug names what the capability does
 *  in the abstract (`find_top_restaurants`, not `find_top_italian_restaurants`).
 *  When the agent's slug contains a token that's also a query-param value
 *  in their declared `request_patterns`, the value is being baked into the
 *  capability's identity instead of treated as a parameter. Catches it at
 *  triage time so the agent can re-declare the capability before LIFT
 *  starts — the alternative is the save-time `enum_value_baked_into_slug`
 *  detector, which runs after the agent has already invested rounds.
 *
 *  Scope: only the agent's declared `request_patterns`. Walking the whole
 *  session capture (`intercepted[].url`) produced false positives when an
 *  unrelated capture happened to use the same token as a query value
 *  (e.g. `?context=issue` on a settings page colliding with
 *  `create_issue`).
 *
 *  Matching rides the shared slug-collision concern
 *  (`audit/concerns/slug-collision`) — the same tokenizer + query-value
 *  matcher the triage authoring contract projects into its would-fire
 *  hint. Returns the offending token / param / pattern, or `null` when
 *  the slug is clean. */
function detectSlugBakesQueryValue(
  capability: string,
  requestPatterns: readonly string[],
): { token: string; paramName: string; pattern: string } | null {
  for (const candidate of requestPatterns) {
    const trimmed = candidate.trim();
    const idx = trimmed.indexOf(' ');
    const urlStr = idx === -1 ? trimmed : trimmed.slice(idx + 1).trim();
    const hit = findSlugQueryValueCollisions(capability, [urlStr])[0];
    if (hit) return { token: hit.token, paramName: hit.param_name, pattern: candidate };
  }
  return null;
}

/** Detector 5: slug-baked query value (Level 2 ackable). Mirrors the save-
 *  time `enum_value_baked_into_slug` Detector kind so both gates share one
 *  error vocabulary. Legitimate noun-overlap (`create_issue` vs
 *  `?context=issue`) is the canonical ack-with-reason case. */
const enumValueBakedIntoSlug: Detector<TriagePlanPayload, TriagePlanCtx> = {
  kind: WARNING_KINDS.enumValueBakedIntoSlug,
  ackReason: 'required',
  detect: (payload, ctx) => {
    const hit = detectSlugBakesQueryValue(ctx.capability, payload.defense_surface.request_patterns);
    if (!hit) return [];
    return [
      {
        kind: WARNING_KINDS.enumValueBakedIntoSlug,
        message:
          `capability slug "${ctx.capability}" contains the token "${hit.token}", ` +
          `which is also a value of query param "${hit.paramName}" in your declared request_pattern ` +
          `"${hit.pattern}". The slug names what the capability does in the abstract — it must not bake ` +
          `one of its own parameter values. Saving this shape implies a parallel slug per value (e.g. ` +
          `one capability per category) when the right shape is a single capability that takes ` +
          `"${hit.paramName}" as a parameter with the values grounded in ` +
          `\`notes.params.${hit.paramName}.observed_values\`.`,
        hint:
          `Either re-declare the capability with a slug that doesn't contain "${hit.token}" via ` +
          `\`declare_capability({session_id, capability: "<clean slug>", args})\` and re-submit this triage plan, ` +
          `or ack the warning if the overlap is incidental (e.g. "${hit.token}" is the canonical noun for the ` +
          `capability's domain entity, not a parameter value the user picks).`,
        context: { token: hit.token, paramName: hit.paramName, pattern: hit.pattern },
      },
    ];
  },
};

/** Detector 6: when `expected_tier === "recorded-path"`, at least one
 *  request_pattern URL should match a captured `domNavigations` URL — the
 *  recorded-path strategy will save with a `navigate` step whose URL must
 *  bind to this surface at save time, and `request_patterns` is what the
 *  surface binding cross-references. Without a navigate URL in patterns,
 *  the agent will hit `surface_triage_missing` at save time. Catch it here
 *  so the agent fixes the plan once instead of round-tripping at save.
 *
 *  Ackable (Level-2): the agent may be deliberately scoping this triage to
 *  the XHR-side and planning to re-triage for the navigation surface, or
 *  the recorded-path will navigate to a URL not yet captured. Reason
 *  required. */
const recordedPathNavigateUrlUnbound: Detector<TriagePlanPayload, TriagePlanCtx> = {
  kind: AUDIT_KINDS.recordedPathNavigateUrlUnbound,
  ackReason: 'required',
  detect: (payload, ctx) => {
    if (payload.expected_tier !== 'recorded-path') return [];
    const navUrls = (ctx.session.domNavigations ?? [])
      .map((n) => n.url)
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (navUrls.length === 0) return [];
    const navKeys = new Set<string>();
    for (const u of navUrls) {
      const k = urlKey(u);
      if (k) navKeys.add(k);
    }
    if (navKeys.size === 0) return [];
    const patternKeys = new Set<string>();
    for (const pattern of payload.defense_surface.request_patterns) {
      const token = extractUrlToken(pattern);
      if (!token) continue;
      const resolved = resolveAgainstOrigin(token, payload.defense_surface.observed_origins);
      if (!resolved) continue;
      const k = urlKey(resolved);
      if (k) patternKeys.add(k);
    }
    for (const k of navKeys) {
      if (patternKeys.has(k)) return [];
    }
    const navKeysArr = [...navKeys];
    const sample = navKeysArr
      .slice(0, 5)
      .map((u) => JSON.stringify(u))
      .join(', ');
    const more = navKeysArr.length > 5 ? ` (+${navKeysArr.length - 5} more)` : '';
    const suggested = navKeysArr[0];
    return [
      {
        kind: AUDIT_KINDS.recordedPathNavigateUrlUnbound,
        message:
          `expected_tier="recorded-path" but request_patterns doesn't include any captured navigation URL. ` +
          `Recorded-path strategies anchor on the first navigate step's URL, which must match an entry in this ` +
          `surface's request_patterns or save_strategy will reject with surface_triage_missing. ` +
          `Captured navigations this session: ${sample}${more}.`,
        hint:
          `Add \`GET ${suggested}\` to defense_surface.request_patterns and re-submit, ` +
          `or ack with reason if this surface triages only the XHR side and the recorded-path will land on a different (re-triaged) surface.`,
        context: { captured_nav_urls: navKeysArr, request_pattern_urls: [...patternKeys] },
      },
    ];
  },
};

export const triagePlanAudit = new Audit<TriagePlanPayload, TriagePlanCtx>({
  kind: 'submit_triage_plan',
  detectors: [
    requestPatternUrlExtractable,
    requestPatternUrlObserved,
    capabilityNotDeclared,
    tierJustificationUnciteable,
    enumValueBakedIntoSlug,
    recordedPathNavigateUrlUnbound,
  ],
  classifiers: [],
});
