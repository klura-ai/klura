// Save-time advisory detectors + ack gate.
//
// Each detector returns `SaveWarning[]`; the ack validator reconciles the
// emitted kinds against `notes.save_warnings_acked` and either lets the save
// through (all acked) or bundles the unacked ones into one rejection message.
//
// Detectors are structural — no brand names, no site-specific regexes.
// Co-occurrence of session-state reads + id extraction, name-vs-id caller-arg
// gaps, and entity-pinned infra-prereq URLs are the three patterns surfaced
// here.
//
// Listed in the exceptions table in
// runtime/docs/principles.md#delegate-to-the-llm-but-allow-narrowly-scoped-runtime-heuristics.

import type { Strategy } from '../strategies/skills';
import {
  SESSION_STATE_READS,
  ID_EXTRACTION_SHAPES,
  ID_SHAPED_EXAMPLE_PATTERNS,
} from '../strategies/validate/constants';
import { collectDeclaredPlaceholders } from '../strategies/placeholder-semantics';
import { getDeclaredArgsProvider } from '../strategies/validate/providers';
import { observedValuesAreIntegerRange, valueLooksIdShaped } from './observation-shape';
import {
  canonicalizeEndpoint,
  detectEnumValueInCapabilitySlug,
  detectEndpointCollidesWithSavedCapability,
  detectAuthGatedWithoutAuthPrereq,
} from './save-warnings-collision';
import { detectPrereqBindKeyMismatch } from './save-warnings-bind-mismatch';
import {
  detectMutatingStrategyVerificationApproach,
  VERIFICATION_SHAPE_TAGS,
  CLAIMING_VERIFICATION_TAGS,
  FIRE_AND_FORGET_JUSTIFYING_NOUNS,
  NON_DOM_VERIFICATION_MARKERS,
} from './save-warnings-mutating-verification';
import {
  detectParameterizationDisclosureRequired,
  collectParameterizationAnchors,
} from './save-warnings-parameterization';
import { detectUnreferencedPrereqBinding } from './save-warnings-unreferenced-binding';
import { detectRequiredParamsWithoutExample } from './save-warnings-param-example';
import { detectLookupSiblingNotReferenced } from './save-warnings-lookup-sibling';
import { isLookupSurfaceOwnerCapability } from './save-audit-lookup';

export {
  detectEnumValueInCapabilitySlug,
  detectEndpointCollidesWithSavedCapability,
  detectAuthGatedWithoutAuthPrereq,
  detectPrereqBindKeyMismatch,
  detectMutatingStrategyVerificationApproach,
  detectParameterizationDisclosureRequired,
  collectParameterizationAnchors,
  detectUnreferencedPrereqBinding,
  detectRequiredParamsWithoutExample,
  detectLookupSiblingNotReferenced,
  VERIFICATION_SHAPE_TAGS,
  CLAIMING_VERIFICATION_TAGS,
  FIRE_AND_FORGET_JUSTIFYING_NOUNS,
  NON_DOM_VERIFICATION_MARKERS,
};

export interface SaveWarning {
  kind: string;
  message: string;
  hint?: string;
  /** Free-form per-detector context echoed verbatim through the audit
   *  rejection envelope. Used by detectors whose validateAck reads
   *  structural facts back (e.g. flagged keys, anchor type, valid paths). */
  context?: Record<string, unknown>;
}

/**
 * One executable-JS-string field pulled off a strategy. `location` is the
 * human-readable path used verbatim in warning messages (e.g.
 * `prerequisites[0].expression`, `script`, `frameFromPage.expression`); `text`
 * is the raw JS body to scan.
 */
export interface ExecutableJsString {
  location: string;
  text: string;
}

/**
 * Collect every executable-JS-string field on a strategy so detectors that
 * scan JS bodies can cover all surfaces at once: prereq expressions, the
 * inline `script` body on page-script tiers, a top-level `expression` field,
 * and `frameFromPage.expression`. Any new JS-body field on a strategy should
 * be registered here so the detectors below pick it up automatically.
 */
export function collectExecutableJsStrings(data: Strategy): ExecutableJsString[] {
  const out: ExecutableJsString[] = [];
  const obj = data as Record<string, unknown>;

  const prereqs = obj.prerequisites;
  if (Array.isArray(prereqs)) {
    prereqs.forEach((p, idx) => {
      if (!p || typeof p !== 'object') return;
      const expr = (p as Record<string, unknown>).expression;
      if (typeof expr === 'string' && expr.length > 0) {
        out.push({ location: `prerequisites[${idx}].expression`, text: expr });
      }
    });
  }

  const script = obj.script;
  if (typeof script === 'string' && script.length > 0) {
    out.push({ location: 'script', text: script });
  }

  const expression = obj.expression;
  if (typeof expression === 'string' && expression.length > 0) {
    out.push({ location: 'expression', text: expression });
  }

  const frameFromPage = obj.frameFromPage;
  if (frameFromPage && typeof frameFromPage === 'object') {
    const ffpExpr = (frameFromPage as Record<string, unknown>).expression;
    if (typeof ffpExpr === 'string' && ffpExpr.length > 0) {
      out.push({ location: 'frameFromPage.expression', text: ffpExpr });
    }
  }

  return out;
}

/**
 * Session-scoped-id extraction detector. Structural pattern: an expression body
 * (frameFromPage.expression, prerequisites[*].expression) pulls an identifier
 * out of whatever page state the session happens to be in —
 * `window.location.pathname` / `document.cookie` / `location.href` / etc. — and
 * uses it as a value that should have come from a caller arg or a
 * lookup-companion prereq.
 *
 * Expressions that also read `args.*` are skipped: the caller-supplied
 * binding is threaded into the same body, so the session-state read is a
 * fallback, not the value's sole provenance — free-form JavaScript
 * provenance beyond that is left to the authoring agent.
 *
 * This is NOT a reject: some legitimate uses (reading a rotating page- scoped
 * CSRF token out of document state, deriving a per-tab client id) share the
 * same mechanical shape. The agent is the intelligence; the runtime surfaces
 * the pattern as a `notes.save_warnings[]` entry so the NEXT session's agent
 * reads it via list_platform_skills / get_strategy and can add a proper lookup companion
 * or caller arg if the warning applies.
 */
export function detectSessionScopedIdExtraction(data: Strategy): SaveWarning[] {
  const warnings: SaveWarning[] = [];
  const obj = data as Record<string, unknown>;

  // Collect expression bodies to scan.
  const expressions: Array<{ path: string; body: string }> = [];
  const frameFromPage = obj.frameFromPage;
  if (frameFromPage && typeof frameFromPage === 'object') {
    const expr = (frameFromPage as Record<string, unknown>).expression;
    if (typeof expr === 'string')
      expressions.push({ path: 'frameFromPage.expression', body: expr });
  }
  const prereqs = obj.prerequisites;
  if (Array.isArray(prereqs)) {
    prereqs.forEach((p, idx) => {
      if (!p || typeof p !== 'object') return;
      const expr = (p as Record<string, unknown>).expression;
      if (typeof expr === 'string') {
        expressions.push({ path: `prerequisites[${idx}].expression`, body: expr });
      }
    });
  }
  if (expressions.length === 0) return warnings;

  // A capability- or tag-kind prereq means the agent already threaded a
  // lookup sibling — the runtime has no reason to warn about id extraction.
  const hasCapabilityPrereq =
    Array.isArray(prereqs) &&
    prereqs.some((p) => {
      if (!p || typeof p !== 'object') return false;
      const kind = (p as Record<string, unknown>).kind;
      return kind === 'capability' || kind === 'tag';
    });
  if (hasCapabilityPrereq) return warnings;

  for (const { path, body } of expressions) {
    // `args` is the runtime's caller-input binding inside expression bodies;
    // a body that reads it has a caller-supplied source in play.
    if (/\bargs\s*\./.test(body)) continue;
    const stateRead = SESSION_STATE_READS.find((s) => body.includes(s));
    if (!stateRead) continue;
    const extractShape = ID_EXTRACTION_SHAPES.find((shape) => body.includes(shape));
    if (!extractShape) continue;
    warnings.push({
      kind: 'unparametrized_session_id',
      message: `${path} reads ${stateRead} and extracts a value via ${extractShape.slice(0, -1)} — this works only for whatever page the session happens to be on. The strategy is not portable across recipients/entities.`,
      hint: `Declare the id as a caller arg (bind it via a {{placeholder}} fed from args) or add a {kind:"capability"} prereq pointing at a lookup sibling. See klura://reference#capability-prereq.`,
    });
  }
  return warnings;
}

// A caller-typed value that could itself be an id — skip mismatch detection
// when the caller clearly is handing over an id-shaped string (no gap to
// report).
/**
 * Name-vs-id gap detector. When the saved strategy declares a `notes.params.X`
 * whose `example` is id-shaped (numeric id, ObjectId, opaque token) but the
 * caller's declared args for the discovery session don't contain that param
 * name AND no `{kind: "capability"}` prereq binds to it, the strategy is
 * over-specialized: the next caller has no way to produce the id from what
 * they'd actually type. The fix is to save a lookup-sibling capability and
 * chain it via a capability prereq — the
 * `runtime/REFERENCE.md#capability-parameters` pattern.
 *
 * Emits `kind: "unresolved_name_to_id_gap"`. Advisory — the acked- warnings
 * gate in skills.ts decides whether to block the save.
 */
export function detectNameIdMismatch(data: Strategy, sessionId?: string): SaveWarning[] {
  const warnings: SaveWarning[] = [];
  const notes = (data as { notes?: { params?: Record<string, unknown> } }).notes;
  const params = notes?.params;
  if (!params || typeof params !== 'object') return warnings;

  const declaredArgsProviderFn = getDeclaredArgsProvider();
  const declaredArgs =
    sessionId && declaredArgsProviderFn ? declaredArgsProviderFn(sessionId) : null;
  if (!declaredArgs) return warnings;

  const declared = collectDeclaredPlaceholders(data);

  const argNames = new Set(Object.keys(declaredArgs));
  const argValues = Object.values(declaredArgs).filter((v): v is string => typeof v === 'string');
  // If the caller typed any value that is itself id-shaped, we can't tell
  // whether they meant it for this param — withdraw the warning rather than
  // false-positive against a caller who genuinely handed over an id.
  const callerAlreadyTypedAnId = argValues.some(valueLooksIdShaped);

  for (const [name, entry] of Object.entries(params)) {
    if (!entry || typeof entry !== 'object') continue;
    if (argNames.has(name)) continue;
    if (declared.prereqProducedNames.has(name)) continue;

    const example = (entry as Record<string, unknown>).example;
    if (typeof example !== 'string' || example.length === 0) continue;

    const shape = ID_SHAPED_EXAMPLE_PATTERNS.find(({ re }) => re.test(example));
    if (!shape) continue;
    if (callerAlreadyTypedAnId) continue;

    const argList = Array.from(argNames).join(', ') || '(none)';
    warnings.push({
      kind: 'unresolved_name_to_id_gap',
      message:
        `notes.params.${name}.example = ${JSON.stringify(example)} is ${shape.label}, ` +
        `but the caller's declared args [${argList}] contain no ${name} and no ` +
        `prereq binds to ${name}. Future callers typing a ` +
        `human-facing label have no way to produce this id.`,
      hint:
        `Save a lookup sibling capability (e.g. that resolves the caller-typed handle to ${name}) ` +
        `and chain it via a {kind:"capability", vars:{${JSON.stringify(name)}: "<dot.path>"}} prereq. See klura://reference#capability-parameters.`,
    });
  }
  return warnings;
}

/**
 * Entity-pinned infra-prereq detector. When a `prerequisites[i].url` has a
 * path segment or query value equal to one of the caller's declared args, the
 * prereq is bound to the discovery-session's entity instead of a site-wide root. For
 * infra prereqs (guest-token cookie scrape, main-bundle JS parsing, CSRF token
 * extraction) the URL should be the site root — loading any page would work,
 * and pinning to the discoverer's profile makes the strategy read like it's
 * entity-scoped when it isn't.
 *
 * Emits `kind: "entity_pinned_infra_prereq"`. Advisory — legitimate cases (a
 * truly entity-scoped lookup prereq) can be acked via
 * `notes.save_warnings_acked`.
 */
export function detectEntityPinnedPrereqUrls(data: Strategy, sessionId?: string): SaveWarning[] {
  const warnings: SaveWarning[] = [];
  const obj = data as Record<string, unknown>;
  const prereqs = obj.prerequisites;
  if (!Array.isArray(prereqs)) return warnings;

  const declaredArgsProviderFn = getDeclaredArgsProvider();
  const declaredArgs =
    sessionId && declaredArgsProviderFn ? declaredArgsProviderFn(sessionId) : null;
  if (!declaredArgs) return warnings;

  // Only values of non-trivial length are meaningful substrings. 1-3 char args
  // would false-positive everywhere ("a" appearing in any URL).
  const scannable: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(declaredArgs)) {
    if (typeof value !== 'string') continue;
    if (value.length < 4) continue;
    scannable.push({ name, value });
  }
  if (scannable.length === 0) return warnings;

  prereqs.forEach((p, idx) => {
    if (!p || typeof p !== 'object') return;
    const pr = p as Record<string, unknown>;
    const url = pr.url;
    if (typeof url !== 'string' || url.length === 0) return;
    for (const { name, value } of scannable) {
      if (!urlContainsEntityComponent(url, value)) continue;
      warnings.push({
        kind: 'entity_pinned_infra_prereq',
        message:
          `prerequisites[${idx}].url = ${JSON.stringify(url)} contains the literal ` +
          `${JSON.stringify(value)} from the caller's declared arg "${name}". ` +
          `This pins the prereq to the discovery-session entity.`,
        hint:
          `If the prereq is infra (guest-token cookie, main-bundle JS parse, CSRF ` +
          `token) use the site root instead — any page loads the same infra. If it's ` +
          `genuinely an entity-scoped lookup, template the entity literal via a ` +
          `{{placeholder}} fed from args.`,
      });
      // One warning per prereq is enough — don't double-flag if multiple args
      // happen to appear in the same url.
      return;
    }
  });
  return warnings;
}

/**
 * Compares caller values only with entity-bearing URL components. Hostnames
 * identify the platform and cannot prove that a prerequisite is pinned to the
 * caller's entity. Exact component equality avoids treating unrelated words
 * that happen to occur in a URL as evidence.
 */
function urlContainsEntityComponent(url: string, value: string): boolean {
  if (url === value) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const components = [
    ...parsed.pathname.split('/').filter(Boolean),
    ...parsed.searchParams.values(),
  ];
  if (parsed.hash.length > 1) components.push(parsed.hash.slice(1));

  return components.some((component) => {
    if (component === value) return true;
    try {
      return decodeURIComponent(component) === value;
    } catch {
      return false;
    }
  });
}

/**
 * Ack-gate validator. Runs after all detectors have emitted `SaveWarning[]`.
 * Agent can unblock a save despite emitted warnings by adding
 * `notes.save_warnings_acked: [{kind, reason}]` — one ack per emitted warning
 * kind, each with a one-sentence justification.
 *
 * Rejects when: - An emitted warning kind has no matching ack. - An ack names a
 * kind that wasn't emitted (typo catch). - An ack is missing the `reason`
 * field, or reason is empty.
 *
 * Throws `invalid_strategy:` on failure; the combined rejection message
 * includes each unacked warning's kind + message + hint so the agent either
 * fixes the strategy or writes the ack shape inline on retry.
 */
/**
 * Multi-fetch inline-JS detector. When any executable-JS-string field on the
 * strategy (prereq expression, top-level `script` / `expression`, or
 * `frameFromPage.expression`) contains more than one `fetch(...)` call, the
 * agent is inlining what should be multiple capabilities. Surfaced as an
 * acked warning (not a hard reject): single fetch inline is
 * borderline-acceptable for page-local lookups, but chaining 2+ is a smell
 * that almost always indicates two or more endpoints that each want to be
 * their own saved sibling capability. The ack escape lets the agent insist
 * inline with a tamper-evident reason when the chained fetches genuinely
 * cannot be split (rare).
 */
export function detectInlineMultiFetchPrereqs(data: Strategy): SaveWarning[] {
  const warnings: SaveWarning[] = [];
  const fetchRe = /\bfetch\s*\(/g;
  for (const { location, text } of collectExecutableJsStrings(data)) {
    const matches = text.match(fetchRe);
    if (!matches || matches.length <= 1) continue;
    warnings.push({
      kind: 'multi_fetch_inline_prereq',
      message: `${location} inlines ${matches.length} fetch() calls — it looks like this is doing multiple network calls, consider breaking up into a lookup_<entity> sibling capability per call and chaining via {kind:"capability"} prereqs`,
      hint: 'Each HTTP endpoint that already exists on its own is a capability in its own right. Saving it separately makes it reusable across other capabilities and observable via list_platform_skills. If the fetches genuinely cannot be split (chained single-use tokens, encoded step-wise flow), ack with a one-sentence reason.',
    });
  }
  return warnings;
}

/**
 * Prereq bind-key mismatch detector. When a prereq declares `binds: "X"` and
 * the strategy wires `{{X}}` into a URL query / body / header slot, the
 * captured XHR for the strategy's endpoint should carry a parameter key
 * named `X` in that slot. When it doesn't — but carries a similarly-named
 * key `Y` instead — the agent probably named the bind after a local
 * variable they had in mind instead of the wire key the server expects.
 * Warm execute templates the value under the bind name and the server, if
 * the template key happens to match the bind, reads from a key that isn't
 * on the wire at all.
 *
 * Structural match: locate the slot(s) where `{{X}}` is templated, then
 * check — against the captured request on that same endpoint — whether
 * slot-key `X` appears. If not, find the closest-looking key `Y` in that
 * slot (shared stem after underscore/camel normalization) and emit a
 * warning naming `Y` as the likely correct bind name.
 *
 * Emits `kind: "prereq_bind_key_mismatch"`. Advisory — a caller who
 * deliberately renamed the bind can ack via `notes.save_warnings_acked`.
 */
/**
 * Lookup-embedded-in-prereq detector. When a strategy declares a js-eval or
 * fetch-extract prereq whose URL (or fetch() literal inside a js-eval
 * expression) targets a `/search` or `/lookup` path segment, the prereq is
 * inlining what ought to be its own capability. The documented composition
 * pattern: save the lookup as `lookup_<entity>_by_<key>` and reference it via
 * a `{kind: "capability", capability: "lookup_<entity>_by_<key>", vars:
 * {"<entity>_id": "<dot.path>"}}` prereq. Inline lookups don't compose — future capabilities
 * that need the same search have to re-inline the expression.
 *
 * Suppressed when the containing capability slug owns a retrieval surface
 * (`search_<entity>`, `lookup_<entity>`, `list_<entity>`, or the equivalent
 * `<entity>_search`) — fetching a search endpoint is the capability itself.
 *
 * Emits `kind: "lookup_embedded_in_prereq"`. The Detector is wired with
 * `ackReason: 'none'` in `save-strategy.ts` — there is no `save_warnings_acked`
 * path. The fix is structural: save the lookup as its own capability and
 * compose via `{kind: "capability"}` prereq.
 */
export function detectLookupEmbeddedInPrereq(data: Strategy, capability?: string): SaveWarning[] {
  const warnings: SaveWarning[] = [];
  const obj = data as Record<string, unknown>;

  // A first-class retrieval capability owns the search/list surface. The
  // same inline shape in a downstream capability still emits the warning.
  if (typeof capability === 'string' && isLookupSurfaceOwnerCapability(capability)) return warnings;

  // /search or /lookup as a path segment — bounded on both sides so
  // `/api/researcher` doesn't false-positive.
  const lookupPathRe = /\/(search|lookup)(?:\/|\?|$)/i;

  const extractUrlsFromExpression = (expr: string): string[] => {
    const out: string[] = [];
    const fetchRe = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = fetchRe.exec(expr)) !== null) {
      if (m[2]) out.push(m[2]);
    }
    return out;
  };

  const capSlug = capability ?? 'this_capability';
  const seenLocations = new Set<string>();

  const pushWarning = (location: string, url: string): void => {
    if (seenLocations.has(location)) return;
    seenLocations.add(location);
    let pathish = url;
    try {
      pathish = new URL(url).pathname;
    } catch {
      // Template-only URL (no origin) — fall through with raw string.
    }
    // Guess the entity from the path after /search or /lookup
    // (e.g. /api/members/search → "members"). Best-effort; agent refines.
    const entityGuess = (() => {
      const segs = pathish.split('/').filter((s) => s.length > 0);
      const idxSearch = segs.findIndex((s) => s === 'search' || s === 'lookup');
      if (idxSearch > 0) {
        const prev = segs[idxSearch - 1] ?? '';
        return prev.replace(/s$/, '') || 'entity';
      }
      return 'entity';
    })();

    warnings.push({
      kind: 'lookup_embedded_in_prereq',
      message:
        `${location} fetches ${pathish} — this looks like a name→id lookup embedded in ${capSlug} itself. ` +
        `The documented pattern is to save the lookup as its own capability (e.g. lookup_${entityGuess}_by_<key>) ` +
        `and declare a {kind: "capability", capability: "lookup_${entityGuess}_by_<key>", vars: {"${entityGuess}_id": "<dot.path>"}} ` +
        `prereq on this strategy. Inline lookups don't compose — future capabilities that need the same ` +
        `search have to re-write the same expression. See klura://reference#capability-prereq.`,
      hint:
        `Save GET ${url} as its own capability first (lookup_${entityGuess}_by_<key>), then reference it ` +
        `as a capability: prereq here. There is no ack path for this warning — even when this is the only ` +
        `known caller today, factoring the lookup as a sibling capability is the structural shape klura ` +
        `composes around (\`{kind: "capability"}\` prereqs read it back at warm execute).`,
    });
  };

  // URL-field layer: prereq.url on js-eval / fetch-extract (a URL field, not
  // executable JS, so scanned separately from the JS-body helper).
  const prereqs = obj.prerequisites;
  if (Array.isArray(prereqs)) {
    prereqs.forEach((raw, idx) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as Record<string, unknown>;
      const kind = p.kind;
      if (kind !== 'js-eval' && kind !== 'fetch-extract') return;
      if (typeof p.url !== 'string' || p.url.length === 0) return;
      let pathish = p.url;
      try {
        pathish = new URL(p.url).pathname;
      } catch {
        // template-only — keep raw
      }
      if (!lookupPathRe.test(pathish)) return;
      const name = typeof p.name === 'string' ? p.name : `prerequisites[${idx}]`;
      pushWarning(`Prereq "${name}" (prerequisites[${idx}].url)`, p.url);
    });
  }

  // Executable-JS-string layer: scan every JS body (prereq expressions,
  // top-level script / expression, frameFromPage.expression) for `fetch('/search…')`
  // literals that inline a lookup.
  for (const { location, text } of collectExecutableJsStrings(data)) {
    for (const url of extractUrlsFromExpression(text)) {
      let pathish = url;
      try {
        pathish = new URL(url).pathname;
      } catch {
        // keep raw
      }
      if (!lookupPathRe.test(pathish)) continue;
      pushWarning(location, url);
      // One warning per location — don't double-flag if a single body carries
      // two fetch() calls both hitting /search.
      break;
    }
  }

  return warnings;
}

/**
 * Catch a placeholder-rename escape on enum grounding. The session's
 * click→XHR observations are keyed by the URL parameter name on the
 * captured request (e.g. `?category=italian` → `observedParamValues.category`).
 * The strategy's `notes.params.<X>` is keyed by the PLACEHOLDER name —
 * usually the same as the URL param, but the agent can rename
 * (`?category={{cuisine}}` with `notes.params.cuisine.kind: "text"`) to
 * dodge the enum-grounding requirement: the existing
 * `validateCallerInputKindsAndEnums` looks up `observedParamValues.cuisine`,
 * finds nothing, and lets `kind: "text"` pass even though the URL param
 * `category` was actually click-grounded with values.
 *
 * Structural fix: parse the strategy's endpoint for `?<urlParam>={{<placeholder>}}`
 * pairs, and for each pair where `observedParamValues[urlParam]` has UI-click
 * observations, require `notes.params[placeholder]` to be `kind: "enum"` with
 * `observed_values` (or `source: "capability:..."` when the values come from
 * a listing capability). The rename can't change the wire-level fact that
 * the URL param is an enum.
 *
 * `ackReason: 'none'` — fix the kind/grounding or rename the placeholder
 * back to match the URL param. No legitimate ack-bypass.
 */
export function detectUngroundedEnumPlaceholder(
  data: Strategy,
  observedParamValues: Record<string, ParamObservationLite[]>,
): SaveWarning[] {
  const obj = data as Record<string, unknown>;
  const endpoint = typeof obj.endpoint === 'string' ? obj.endpoint : '';
  if (!endpoint || endpoint.length === 0) return [];
  let url: URL;
  try {
    url = new URL(endpoint, 'https://__klura_placeholder__/');
  } catch {
    return [];
  }
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  const warnings: SaveWarning[] = [];
  const placeholderRe = /^\{\{([^}]+)\}\}$/;
  for (const [urlParam, value] of url.searchParams) {
    const m = placeholderRe.exec(value);
    if (!m) continue;
    const placeholder = m[1];
    if (!placeholder) continue;
    const obs = observedParamValues[urlParam] ?? [];
    const clickObs = obs.filter((o) => o.source.kind === 'ui_click');
    if (clickObs.length === 0 || observedValuesAreIntegerRange(clickObs)) continue;
    const declared = params && typeof params === 'object' ? params[placeholder] : undefined;
    if (declared && typeof declared === 'object') {
      const d = declared as { kind?: unknown; observed_values?: unknown; source?: unknown };
      if (d.kind === 'enum' && Array.isArray(d.observed_values) && d.observed_values.length > 0) {
        continue;
      }
      if (d.kind === 'enum' && typeof d.source === 'string' && d.source.startsWith('capability:')) {
        continue;
      }
    }
    const seen = new Set<string>();
    const sample: string[] = [];
    for (const o of clickObs) {
      if (typeof o.value !== 'string' || seen.has(o.value)) continue;
      seen.add(o.value);
      const label = typeof o.source.label === 'string' ? ` ("${o.source.label}")` : '';
      sample.push(`${JSON.stringify(o.value)}${label}`);
      if (sample.length >= 5) break;
    }
    const declaredKind =
      declared &&
      typeof declared === 'object' &&
      (declared as { kind?: unknown }).kind !== undefined
        ? JSON.stringify((declared as { kind?: unknown }).kind)
        : 'undeclared';
    const renameNote =
      placeholder === urlParam
        ? ''
        : ` (placeholder "${placeholder}" is bound to URL param "${urlParam}" — observations live under the URL param name, not the placeholder).`;
    warnings.push({
      kind: 'ungrounded_enum_placeholder',
      message:
        `Endpoint \`${endpoint}\` has \`?${urlParam}={{${placeholder}}}\` and the session captured ` +
        `${clickObs.length} click→XHR observation(s) for URL param "${urlParam}" (${sample.join(', ')}).${renameNote} ` +
        `\`notes.params.${placeholder}\` is currently ${declaredKind} — must be \`kind: "enum"\` with \`observed_values\` ` +
        `populated from those click→XHR pairs (or \`kind: "enum"\` with \`source: "capability:list_<entity>"\` when the ` +
        `valid values come from a listing endpoint you also save as a sibling capability). \`kind: "text"\` drops the ` +
        `enum grounding the audit was meant to enforce — a future caller passing any string would 4xx against the live API.`,
      hint:
        `Set \`notes.params.${placeholder} = {kind: "enum", observed_values: [{value, label}, ...]}\` populated from the ` +
        `captured pairs the runtime recorded under URL param "${urlParam}". If the valid values come from a backend ` +
        `listing endpoint observed in this session, save that endpoint as a sibling \`list_<entity>\` capability and use ` +
        `\`source: "capability:list_<entity>"\` instead of static observed_values — the values then refresh on every warm execute.`,
    });
  }
  return warnings;
}

/** Minimal subset of ParamObservation this detector needs. Avoids importing
 *  the full type from ../response/session-observations into this file. */
interface ParamObservationLite {
  value: string;
  source: { kind: string; label?: string };
}

/** Minimal session-shape this detector reads. Just `intercepted` for body
 *  scanning + the urls+paths for collision lookup. */
interface SessionLite {
  intercepted?: ReadonlyArray<{
    method: string;
    url: string;
    responseBody?: unknown;
  }>;
  /** Caller-declared capability bundles. The agent passed each `{capability,
   *  args}` pair via `start_session` or `declare_capability`. Their string
   *  arg values are caller-input by construction — if one shows up as an
   *  `observed_value` on a saved param, that's a misclassification (the
   *  agent typed it; it's not an enumerable option). */
  declaredCapabilities?: ReadonlyArray<{
    capability: string;
    args: Record<string, unknown>;
    declared_at: number;
  }>;
}

/**
 * Catch the listing-not-factored case at save time. When a strategy
 * declares an enum param with grounded `observed_values`, AND the session
 * captured a different request whose response enumerates those values
 * (the listing endpoint), AND no sibling capability already targets that
 * listing endpoint, the listing belongs as its own `list_<entity>`
 * capability. The runtime's `notes.params.<X>.source: "capability:list_<entity>"`
 * resolution wires up the dynamic refresh at execute time.
 *
 * Same structural signal that `collectListingCandidates` surfaces in the
 * end_drive handoff — but `end_drive` isn't always reached
 * before save_strategy (agents that save directly skip the handoff). This
 * detector fires at save time, which every save passes through, so the
 * hint can't be missed.
 *
 * `ackReason: 'required'` — most cases the agent should save the
 * listing, but legitimate exceptions exist (paginated listing, partial
 * subset, listing requires auth that the use-site doesn't, etc.). Ack
 * with a one-sentence reason naming the structural difference.
 */
type InterceptedRequest = NonNullable<SessionLite['intercepted']>[number];

/**
 * Collect every string value the caller declared in `start_session({args})`
 * or `declare_capability({args})` for this session. Returns a Set for
 * `has(value)` lookup. Empty when the session has no declarations (e.g.
 * programmatic save shapes that bypass the start_session contract).
 */
function collectCallerArgStrings(session: SessionLite | null | undefined): Set<string> {
  const out = new Set<string>();
  const decls = session?.declaredCapabilities;
  if (!decls || decls.length === 0) return out;
  for (const d of decls) {
    const args = d.args;
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v.length > 0) out.add(v);
    }
  }
  return out;
}

function bodyAsString(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (typeof body !== 'object') return null;
  try {
    return JSON.stringify(body);
  } catch {
    return null;
  }
}

function canonicalizeUrl(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    let pathname = u.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

function findListingUrlForValues(
  intercepted: ReadonlyArray<InterceptedRequest>,
  values: string[],
  myEndpoint: string | null,
): string | null {
  for (const req of intercepted) {
    if (req.responseBody === undefined || req.responseBody === null) continue;
    const bodyStr = bodyAsString(req.responseBody);
    if (bodyStr === null) continue;
    // A JSON object/array body is an unambiguous listing — substring presence of
    // every value is sufficient. An HTML body needs corroboration: the substring
    // check alone matches "italian" inside `data-category="italian"` just as
    // readily as a real listing, so an HTML page is only treated as the listing
    // when one of the values is also used in a real captured request/navigation
    // (the click→XHR proof the contract-side detector requires). This grounds
    // SSR listings (the category index IS the homepage HTML) without flagging an
    // arbitrary page that happens to carry the values as attributes.
    const trimmed = bodyStr.trimStart();
    const isJsonBody = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (!isJsonBody && !valuesCorroboratedByRequest(intercepted, values, req.url)) continue;
    const allPresent = values.every(
      (v) => bodyStr.includes(`"${v}"`) || bodyStr.includes(JSON.stringify(v)),
    );
    if (!allPresent) continue;
    const captureCanon = canonicalizeUrl(req.url);
    if (myEndpoint && captureCanon && myEndpoint === captureCanon) continue;
    return req.url;
  }
  return null;
}

/** True when one of `values` appears as a query value or path segment in some
 *  captured request OTHER than `selfUrl` — the click→XHR proof that an HTML
 *  page's substring match reflects a real navigable enum, not a stray
 *  `data-*` attribute. */
function valuesCorroboratedByRequest(
  intercepted: ReadonlyArray<InterceptedRequest>,
  values: string[],
  selfUrl: string,
): boolean {
  const want = new Set(values);
  for (const r of intercepted) {
    if (r.url === selfUrl) continue;
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    for (const v of u.searchParams.values()) if (want.has(v)) return true;
    for (const seg of u.pathname.split('/')) if (seg && want.has(seg)) return true;
  }
  return false;
}

// Returns the name of a saved sibling capability whose endpoint matches the
// listing URL (i.e. the listing is already factored into its own capability),
// or null when none is saved.
function findSavedListingCapability(
  listingUrl: string,
  capability: string,
  loadStrategiesForPlatform: (capabilityName: string) => Strategy[],
  listSavedCapabilityNames: () => string[],
): string | null {
  const listingCanon = canonicalizeUrl(listingUrl);
  if (!listingCanon) return null;
  for (const cap of listSavedCapabilityNames()) {
    if (cap === capability) continue;
    let strategies: Strategy[];
    try {
      strategies = loadStrategiesForPlatform(cap);
    } catch {
      continue;
    }
    for (const s of strategies) {
      const otherCanon = canonicalizeEndpoint(s as unknown as Record<string, unknown>);
      if (otherCanon === listingCanon) return cap;
    }
  }
  return null;
}

function checkCapabilitySource(
  paramName: string,
  source: string,
  loadStrategiesForPlatform: ((capabilityName: string) => Strategy[]) | undefined,
): SaveWarning | null {
  const sourceCapability = source.slice('capability:'.length).trim();
  if (sourceCapability.length === 0 || !loadStrategiesForPlatform) return null;
  try {
    if (loadStrategiesForPlatform(sourceCapability).length > 0) return null;
  } catch {
    /* fall through to warning */
  }
  return {
    kind: 'enum_param_listing_unfactored',
    message:
      `\`notes.params.${paramName}.source = "capability:${sourceCapability}"\` references a sibling capability ` +
      `that has no saved strategy on this platform yet. Save it first (the captured listing endpoint that ` +
      `enumerates ${paramName}'s values), THEN re-save this capability — the runtime resolves ` +
      `\`source: "capability:..."\` at execute time and would throw on warm execute against a dangling ` +
      `reference. The right shape: list-then-pick — save the listing capability, save this capability ` +
      `referencing it. \`required_siblings\` on the LIFT-entry contract names the count.`,
    hint:
      `Save \`save_strategy\` against the captured listing URL with a clean verb+noun slug ` +
      `(e.g. list_<entity>), then re-save this capability with the same source: capability:... reference. ` +
      `There is no ack path for this warning; the dangling source IS structurally broken at warm-execute. ` +
      `If the listing has auth / pagination / partial-subset constraints, model them inside the sibling ` +
      `capability (prereq for auth, args for pagination) — the source reference still resolves cleanly.`,
  };
}

export function detectEnumParamListingUnfactored(
  data: Strategy,
  session: SessionLite | null | undefined,
  capability: string,
  loadStrategiesForPlatform: ((capabilityName: string) => Strategy[]) | undefined,
  listSavedCapabilityNames: (() => string[]) | undefined,
): SaveWarning[] {
  const intercepted = session?.intercepted;
  if (!intercepted || intercepted.length === 0) return [];
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return [];
  const warnings: SaveWarning[] = [];
  const claimedParams = new Set<string>();
  const myEndpoint = canonicalizeEndpoint(data as unknown as Record<string, unknown>);

  for (const [paramName, info] of Object.entries(params)) {
    if (claimedParams.has(paramName)) continue;
    if (!info || typeof info !== 'object') continue;
    const i = info as { kind?: unknown; observed_values?: unknown; source?: unknown };
    if (i.kind !== 'enum') continue;
    if (typeof i.source === 'string' && i.source.startsWith('capability:')) {
      const w = checkCapabilitySource(paramName, i.source, loadStrategiesForPlatform);
      if (w) {
        warnings.push(w);
        claimedParams.add(paramName);
      }
      continue;
    }
    if (!Array.isArray(i.observed_values) || i.observed_values.length === 0) continue;
    const rawValues = i.observed_values
      .map((v) => (v && typeof v === 'object' ? (v as { value?: unknown }).value : null))
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (rawValues.length === 0) continue;
    // C2 filter: drop entries that match a string the caller declared in
    // their session args. Those are caller-input by construction (the agent
    // typed them); a real enum is enumerable on the site, not authored by
    // the caller. With the typed-value filter in the observation pipeline
    // now uniform across getNetworkLog + save-strategy (commit 1f19421),
    // caller-input values shouldn't reach observed_values at all, but this
    // layer is a structural guard against future regressions.
    const callerArgValues = collectCallerArgStrings(session);
    const values = rawValues.filter((v) => !callerArgValues.has(v));
    if (values.length === 0) continue;
    // C1 guard: a real enum has multiple alternatives observed. A single
    // observed value matches "any captured response that contains the
    // substring" — which surfaces transient artifacts (a chat-history
    // endpoint whose body echoes the just-sent message) rather than a real
    // listing. The listing-factor signal needs ≥2 distinct values to be
    // load-bearing. The upstream save-time enum-guard rejects kind:"enum"
    // with <2 observed_values, so reaching this branch is the belt-and-
    // suspenders case where the guard missed (e.g. legacy saves, programmatic
    // save shapes).
    if (new Set(values).size < 2) continue;

    const listingUrl = findListingUrlForValues(intercepted, values, myEndpoint);
    if (!listingUrl) continue;

    const savedListing =
      loadStrategiesForPlatform && listSavedCapabilityNames
        ? findSavedListingCapability(
            listingUrl,
            capability,
            loadStrategiesForPlatform,
            listSavedCapabilityNames,
          )
        : null;
    if (savedListing) {
      // The listing is ALREADY a saved capability, but this strategy froze
      // observed_values inline instead of linking to it. Don't stay silent
      // (the old early-out) — that abandons the freshness contract: the inline
      // values never refresh while the saved listing does. Nudge to source-link.
      claimedParams.add(paramName);
      const valueSample = values
        .slice(0, 6)
        .map((v) => JSON.stringify(v))
        .join(', ');
      warnings.push({
        kind: 'enum_param_listing_unfactored',
        message:
          `\`notes.params.${paramName}\` is enum-grounded with frozen observed_values [${valueSample}], ` +
          `but the listing they came from is ALREADY saved as the sibling capability \`${savedListing}\`. ` +
          `Inline observed_values never refresh; the saved listing does. Link them so the enum re-resolves ` +
          `on every warm execute instead of staying frozen at discovery.`,
        hint:
          `Re-save with \`notes.params.${paramName} = {kind: "enum", source: "capability:${savedListing}"}\` ` +
          `(you may keep observed_values as a fast-path cache, but source: makes it dynamic). The runtime ` +
          `resolves \`source: "capability:${savedListing}"\` directly at execute time — no extra prereq needed.`,
      });
      continue;
    }

    claimedParams.add(paramName);
    const valueSample = values
      .slice(0, 6)
      .map((v) => JSON.stringify(v))
      .join(', ');
    warnings.push({
      kind: 'enum_param_listing_unfactored',
      message:
        `\`notes.params.${paramName}\` is enum-grounded with observed_values [${valueSample}], ` +
        `but the session captured ${listingUrl} whose response enumerates those values — that capture IS the listing ` +
        `for this enum, and it deserves to be its own \`list_<entity>\` capability. Save the listing as a sibling, ` +
        `then re-save this capability with \`notes.params.${paramName}\` linked via \`source: "capability:list_<entity>"\` ` +
        `(drop the static observed_values). The runtime resolves \`source: "capability:..."\` at execute time — your ` +
        `dynamic enum refreshes on every warm execute instead of being frozen at discovery.`,
      hint:
        `Two-step: (1) save_strategy on ${listingUrl} as its own capability (e.g. \`list_<entity>\`), ` +
        `(2) re-save this capability with \`notes.params.${paramName} = {kind: "enum", source: "capability:<that-slug>"}\`. ` +
        `If the listing has a structural reason it shouldn't be factored (paginated listing the use-site doesn't ` +
        `paginate, partial subset that diverges from full enumeration, listing requires auth the use-site doesn't), ` +
        `the right shape is still a separate capability — model the constraint inside that capability (e.g. ` +
        `prerequisites: auth, args: {page_size: ...}). There is no ack path for this warning; the listing IS its own ` +
        `capability.`,
    });
  }
  return warnings;
}

/**
 * Recorded-path sibling of `detectLookupEmbeddedInPrereq`. Catches a
 * conflated lookup-then-write flow when the agent saves a `recorded-path`
 * (no `prerequisites[]` to inspect): a `click` step that selects from a
 * search result, where the preceding XHR hit a `/search` or `/lookup`
 * endpoint. This pattern is the same library-quality concern as
 * fetch-tier inline lookups — the lookup is a separable capability, not a
 * step in the write capability.
 *
 * Structural signal: the captured request URL set (`capturedEndpointPaths`)
 * already contains every URL that fired during the session; if any of
 * them matches `/search|/lookup` AND the strategy is recorded-path, the
 * agent very likely conflated the lookup. Recorded-path strategies that
 * legitimately need to walk a search UI for a non-name lookup (e.g.
 * a multi-step disambiguation) can ack with a structural reason; default
 * is `ackReason: 'none'` to enforce factoring.
 */

// detectRecordedPathInlinesLookup moved to ./save-warnings-recorded-path-lookup
// (this file hit the 1000-line cap; the detector is self-contained).
export { detectRecordedPathInlinesLookup } from './save-warnings-recorded-path-lookup';
export { detectUnreferencedParams } from './save-warnings-unreferenced-params';
