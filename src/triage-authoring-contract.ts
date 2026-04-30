// Triage authoring contract — the structured brief the agent reads on
// entry to TRIAGE so they can author submit_triage_plan correctly on the
// first attempt instead of cycling through the triage audit's detector
// rejections.
//
// Sibling of save-authoring-contract.ts. Both follow the same pattern:
// a pure derivation from session state, surfaced once at the lifecycle
// transition (drive→triage here; triage→lift on the save side). The
// audit stays as the safety net for what the agent missed.
//
// Surfaced on:
//   - perform_action's response when `surface_changed` fires (drive→triage
//     transition).
//   - end_drive's response when phase moves to triage via
//     `end_drive_unresolved`.
//
// Each constraint maps 1:1 to a Detector on `triagePlanAudit`. The
// constraint surfaces what would fire — with the specific evidence
// already substituted from session state — so the agent's first
// submit_triage_plan call is shape-correct. New triage-time concerns
// land here as both a Detector entry and a constraint entry, kept in
// lockstep.

import type { Session } from './drivers/types/session';

export interface TriageAuthoringContract {
  /** The URLs the runtime captured this session, deduplicated by
   *  origin+path. Sample (top N) — the agent uses these as inputs when
   *  authoring `defense_surface.request_patterns`. */
  captured_urls_sample: string[];
  /** Distinct origins the runtime saw traffic on. The agent uses these
   *  for `defense_surface.observed_origins`. */
  distinct_origins: string[];
  /** Examples of valid `request_patterns` entries the audit accepts. */
  valid_request_pattern_examples: string[];
  /** Each constraint maps to a detector that would fire if violated.
   *  The audit stays as the safety net; the contract surfaces the rule
   *  upfront with the per-constraint evidence already substituted. */
  constraints: TriageConstraint[];
}

export type TriageConstraint =
  | {
      kind: 'url_token_extractable';
      rule: string;
      detector_kind: 'request_pattern_url_extractable';
    }
  | {
      kind: 'url_grounded_in_captures_or_origins';
      rule: string;
      detector_kind: 'request_pattern_url_observed';
    }
  | {
      kind: 'capability_must_be_declared';
      rule: string;
      detector_kind: 'capability_not_declared';
      /** Capabilities the session has declared. The agent's
       *  `submit_triage_plan({capability})` arg must be one of these. */
      declared_capabilities: string[];
    }
  | {
      kind: 'tier_justification_must_cite_artifact';
      rule: string;
      detector_kind: 'tier_justification_unciteable';
      /** Sample of citeable artifacts the agent's `tier_justification`
       *  can quote: origin hosts, script URLs / filenames, cookie names,
       *  observed navigation URLs. The detector accepts any
       *  word-boundary case-insensitive match. */
      citeable_artifacts_sample: string[];
    }
  | {
      kind: 'slug_must_not_bake_query_value';
      rule: string;
      detector_kind: 'enum_value_baked_into_slug';
      /** Per-declared-capability would-fire collisions: for each declared
       *  slug, the captured URLs whose query-param values overlap with a
       *  slug token. Empty when no overlap exists. The detector is
       *  ackable (Level-2) — the agent should re-declare under a clean
       *  slug OR ack with a written reason if the overlap is incidental
       *  (e.g. canonical noun for the entity, not a parameter value). */
      would_fire_for: ReadonlyArray<{
        capability: string;
        token: string;
        param_name: string;
        captured_url: string;
      }>;
    };

const SAMPLE_LIMIT = 8;
const CITEABLE_LIMIT = 12;

type ContractSession = Pick<Session, 'intercepted' | 'declaredCapabilities' | 'domNavigations'>;

function deriveCapturedUrlSample(session: ContractSession): {
  sample: string[];
  origins: string[];
} {
  const seenKeys = new Set<string>();
  const sample: string[] = [];
  const originSet = new Set<string>();
  for (const req of session.intercepted) {
    if (typeof req.url !== 'string' || req.url.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      continue;
    }
    const origin = `${parsed.protocol}//${parsed.host.toLowerCase()}`;
    originSet.add(origin);
    let pathname = parsed.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    const key = `${origin}${pathname}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (sample.length < SAMPLE_LIMIT) sample.push(req.url);
  }
  return { sample, origins: [...originSet] };
}

function deriveCiteableArtifactsSample(session: ContractSession): string[] {
  const out = new Set<string>();
  for (const req of session.intercepted) {
    if (typeof req.url !== 'string' || req.url.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      continue;
    }
    out.add(parsed.host.toLowerCase());
    const ct = (req as { contentType?: string }).contentType ?? '';
    if (/javascript|ecmascript/i.test(ct) || /\.m?js(\?|$)/.test(parsed.pathname)) {
      const filename = parsed.pathname.split('/').filter(Boolean).pop();
      if (filename) out.add(filename);
    }
    const setCookieNames = (req as { setCookieNames?: unknown }).setCookieNames;
    if (Array.isArray(setCookieNames)) {
      for (const name of setCookieNames) if (typeof name === 'string') out.add(name);
    }
    if (out.size >= CITEABLE_LIMIT) break;
  }
  if (out.size < CITEABLE_LIMIT) {
    for (const nav of session.domNavigations ?? []) {
      if (typeof nav.url === 'string' && nav.url.length > 0) {
        out.add(nav.url);
        if (out.size >= CITEABLE_LIMIT) break;
      }
    }
  }
  return [...out].slice(0, CITEABLE_LIMIT);
}

/** Pre-compute per-declared-capability slug-collision candidates by
 *  walking captured URLs' query params. Same logic as the
 *  `enum_value_baked_into_slug` Detector but evaluated over captured URLs
 *  (instead of agent-declared request_patterns) — at contract-build time
 *  the agent hasn't declared request_patterns yet. The collisions surface
 *  what WILL fire once the agent writes request_patterns covering the
 *  same URLs. */
function deriveSlugCollisions(session: ContractSession): ReadonlyArray<{
  capability: string;
  token: string;
  param_name: string;
  captured_url: string;
}> {
  const declared = session.declaredCapabilities;
  if (!declared || declared.length === 0) return [];
  const out: Array<{
    capability: string;
    token: string;
    param_name: string;
    captured_url: string;
  }> = [];
  for (const cap of declared) {
    const slugTokens = new Set(
      cap.capability
        .toLowerCase()
        .split(/[_\-/]/)
        .filter((t) => t.length > 0),
    );
    for (const req of session.intercepted) {
      if (typeof req.url !== 'string' || req.url.length === 0) continue;
      let parsed: URL;
      try {
        parsed = new URL(req.url);
      } catch {
        continue;
      }
      for (const [paramName, value] of parsed.searchParams) {
        if (typeof value !== 'string' || value.length === 0) continue;
        if (slugTokens.has(value.toLowerCase())) {
          out.push({
            capability: cap.capability,
            token: value,
            param_name: paramName,
            captured_url: req.url,
          });
        }
      }
    }
  }
  return out;
}

/** Compose the contract from session state. Pure: doesn't mutate
 *  session. Surfaces structural rules the agent must satisfy when
 *  authoring `submit_triage_plan` — every rule maps 1:1 to a Detector
 *  on `triagePlanAudit`. */
export function composeTriageAuthoringContract(session: ContractSession): TriageAuthoringContract {
  const { sample, origins } = deriveCapturedUrlSample(session);
  const declared = (session.declaredCapabilities ?? []).map((c) => c.capability);
  const citeableSample = deriveCiteableArtifactsSample(session);
  const slugCollisions = deriveSlugCollisions(session);

  return {
    captured_urls_sample: sample,
    distinct_origins: origins,
    valid_request_pattern_examples: [
      'POST /api/send',
      'GET /api/categories',
      'GET https://api.example.com/v1/list',
    ],
    constraints: [
      {
        kind: 'url_token_extractable',
        rule: 'Each request_patterns entry must contain an extractable URL or absolute-path token. Use "<METHOD> <URL>" or just "<URL>". Describe headers / body shape in mechanism_hypothesis, not in the pattern entry.',
        detector_kind: 'request_pattern_url_extractable',
      },
      {
        kind: 'url_grounded_in_captures_or_origins',
        rule: 'Each URL must either match a captured URL this session OR sit on an observed_origins entry. Hallucinated paths the runtime never observed are rejected.',
        detector_kind: 'request_pattern_url_observed',
      },
      {
        kind: 'capability_must_be_declared',
        rule: 'The capability slug passed to submit_triage_plan must be declared on this session via start_session or declare_capability. The runtime will not accept a plan for an undeclared capability.',
        detector_kind: 'capability_not_declared',
        declared_capabilities: declared,
      },
      {
        kind: 'tier_justification_must_cite_artifact',
        rule: 'tier_justification must reference at least one verbatim artifact from the captured traffic — origin host, script URL or filename, cookie name, observed navigation URL, or a declared observed_origins entry. Generic prose without a citation does not pass. Word-boundary case-insensitive match.',
        detector_kind: 'tier_justification_unciteable',
        citeable_artifacts_sample: citeableSample,
      },
      {
        kind: 'slug_must_not_bake_query_value',
        rule: 'The capability slug must not contain a token that appears as a query-param value in the declared request_patterns — that bakes a parameter value into the capability identity. Ackable (Level-2): if the overlap is incidental (e.g. the token is the canonical noun for the entity, not a value the user picks), supply acks: {enum_value_baked_into_slug: "<one-sentence reason>"}.',
        detector_kind: 'enum_value_baked_into_slug',
        would_fire_for: slugCollisions,
      },
    ],
  };
}
