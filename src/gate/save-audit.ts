// Pre-save audit dimensions — three classification axes the agent commits
// to during save_strategy: `literal_provenance` (every URL/header/body
// literal classified by source), `capability_name_justification` (slug
// segments implying lookups must be threaded through a sibling capability
// prereq or justified), `observed_siblings` (every captured endpoint not
// covered by a saved sibling must be recorded or excused).
//
// The classifiers for these dimensions live on the consolidated
// saveStrategyAudit (runtime/src/audit/lift/save-strategy.ts). This file
// retains the structural validators they reuse:
// validateLiteralAnswer, validateNameJustification, validateObservedSiblings,
// validateCallerInputKindsAndEnums, validateLookupPrereqsAreCapabilities.

import { collectExecutableJsStrings } from './save-warnings';
import type { Strategy } from '../strategies/skills';
import type { ParamObservation } from '../response/session-observations';
import { closestAllowedCandidates, formatCandidateList } from '../validators';

// ---------- Answer shapes the agent submits on call 2 ----------

export type LiteralClassification =
  | 'static'
  | { caller_input: string }
  | { prereq_output: string }
  | 'single_entity';

export interface AuditAnswers {
  // Keyed by path (matches ScannedField.path from collectScannedFields).
  literal_provenance: Record<string, LiteralClassification>;
  // Required only when the capability slug has a lookup-implying segment AND
  // no lookup-shaped prereq is declared. Runtime will rejected an empty
  // justification.
  capability_name_justification?: string;
  // Keyed by "<METHOD> <url>" string matching the observed-sibling entry.
  // Values are "recorded" (agent called record_observed_capability this
  // session) or "not_worth_recording:<one-sentence reason>".
  observed_siblings: Record<string, string>;
}

// ---------- Checklist items the runtime emits on call 1 ----------

export interface LiteralItem {
  path: string;
  value: string;
  /** Pre-derived classification. Set when the field contains exactly one
   *  distinct placeholder name {{X}}: the runtime resolves it to caller_input
   *  or prereq_output by checking whether X matches a declared prereq.binds.
   *  Agents may omit `audit_answers.literal_provenance[<this.path>]` — the
   *  audit fills it in from this value. Set explicitly to the same shape
   *  to override (rare). */
  auto_classified?: LiteralClassification;
}

export interface NameSegmentItem {
  segment: string; // e.g. "by_name"
  hint: string;
}

export interface ObservedSiblingItem {
  method: string;
  url: string;
  key: string; // the string the agent uses as the answer key
}

// ---------- Capability-name parsing ----------

// Segments in a capability slug that imply a lookup step. Not a
// heuristic-gated reject — just a signal the runtime surfaces for the
// agent to respond to.
const LOOKUP_SEGMENT_REGEX = /(?:^|_)(by_[a-z]+|for_[a-z]+|lookup_[a-z]+)/g;

export function findLookupSegments(capability: string): string[] {
  const matches: string[] = [];
  for (const m of capability.matchAll(LOOKUP_SEGMENT_REGEX)) {
    if (m[1]) matches.push(m[1]);
  }
  return matches;
}

export function hasLookupShapedPrereq(data: Strategy): boolean {
  const prereqs = (data as Record<string, unknown>).prerequisites;
  if (!Array.isArray(prereqs)) return false;
  return prereqs.some((p) => {
    if (!p || typeof p !== 'object') return false;
    const kind = (p as Record<string, unknown>).kind;
    return kind === 'capability' || kind === 'tag' || kind === 'fetch-extract';
  });
}

/** Canonicalize a URL to origin+pathname (ignoring query + fragment) so a
 *  prereq URL with a `{{placeholder}}` in the query matches a captured
 *  URL that had a concrete value there. Returns null when the string is
 *  not a valid URL (e.g. a template-only path). */
function canonicalizeUrlPath(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** Extract URL-like strings from a prereq. Covers fetch-extract's `url`,
 *  page-extract's `url`, and js-eval `expression` strings that contain
 *  `fetch('...')` or `fetch("...")` calls. js-eval expressions are parsed
 *  by naive regex — the only question is "does this prereq hit an
 *  endpoint we captured?" so partial extraction is fine: any hit triggers
 *  the check. */
function extractPrereqUrlCandidates(prereq: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof prereq.url === 'string' && prereq.url.length > 0) out.push(prereq.url);
  const expression = prereq.expression;
  if (typeof expression === 'string') {
    const fetchRe = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = fetchRe.exec(expression)) !== null) {
      if (m[2]) out.push(m[2]);
    }
  }
  return out;
}

/**
 * Enforce lookup-as-capability for write strategies whose slug implies a
 * lookup. When the capability slug contains a `_by_<x>` / `_for_<x>` /
 * `lookup_<x>` segment AND a prereq hits an endpoint that was actually
 * observed in session traffic, that prereq MUST be routed as
 * `{kind: "capability"}` pointing at a separately-saved sibling — never
 * inlined as fetch-extract / js-eval / page-extract. Rationale: lookups
 * that are real HTTP endpoints are capabilities in their own right;
 * inlining them defeats reuse and hides a save worth tracking. Prereqs
 * that run purely against page state (page-extract / js-eval with no
 * fetch URL) do not trip this check — they're genuinely page-local.
 */
export function validateLookupPrereqsAreCapabilities(
  capability: string,
  data: Strategy,
  capturedEndpointPaths: Set<string>,
): string[] {
  if (findLookupSegments(capability).length === 0) return [];
  if (capturedEndpointPaths.size === 0) return [];
  const prereqs = (data as Record<string, unknown>).prerequisites;
  if (!Array.isArray(prereqs)) return [];
  const issues: string[] = [];
  prereqs.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const p = raw as Record<string, unknown>;
    const kind = typeof p.kind === 'string' ? p.kind : '';
    if (kind === 'capability' || kind === 'tag') return; // already routed correctly
    const urlCandidates = extractPrereqUrlCandidates(p);
    for (const url of urlCandidates) {
      const canon = canonicalizeUrlPath(url);
      if (canon === null) continue;
      if (!capturedEndpointPaths.has(canon)) continue;
      const lookupName = typeof p.name === 'string' && p.name.length > 0 ? p.name : 'lookup';
      issues.push(
        `prerequisites[${idx}] (kind:"${kind}") hits ${canon} which was observed in session traffic — capability "${capability}" has a lookup-implying slug (_by_/_for_/_lookup_) and its lookup endpoints must be saved as their own sibling capability first, then chained via {kind: "capability", capability: "<saved-slug>", args: {...}, vars: {<name>: "<dot.path>"}}. Split: (1) save_strategy("${lookupName}", ...) with the fetch against ${canon}; (2) save_strategy("${capability}", ...) with a capability prereq pointing at it. Inline fetch-extract / js-eval / page-extract for endpoints that exist on their own is rejected.`,
      );
      break; // one issue per prereq is enough
    }
  });
  return issues;
}

// ---------- Consistency checks ----------

function fieldContainsPlaceholder(fieldValue: string, placeholderName: string): boolean {
  return fieldValue.includes(`{{${placeholderName}}}`);
}

/**
 * Return the wire-level param names a `{{placeholder}}` is templated as in the
 * strategy. The runtime records `ParamObservation`s under the WIRE name
 * (`category` in `/api/restaurants?category=italian`) but `notes.params` is
 * keyed by the agent's chosen PLACEHOLDER name (`{{cuisine}}`). Without this
 * resolution, audits that look up "observations for the placeholder" miss
 * everything when the agent renames the placeholder away from the wire name —
 * which is the common case for self-documenting strategy authoring.
 *
 * Covers query params (`?wire={{ph}}`) and JSON-body fields
 * (`{wire: "{{ph}}"}`). Path-segment placeholders have no wire-param name
 * (the URL path doesn't carry key→value structure), so they return [].
 */
export function wireParamNamesForPlaceholder(data: Strategy, placeholderName: string): string[] {
  const found = new Set<string>();
  const ph = `{{${placeholderName}}}`;

  const endpoint = (data as { endpoint?: unknown }).endpoint;
  if (typeof endpoint === 'string' && endpoint.includes(ph)) {
    // Query-string scan: ?wire={{ph}} or &wire={{ph}}.
    const re = new RegExp(`[?&]([^=&]+)=${ph.replace(/[{}]/g, '\\$&')}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(endpoint)) !== null) {
      const wire = m[1];
      if (wire) found.add(decodeURIComponent(wire));
    }
  }

  const body = (data as { body?: unknown }).body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    walkJsonForKeyWithPlaceholder(body as Record<string, unknown>, ph, (k) => found.add(k));
  }
  return [...found];
}

function walkJsonForKeyWithPlaceholder(
  obj: Record<string, unknown>,
  ph: string,
  emit: (key: string) => void,
): void {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.includes(ph)) emit(k);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      walkJsonForKeyWithPlaceholder(v as Record<string, unknown>, ph, emit);
    }
  }
}

function notesParamExists(data: Strategy, name: string): boolean {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return false;
  return name in params;
}

function listDeclaredParamNames(data: Strategy): string[] {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return [];
  return Object.keys(params);
}

export function listDeclaredPrereqBinds(data: Strategy): string[] {
  const prereqs = (data as Record<string, unknown>).prerequisites;
  if (!Array.isArray(prereqs)) return [];
  const out = new Set<string>();
  for (const p of prereqs) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    if (typeof rec.binds === 'string' && rec.binds.length > 0) out.add(rec.binds);
    if (
      (rec.kind === 'page-extract' ||
        rec.kind === 'fetch-extract' ||
        rec.kind === 'capability' ||
        rec.kind === 'tag') &&
      rec.vars &&
      typeof rec.vars === 'object' &&
      !Array.isArray(rec.vars)
    ) {
      for (const k of Object.keys(rec.vars as Record<string, unknown>)) out.add(k);
    }
  }
  return Array.from(out);
}

function prereqWithBindsExists(data: Strategy, binds: string): boolean {
  const prereqs = (data as Record<string, unknown>).prerequisites;
  if (!Array.isArray(prereqs)) return false;
  return prereqs.some((p) => {
    if (!p || typeof p !== 'object') return false;
    const rec = p as Record<string, unknown>;
    if (rec.binds === binds) return true;
    // page-extract / fetch-extract / capability bind under vars:{name: path}.
    if (
      (rec.kind === 'page-extract' ||
        rec.kind === 'fetch-extract' ||
        rec.kind === 'capability' ||
        rec.kind === 'tag') &&
      rec.vars &&
      typeof rec.vars === 'object' &&
      !Array.isArray(rec.vars)
    ) {
      return binds in (rec.vars as Record<string, unknown>);
    }
    return false;
  });
}

// Walk the per-session ParamObservation index and return every ui_click
// observation whose `value` appears as a substring of `literal`. Powers the
// static-on-click-observed rejection inside validateLiteralAnswer. Min-length
// floor (2) drops single-character matches that are noise; api_response
// observations are skipped because Path-B enums (capability:source) own that
// resolution path.
const CLICK_OBSERVATION_MIN_VALUE_LENGTH = 2;
function findClickObservedValuesIn(
  literal: string,
  observedParamValues: Record<string, ParamObservation[]> | undefined,
): Array<{ paramName: string; value: string; label: string }> {
  if (!observedParamValues) return [];
  const out: Array<{ paramName: string; value: string; label: string }> = [];
  const seen = new Set<string>();
  for (const [paramName, observations] of Object.entries(observedParamValues)) {
    if (!Array.isArray(observations)) continue;
    for (const obs of observations) {
      if (obs.source.kind !== 'ui_click') continue;
      const v = obs.value;
      if (typeof v !== 'string' || v.length < CLICK_OBSERVATION_MIN_VALUE_LENGTH) continue;
      if (!literal.includes(v)) continue;
      const key = `${paramName}\0${v}\0${obs.source.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ paramName, value: v, label: obs.source.label });
    }
  }
  return out;
}

// Min-length floor for the `single_entity` example match. Substring acceptance
// (an example like "Granat Sweden AB" satisfying a literal like
// `a:has-text('Granat Sweden AB')`) closes the canonical mismatch where the
// agent declared the example as the entity name and the literal wraps it in a
// locator/expression. Tiny examples (1-2 chars) would let the agent canned-
// answer their way through every literal, so a 3-char floor stays — same
// rationale as CLICK_OBSERVATION_MIN_VALUE_LENGTH on the click-observed check.
const SINGLE_ENTITY_EXAMPLE_MIN_LENGTH = 3;
function literalInAnyExample(data: Strategy, literal: string): boolean {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return false;
  for (const entry of Object.values(params)) {
    if (!entry || typeof entry !== 'object') continue;
    const example = (entry as Record<string, unknown>).example;
    if (typeof example !== 'string' || example.length < SINGLE_ENTITY_EXAMPLE_MIN_LENGTH) continue;
    if (literal.includes(example)) return true;
  }
  return false;
}

// Click-observed exemption for navigate destination URLs. The static-on-click-
// observed rejection treats "value appears in any captured ui_click value" as
// "value is a selectable enum option." That logic is right for URL params,
// body fields, and headers — places where the click-observed value is one of
// several pickable options the user steers between. It's wrong for a navigate
// step's destination URL: the URL IS the entry point of the flow, not a
// choice. Common false positive: site auth flows redirect through
// `?next=<entry-url>`, the entry URL gets picked up as a click-observed value
// of the `next` param, and the navigate step's literal URL then trips the
// rejection. Exemption: when the literal is a `navigate` step's `url` AND the
// observed value equals the literal verbatim, accept `static`.
const NAVIGATE_URL_PATH_RE = /^steps\[(\d+)\]\.url$/;
function isNavigateStepUrl(data: Strategy, path: string): boolean {
  const m = NAVIGATE_URL_PATH_RE.exec(path);
  if (!m || !m[1]) return false;
  const idx = Number(m[1]);
  const steps = (data as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return false;
  const step: unknown = steps[idx];
  if (!step || typeof step !== 'object') return false;
  return (step as Record<string, unknown>).action === 'navigate';
}

export function validateLiteralAnswer(
  data: Strategy,
  item: LiteralItem,
  answer: LiteralClassification | undefined,
  observedParamValues?: Record<string, ParamObservation[]>,
): string[] {
  if (answer === undefined) {
    return [
      `literal_provenance["${item.path}"] missing — classify the field at PATH ${JSON.stringify(item.path)} ` +
        `(its current value is ${JSON.stringify(item.value)}) as one of: ` +
        `"static" | {caller_input: "<param>"} | {prereq_output: "<binds>"} | "single_entity". ` +
        `Use the path as the answer key, NOT the value.`,
    ];
  }
  if (answer === 'static') {
    // Reject static-on-templated: if the field contains any {{placeholder}},
    // the value isn't static per-caller. Forces the agent to split the
    // classification correctly (caller_input / prereq_output / single_entity).
    // Closes the "classify the whole endpoint as static to bypass the enum
    // check" escape hatch.
    if (item.value.includes('{{') && item.value.includes('}}')) {
      return [
        `literal_provenance["${item.path}"] = "static" but the field contains {{placeholder}}(s) — a templated field is NOT static. Reclassify: for each placeholder, the whole field should be "{caller_input: "<param>"}" or "{prereq_output: "<binds>"}". If the field is a mix of static path + a single placeholder, pick the classification that describes the PLACEHOLDER (the part that varies per caller).`,
      ];
    }
    // Reject static-on-click-observed: a literal that contains a string the
    // runtime correlated to a UI click during this session is by-construction
    // a selectable enum option, not a static literal. Same provenance class as
    // the observed_property_keys / observed_literal_values detectors, applied
    // to the literal_provenance classifier so the agent can't escape grounding
    // via "static" when click→XHR observations exist for the value.
    const matches = findClickObservedValuesIn(item.value, observedParamValues);
    if (matches.length > 0) {
      // Navigate-URL exemption: when the literal is a navigate step's url AND
      // every match is a full-value equality (not a substring of a longer
      // literal), the click-observed pairing is just the auth-redirect
      // mechanic (`?next=<entry-url>`), not a selectable enum option. Accept
      // `static`. See the comment on isNavigateStepUrl above.
      if (isNavigateStepUrl(data, item.path) && matches.every((m) => m.value === item.value)) {
        return [];
      }
      return matches.map(
        (m) =>
          `literal_provenance["${item.path}"] = "static" but the value contains ${JSON.stringify(
            m.value,
          )} which the agent observed via UI click during this session (label: ${JSON.stringify(
            m.label,
          )}, param: "${m.paramName}"). A click-observed value is by-construction a selectable enum option, NOT a static literal. Template it: replace ${JSON.stringify(
            m.value,
          )} with {{${m.paramName}}} in the field, declare notes.params.${m.paramName} as {kind: "enum", observed_values: [{value, label}, ...]} grounded in the captured pair, and reclassify this entry as {caller_input: "${m.paramName}"}. See klura://reference#enum-params.`,
      );
    }
    return [];
  }
  if (answer === 'single_entity') {
    if (literalInAnyExample(data, item.value)) return [];
    return [
      `literal_provenance["${item.path}"] = "single_entity" but no notes.params.*.example ` +
        `(min ${SINGLE_ENTITY_EXAMPLE_MIN_LENGTH} chars) appears as a substring of the literal ${JSON.stringify(
          item.value,
        )}. If this strategy is intentionally single-entity, declare the entity name as the example ` +
        `in notes.params.<slug>.example; otherwise reclassify.`,
    ];
  }
  if ('caller_input' in answer) {
    const name = answer.caller_input;
    const problems: string[] = [];
    if (!fieldContainsPlaceholder(item.value, name)) {
      problems.push(
        `literal_provenance["${item.path}"] = {caller_input: "${name}"} but {{${name}}} does not appear in the field value ${JSON.stringify(
          item.value,
        )}. Either substitute the placeholder into the field, or reclassify.`,
      );
    }
    if (!notesParamExists(data, name)) {
      const declared = listDeclaredParamNames(data);
      const candidates = closestAllowedCandidates(name, declared, (s) => s, { maxResults: 5 });
      const block = formatCandidateList(candidates, {
        header: `Declared notes.params names (${declared.length})`,
      });
      problems.push(
        `literal_provenance["${item.path}"] = {caller_input: "${name}"} but notes.params["${name}"] is not declared. Add it or reclassify.${block}`,
      );
    }
    return problems;
  }
  if ('prereq_output' in answer) {
    const name = answer.prereq_output;
    const problems: string[] = [];
    if (!fieldContainsPlaceholder(item.value, name)) {
      problems.push(
        `literal_provenance["${item.path}"] = {prereq_output: "${name}"} but {{${name}}} does not appear in the field value ${JSON.stringify(
          item.value,
        )}. Either substitute the placeholder into the field, or reclassify.`,
      );
    }
    if (!prereqWithBindsExists(data, name)) {
      const binds = listDeclaredPrereqBinds(data);
      const candidates = closestAllowedCandidates(name, binds, (s) => s, { maxResults: 5 });
      const block = formatCandidateList(candidates, {
        header: `Declared prereq binds (${binds.length})`,
      });
      problems.push(
        `literal_provenance["${item.path}"] = {prereq_output: "${name}"} but no prereq binds a value with binds: "${name}". Add the prereq or reclassify.${block}`,
      );
    }
    return problems;
  }
  return [
    `literal_provenance["${item.path}"] is not a valid classification. Use "static" | {caller_input: "<param>"} | {prereq_output: "<binds>"} | "single_entity".`,
  ];
}

/** Inline-lookup detector for the audit path. Returns the first js-eval or
 *  fetch-extract prereq whose URL (or fetch literal inside a js-eval
 *  expression) points at a `/search` or `/lookup` path segment, else null.
 *  Used to reject capability_name_justification when the agent is pairing a
 *  lookup-implying slug with an inline lookup prereq — that combination has
 *  no legitimate justification shape, because the correct fix is always
 *  "split the lookup into its own capability." */
const INLINE_LOOKUP_PATH_RE = /\/(search|lookup)(?:\/|\?|$)/i;

function findInlineLookupPrereq(data: Strategy): { name: string; url: string } | null {
  const fetchRe = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g;
  const matchesLookup = (url: string): boolean => {
    let pathish = url;
    try {
      pathish = new URL(url).pathname;
    } catch {
      // keep raw — INLINE_LOOKUP_PATH_RE still matches on `/search/` substrings
    }
    return INLINE_LOOKUP_PATH_RE.test(pathish);
  };

  // URL-field layer: prereq.url on js-eval / fetch-extract.
  const prereqs = (data as Record<string, unknown>).prerequisites;
  if (Array.isArray(prereqs)) {
    const prereqList = prereqs as unknown[];
    for (let idx = 0; idx < prereqList.length; idx += 1) {
      const p = prereqList[idx];
      if (!p || typeof p !== 'object') continue;
      const rec = p as Record<string, unknown>;
      const kind = rec.kind;
      if (kind !== 'js-eval' && kind !== 'fetch-extract') continue;
      if (typeof rec.url !== 'string' || rec.url.length === 0) continue;
      if (!matchesLookup(rec.url)) continue;
      const name = typeof rec.name === 'string' ? rec.name : `prerequisites[${idx}]`;
      return { name, url: rec.url };
    }
  }

  // Executable-JS-string layer: scan every JS body on the strategy (prereq
  // expressions, top-level script / expression, frameFromPage.expression) for
  // fetch('/search…') literals.
  for (const { location, text } of collectExecutableJsStrings(data)) {
    fetchRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = fetchRe.exec(text)) !== null) {
      const url = m[2];
      if (!url) continue;
      if (matchesLookup(url)) {
        return { name: location, url };
      }
    }
  }

  return null;
}

export function validateNameJustification(
  capability: string,
  data: Strategy,
  justification: string | undefined,
): string[] {
  const segments = findLookupSegments(capability);
  if (segments.length === 0) return [];

  // Harden: a lookup-implying slug paired with an inline-lookup prereq has
  // no legitimate justification shape. The `_by_/_for_/lookup_` slug + an
  // inline js-eval/fetch-extract against `/search` or `/lookup` is exactly
  // the anti-pattern the split-into-a-capability rule exists to catch;
  // accepting a free-text justification here lets the agent argue past the
  // runtime check with canned prose. Reject regardless of what the agent
  // wrote in capability_name_justification.
  const inlineLookup = findInlineLookupPrereq(data);
  if (inlineLookup) {
    return [
      `capability slug "${capability}" has a lookup-implying segment AND declares an inline lookup prereq ` +
        `("${inlineLookup.name}" fetches ${inlineLookup.url}). Justification is not accepted in this combination ` +
        `— the pattern klura wants is to save the lookup as its own capability and declare a ` +
        `{kind: "capability", ...} prereq. Remove the inline lookup OR rename this capability to remove the ` +
        `_by_/_for_ segment.`,
    ];
  }

  if (hasLookupShapedPrereq(data)) return [];
  const justText = (justification ?? '').trim();
  if (justText.length === 0) {
    return [
      `capability name "${capability}" contains lookup-implying segment(s) [${segments.join(
        ', ',
      )}] but the strategy has no prereq with kind "capability" or "fetch-extract". Either add a lookup prereq, or provide a non-empty capability_name_justification explaining why the name is accurate without one.`,
    ];
  }
  return [];
}

export function validateObservedSiblings(
  siblings: ObservedSiblingItem[],
  answers: Record<string, string> | undefined,
): string[] {
  if (siblings.length === 0) return [];
  const issues: string[] = [];
  const given = answers ?? {};
  for (const sib of siblings) {
    const a = given[sib.key];
    if (typeof a !== 'string' || a.trim().length === 0) {
      issues.push(
        `observed_siblings["${sib.key}"] missing — for ${sib.method} ${sib.url}, answer "recorded" (you called record_observed_capability this session) or "not_worth_recording:<one-sentence reason>"`,
      );
      continue;
    }
    const trimmed = a.trim();
    if (trimmed === 'recorded') continue;
    if (
      /^not_worth_recording:\S/.test(trimmed) &&
      trimmed.length > 'not_worth_recording:'.length + 1
    ) {
      continue;
    }
    issues.push(
      `observed_siblings["${sib.key}"] = ${JSON.stringify(a)} is malformed. Use "recorded" or "not_worth_recording:<reason>" (reason must be non-empty).`,
    );
  }
  return issues;
}

// ---------- Gate factory ----------

export interface SaveAuditContext {
  capability: string;
  observedSiblings: ObservedSiblingItem[];
  /** Per-param observations gathered during the session. Keyed by param
   *  name; each entry is a `{value, label, source}` tuple the correlator
   *  recorded. Feeds the enum-param consistency check: when the agent
   *  declares `notes.params[X].kind === "enum"` with `observed_values`,
   *  every declared entry must match a recorded observation here. Empty
   *  object / missing key → no grounding available → any enum declaration
   *  must use Path B (`source: "capability:<slug>"`). */
  observedParamValues?: Record<string, ParamObservation[]>;
  /** All endpoint URLs captured during the session. Used to enforce that
   *  a prereq whose URL matches captured traffic AND whose parent
   *  capability has a lookup-implying slug must be routed via
   *  `{kind: "capability"}` rather than inlined. Comparison is on
   *  origin + pathname (query ignored, since agents parameterize query).
   *  Caller (index.ts) builds this from
   *  `driver.getInterceptedRequests(session)`. */
  capturedEndpointPaths?: Set<string>;
  /** Per-session set of strings the agent has been shown via tool
   *  responses. The audit's literal_provenance step uses it to reject
   *  `static` classifications on values the agent OBSERVED at runtime —
   *  observed values are by-construction not contract, so they need a
   *  prereq_output or caller_input classification. See
   *  runtime/src/response/observation-trace.ts. */
  observedStrings?: Set<string>;
}

// ---------- Enum-param consistency (axis A extension) ----------

interface NotesParam {
  kind?: string;
  example?: string;
  observed_values?: Array<{ value: string; label: string }>;
  source?: string;
  /** Required when kind is "text" but the runtime has UI-click
   *  observations for this param — the agent must explain why clicks
   *  happen to flow through this param yet it's still free text (rare;
   *  e.g. a search input triggers on Enter but the same endpoint is ALSO
   *  clickable via suggestion tiles). Tamper-evident paper trail, same
   *  rationale as save_warnings_acked reasons. */
  text_kind_justification?: string;
}

function getDeclaredParam(data: Strategy, name: string): NotesParam | null {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return null;
  const p = params[name];
  if (!p || typeof p !== 'object') return null;
  return p as NotesParam;
}

function validateEnumParam(
  paramName: string,
  declared: NotesParam,
  observations: ParamObservation[],
): string[] {
  const issues: string[] = [];

  // Path B: agent opts into a `capability:<slug>` source — the resolution
  // is deferred to a prereq at execute time. Audit accepts without
  // observed_values; the agent can save the sibling capability separately.
  if (typeof declared.source === 'string' && declared.source.startsWith('capability:')) {
    const target = declared.source.slice('capability:'.length).trim();
    if (target.length === 0) {
      issues.push(
        `notes.params.${paramName}.source = "capability:" is missing the target capability slug. Use "capability:<slug>" pointing at a saved list_<entity> strategy.`,
      );
    }
    return issues;
  }

  // Path A: static observed_values grounded in captures.
  const values: unknown[] | null = Array.isArray(declared.observed_values)
    ? (declared.observed_values as unknown[])
    : null;
  if (!values || values.length === 0) {
    issues.push(
      `notes.params.${paramName}.kind === "enum" requires either observed_values: [{value, label}, ...] grounded in captured traffic, OR source: "capability:<slug>" pointing at a saved list_<entity> strategy that fetches fresh values at execute time. Neither was declared.`,
    );
    return issues;
  }

  // Build a fast lookup of observed (value, label) pairs for this param.
  const observedPairs = new Set(observations.map((o) => `${o.value}\x00${o.source.label}`));
  const observedValuesOnly = new Set(observations.map((o) => o.value));

  values.forEach((rawEntry, idx) => {
    if (!rawEntry || typeof rawEntry !== 'object') {
      issues.push(`notes.params.${paramName}.observed_values[${idx}] is not an object`);
      return;
    }
    const entry = rawEntry as { value?: unknown; label?: unknown };
    const entryValue = entry.value;
    const entryLabel = entry.label;
    if (typeof entryValue !== 'string' || entryValue.length === 0) {
      issues.push(
        `notes.params.${paramName}.observed_values[${idx}].value must be a non-empty string`,
      );
      return;
    }
    if (typeof entryLabel !== 'string' || entryLabel.length === 0) {
      issues.push(
        `notes.params.${paramName}.observed_values[${idx}].label must be a non-empty string (the user-visible text, e.g. the clicked-tile label or an API response's human-readable field)`,
      );
      return;
    }
    // Ground-truth check: the value must have been observed at all.
    if (!observedValuesOnly.has(entryValue)) {
      issues.push(
        `notes.params.${paramName}.observed_values[${idx}].value = ${JSON.stringify(entryValue)} was not observed in captured traffic for this param during the session. Either (a) re-do the discovery step that surfaces this value so the runtime captures it, or (b) remove this entry. Runtime cannot accept fabricated enum values.`,
      );
      return;
    }
    // Stronger check: the (value, label) pair must have been observed together.
    const key = `${entryValue}\x00${entryLabel}`;
    if (!observedPairs.has(key)) {
      const realLabels = observations
        .filter((o) => o.value === entryValue)
        .map((o) => JSON.stringify(o.source.label));
      issues.push(
        `notes.params.${paramName}.observed_values[${idx}] = {value: ${JSON.stringify(
          entryValue,
        )}, label: ${JSON.stringify(
          entryLabel,
        )}} — the value is real but the label is FABRICATED. The runtime captured the click that produced value=${JSON.stringify(entryValue)} and the actual label was [${realLabels.join(', ')}]. ` +
          `Replace label=${JSON.stringify(entryLabel)} with one of the observed labels VERBATIM (copy-paste, including any emoji / themed wording). ` +
          `The label is what warm-execute fuzzy-matches the caller's natural-language intent against — collapsing the site's themed copy ${realLabels[0] ?? '"<observed>"'} to a generic re-stating like ${JSON.stringify(entryLabel)} loses the bridge that lets warm callers map their phrasing to the right value. ` +
          `Do NOT escape this rejection by removing the param, switching to kind:"text", or adding a text_kind_justification — the fix is "use the real label."`,
      );
    }
  });

  return issues;
}

function hasUiClickObservations(observations: ParamObservation[]): boolean {
  return observations.some((o) => o.source.kind === 'ui_click');
}

function validateCallerInputParamKind(
  paramName: string,
  declared: NotesParam,
  observations: ParamObservation[],
): string[] {
  const issues: string[] = [];
  const kind = declared.kind;
  if (typeof kind !== 'string' || kind.trim().length === 0) {
    issues.push(
      `notes.params.${paramName}.kind is required for a caller_input param. ` +
        `Declare "enum" (value is selected from a discoverable set — the param's observations show which) or "text" (free-form input, e.g. a person's name typed verbatim). ` +
        `If this param was observed via UI clicks during discovery, "enum" is almost always the right answer.`,
    );
    return issues;
  }
  if (kind === 'enum') {
    issues.push(...validateEnumParam(paramName, declared, observations));
    return issues;
  }
  // Non-enum kind with UI-click observations is suspicious — clicks don't
  // fire for free-text params, they fire for selectable options. Three-layer
  // gate to stop "I'll just classify it as text and move on" canned escapes:
  //   1. Justification must exist and be substantive (>= TEXT_KIND_MIN_CHARS).
  //   2. Justification must reference at least one observed click label
  //      verbatim — proves the agent read the captured signal, not a canned
  //      "category is a slug accepted as free-form" excuse. Same anti-canned
  //      mechanism as observedLiteralValuesDetector.validateAck.
  //   3. The legitimate text+clicks pattern is a search endpoint hit by BOTH
  //      typed queries AND suggestion-tile clicks. Structural evidence: the
  //      same param appears in observations OR captured requests with at
  //      least one value that's NOT in the ui-click set. Without that, the
  //      param has only ever been observed via clicks — it IS an enum and
  //      the agent must ground it.
  if (hasUiClickObservations(observations)) {
    const labels = Array.from(
      new Set(observations.filter((o) => o.source.kind === 'ui_click').map((o) => o.source.label)),
    );
    const clickValues = new Set(
      observations.filter((o) => o.source.kind === 'ui_click').map((o) => o.value),
    );
    const hasNonClickObservation = observations.some(
      (o) => o.source.kind !== 'ui_click' || !clickValues.has(o.value),
    );
    const just = declared.text_kind_justification;
    const baseReject =
      `notes.params.${paramName}.kind = ${JSON.stringify(kind)} but this param was observed via UI click(s) during discovery — clicks imply a selectable option set, not free text. ` +
      `STRONGLY PREFERRED FIX: reclassify as kind: "enum" with observed_values grounded in the captured (value, label) pairs. ` +
      `Warm-execute then fuzzy-matches the caller's natural-language intent against the captured labels to pick a value — without grounded labels, downstream callers will pass the user's literal phrase to the API and the call fails. ` +
      `Do NOT take the text_kind_justification path unless this param genuinely accepts free-form input from a different code path on the same site.\n\n` +
      `Observed click labels for this param: [${labels
        .slice(0, 5)
        .map((l) => JSON.stringify(l))
        .join(', ')}]`;

    if (!hasNonClickObservation) {
      // No structural evidence the param is ever NOT click-derived. The
      // text_kind_justification path is closed for this param — there's no
      // honest justification a "search box that ALSO fires this XHR" exists
      // because the runtime never observed one.
      if (typeof just !== 'string' || just.trim().length === 0) {
        issues.push(
          `${baseReject}\n\nThe text_kind_justification escape hatch is NOT available for this param — every observation in this session was a UI click. There is no captured non-click traffic for "${paramName}" that would justify "free-form text." Reclassify as kind: "enum".`,
        );
      } else {
        issues.push(
          `${baseReject}\n\nYou supplied text_kind_justification = ${JSON.stringify(just.slice(0, 200))} but every observation for "${paramName}" in this session was a UI click — there is no captured non-click traffic that supports "free-form text." Reclassify as kind: "enum"; the justification path is not available here.`,
        );
      }
      return issues;
    }

    // Structural evidence exists (the param fires from non-click traffic too).
    // Justification path is open, but tighten the bar to stop canned excuses.
    if (typeof just !== 'string' || just.trim().length === 0) {
      issues.push(
        `${baseReject}\n\nIf taking the text_kind_justification path, set notes.params.${paramName}.text_kind_justification to a >= ${TEXT_KIND_MIN_CHARS}-char sentence that names at least one observed click label verbatim AND describes the non-click traffic shape that makes "${paramName}" genuinely free-form (e.g. "search endpoint fires from typed input + suggestion-tile clicks; clicked tile labels include " + one of [${labels
          .slice(0, 3)
          .map((l) => JSON.stringify(l))
          .join(', ')}]).`,
      );
    } else if (just.trim().length < TEXT_KIND_MIN_CHARS) {
      issues.push(
        `${baseReject}\n\ntext_kind_justification = ${JSON.stringify(just)} is too short (< ${TEXT_KIND_MIN_CHARS} chars) — a substantive justification names at least one observed click label verbatim AND describes the non-click traffic shape. A canned "this is a slug accepted as free-form" doesn't pass.`,
      );
    } else if (!labels.some((l) => just.includes(l))) {
      issues.push(
        `${baseReject}\n\ntext_kind_justification must reference at least one observed click label verbatim (proves you read the captured signal, not a canned excuse). Observed labels for this param: [${labels
          .slice(0, 5)
          .map((l) => JSON.stringify(l))
          .join(', ')}].`,
      );
    }
  }
  return issues;
}

const TEXT_KIND_MIN_CHARS = 60;

export function validateCallerInputKindsAndEnums(
  data: Strategy,
  provenance: Record<string, LiteralClassification>,
  observedParamValues: Record<string, ParamObservation[]>,
): string[] {
  const callerInputParams = new Set<string>();
  for (const classification of Object.values(provenance)) {
    if (typeof classification === 'object' && 'caller_input' in classification) {
      callerInputParams.add(classification.caller_input);
    }
  }
  const issues: string[] = [];
  for (const paramName of callerInputParams) {
    const declared = getDeclaredParam(data, paramName);
    if (!declared) continue; // notes.params-missing is handled by the existing literal check.
    // Observations are recorded under the WIRE-level param name (`category`
    // for `?category=italian`), but the agent's notes.params is keyed by the
    // PLACEHOLDER name (`{{cuisine}}`). Look up under both so a renamed
    // placeholder doesn't silently drop the UI-click-observation signal that
    // drives the must-be-enum / observed_values audit gates.
    const observations = [
      ...(observedParamValues[paramName] ?? []),
      ...wireParamNamesForPlaceholder(data, paramName).flatMap(
        (wire) => observedParamValues[wire] ?? [],
      ),
    ];
    issues.push(...validateCallerInputParamKind(paramName, declared, observations));
  }
  return issues;
}
