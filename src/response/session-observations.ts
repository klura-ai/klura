// Per-session accumulator for lookup-shaped candidates detected by
// `lookup-classifier.ts`. Populated PASSIVELY as the agent navigates — every
// captured HTTP request is classified, and if it shape-matches a lookup, a
// LookupCandidate is appended here keyed by session id.
//
// Why passive: agents don't always exercise the search affordance in a
// discovery flow (contacts are often pinned / cached in the sidebar, so the
// normal UX skips search). But during the same navigation, dozens of OTHER
// lookup-shaped calls fire anyway — the initial inbox-load GraphQL query, the
// slug→id HTML navigation, suggestions endpoints, etc. Those all pass through
// here even when the agent never consciously "does" a search. The
// opaque-param validator consults this accumulator at save time to ground-
// truth whether a declared `notes.params[X].example` was actually produced by
// the server.
//
// Module-level state follows the existing pattern used by: -
// saveRejectionsPerSession (skills.ts:~2754) - starter-cache
// (response/starter-cache.ts) - _tryGeneratorStats (Pool) All cleared on
// close_session via symmetric `clearForSession` helpers.

import type { LookupCandidate } from './lookup-classifier';

const PER_SESSION_CAP = 500;
const _observations = new Map<string, LookupCandidate[]>();

// Parallel to `_observations`: a per-session index of raw captured-response
// bodies (and their URLs + postData) for exact-substring search. Used as a
// fallback when JSON parsing fails on the response (XSSI-prefixed, HTML-
// wrapped, binary-framed, etc.) so the opaque-param validator still has a
// ground-truth match source.
//
// Bodies are capped at 200 KB each so a very large response doesn't inflate
// memory; the cap covers typical JSON/HTML responses in full. A runaway
// response (e.g. a CDN serving a huge asset) gets truncated silently; the guard
// falls back to the first 200 KB, which is usually enough.
const RAW_BODY_CAP = 200 * 1024;

interface RawCaptureRecord {
  request_i: number;
  method: string;
  url: string;
  body_snippet: string;
  post_snippet: string;
}

const _rawCaptures = new Map<string, RawCaptureRecord[]>();

// Per-session index of `{param_name, value, label}` tuples observed in
// captured traffic. Populated at capture time by the correlation pipeline:
// for each short-string query/body param on a captured request, runtime
// looks backwards in action history for a preceding click/select and
// records the element text as the label. API-sourced enums also land here
// via the lookup-classifier path (id+label pairs in a JSON response).
//
// Consumed by the pre-save audit's enum-param consistency check: when the
// agent declares `notes.params.X.kind === "enum"` with `observed_values`,
// each declared entry must be present in this index — runtime cannot
// invent observations, but it can verify the agent did not either.
const PARAM_OBS_PER_PARAM_CAP = 500;

export interface ParamObservationSource {
  /** How the observation was derived.
   *   - `ui_click` — click on an a11y-named element preceded the request;
   *     the click's accessible name became the label. Dominant case.
   *   - `api_response` — value surfaced in a JSON response (lookup-
   *     classifier path); the response field value became the label.
   *   - `url_variance` — the same URL path was hit with multiple distinct
   *     values for the same query/path slot during this session. Each
   *     distinct value is one observation; the label is the value
   *     verbatim (no human-friendly name available). Closes the gap
   *     where the agent navigated multiple categories without explicit
   *     clicks (typed URL, followed link, browser back/forward).
   */
  kind: 'ui_click' | 'api_response' | 'url_variance';
  /** Human-visible label — element text for `ui_click`, response-field
   *  value for `api_response`, value-verbatim for `url_variance`. This
   *  is what the agent's warm-execute fuzzy-match compares against
   *  user intent. */
  label: string;
  /** For ui_click: the captured request index whose preceding action
   *  yielded the label. For api_response: the captured request whose
   *  response body carried the `{value, label}` pair. For url_variance:
   *  the captured request whose URL contributed this distinct value.
   *  Either way it's a pointer into the session's intercepted-requests
   *  array. */
  request_i?: number;
}

export interface ParamObservation {
  param_name: string;
  value: string;
  source: ParamObservationSource;
  observed_at: number;
}

const _paramObservations = new Map<string, Map<string, ParamObservation[]>>();

/**
 * Record a `{param_name → value, label, source}` observation for this
 * session. Dedupes on (param_name, value, label) — repeat observations of
 * the same tuple are noise. Caps at PARAM_OBS_PER_PARAM_CAP per param to
 * prevent memory bloat on sessions that iterate the same enum many times.
 */
export function recordParamObservation(sessionId: string, obs: ParamObservation): void {
  if (!sessionId || typeof obs.param_name !== 'string' || obs.param_name.length === 0) {
    if (process.env.KLURA_DEBUG_PARAM_OBS)
      console.error(`[param-obs] reject: empty sessionId/name for obs=${JSON.stringify(obs)}`);
    return;
  }
  if (typeof obs.value !== 'string' || obs.value.length === 0) {
    if (process.env.KLURA_DEBUG_PARAM_OBS)
      console.error(`[param-obs] reject: empty value for obs=${JSON.stringify(obs)}`);
    return;
  }
  if (typeof obs.source.label !== 'string' || obs.source.label.length === 0) {
    if (process.env.KLURA_DEBUG_PARAM_OBS)
      console.error(`[param-obs] reject: empty label for obs=${JSON.stringify(obs)}`);
    return;
  }
  if (process.env.KLURA_DEBUG_PARAM_OBS)
    console.error(
      `[param-obs] record sess=${sessionId} ${obs.param_name}=${obs.value} label=${JSON.stringify(obs.source.label)}`,
    );

  let perSession = _paramObservations.get(sessionId);
  if (!perSession) {
    perSession = new Map();
    _paramObservations.set(sessionId, perSession);
  }
  let list = perSession.get(obs.param_name);
  if (!list) {
    list = [];
    perSession.set(obs.param_name, list);
  }

  // Dedupe on (value, label, source.kind) — same tuple observed twice is
  // noise. Different labels for the same value are meaningful (a category
  // with two UI names — plain "Italian" + themed "Taste the pride of
  // Napoli") and ARE kept as separate entries.
  const isDup = list.some(
    (e) =>
      e.value === obs.value &&
      e.source.kind === obs.source.kind &&
      e.source.label === obs.source.label,
  );
  if (isDup) return;

  if (list.length >= PARAM_OBS_PER_PARAM_CAP) list.shift();
  list.push(obs);
}

/** Read all observations for a given param name in a session. Returns a
 *  defensive copy so callers can sort / filter without mutating state. */
export function findParamObservations(sessionId: string, paramName: string): ParamObservation[] {
  const perSession = _paramObservations.get(sessionId);
  if (!perSession) return [];
  const list = perSession.get(paramName);
  if (!list) return [];
  return list.slice();
}

/** Read the full per-session param-observation map. Used by the save
 *  wrapper to plumb every param's observations into the audit context in
 *  one pass (no O(N) dance in the save path). */
export function getAllParamObservations(sessionId: string): Record<string, ParamObservation[]> {
  const perSession = _paramObservations.get(sessionId);
  if (!perSession) {
    if (process.env.KLURA_DEBUG_PARAM_OBS)
      console.error(`[param-obs] getAll sess=${sessionId} → NONE`);
    return {};
  }
  const out: Record<string, ParamObservation[]> = {};
  for (const [k, v] of perSession) out[k] = v.slice();
  if (process.env.KLURA_DEBUG_PARAM_OBS)
    console.error(
      `[param-obs] getAll sess=${sessionId} → ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.map((o) => ({ v: o.value, l: o.source.label }))])))}`,
    );
  return out;
}

/**
 * Harvest enum-shaped param observations from URL variance across the
 * captured request log. Same param name, same URL path-template, multiple
 * distinct values across the session = a structurally-observed enum.
 * Records one ParamObservation per distinct value (deduped by the existing
 * recordParamObservation logic).
 *
 * Catches the case where the agent navigated the platform via direct URL
 * (typed, browser history, link follow) without clicking a category tile —
 * the click→XHR correlation never fires, so `ui_click` observations stay
 * empty, but the URLs themselves prove the param accepts multiple values.
 *
 * Conservative: requires ≥ 2 distinct values for the SAME (path-template,
 * param-name) pair. A single visit doesn't establish enum-ness.
 *
 * Pure: reads `interceptedRequests`, calls `recordParamObservation` for
 * each new tuple. Idempotent — re-running on the same log is a no-op
 * (recordParamObservation dedupes on (value, label, source.kind)).
 */
export function harvestUrlVarianceObservations(
  sessionId: string,
  interceptedRequests: ReadonlyArray<{ url?: unknown }>,
): void {
  if (!sessionId) return;
  // Group: { pathTemplate → { paramName → Set<value> } }.
  // Path template is `<origin><pathname>` (no query, no fragment) so
  // `?cuisine=italian` and `?cuisine=mexican` share a template.
  const byTemplate = new Map<string, Map<string, Set<string>>>();
  // Track first-seen request index per (template, name, value) for
  // request_i provenance.
  const firstIdx = new Map<string, number>();
  for (let i = 0; i < interceptedRequests.length; i += 1) {
    const raw = interceptedRequests[i];
    const url = raw && typeof raw === 'object' ? (raw as { url?: unknown }).url : undefined;
    if (typeof url !== 'string' || url.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const template = `${parsed.origin}${parsed.pathname}`;
    let perTemplate = byTemplate.get(template);
    if (!perTemplate) {
      perTemplate = new Map();
      byTemplate.set(template, perTemplate);
    }
    for (const [name, value] of parsed.searchParams) {
      if (!name || !value) continue;
      let valuesForName = perTemplate.get(name);
      if (!valuesForName) {
        valuesForName = new Set();
        perTemplate.set(name, valuesForName);
      }
      if (!valuesForName.has(value)) {
        valuesForName.add(value);
        firstIdx.set(`${template}${name}${value}`, i);
      }
    }
  }
  // Emit observations only when a (template, name) pair carries ≥ 2 distinct
  // values — a single observation isn't enum evidence.
  for (const [template, perTemplate] of byTemplate) {
    for (const [name, values] of perTemplate) {
      if (values.size < 2) continue;
      for (const value of values) {
        const idx = firstIdx.get(`${template}${name}${value}`);
        recordParamObservation(sessionId, {
          param_name: name,
          value,
          source: {
            kind: 'url_variance',
            label: value,
            ...(idx !== undefined ? { request_i: idx } : {}),
          },
          observed_at: Date.now(),
        });
      }
    }
  }
}

export function recordLookupCandidate(sessionId: string, candidate: LookupCandidate | null): void {
  if (!sessionId || !candidate) return;
  // Only accumulate entries whose shape suggests a lookup OR whose response
  // contains id-shaped fields that could be matched later. Both gates are
  // loose on ingest — the match path tightens the filter by checking literal
  // equality against `sample_value`.
  if (!candidate.looks_like_lookup && candidate.output_shape.id_fields.length === 0) {
    return;
  }
  let buf = _observations.get(sessionId);
  if (!buf) {
    buf = [];
    _observations.set(sessionId, buf);
  }
  // Replace any prior entry for the same request_i (reclassification on re-read
  // — the network log is populated at capture time but reclassified when the
  // agent calls get_network_log). First occurrence wins for request_i ordering.
  const existingIdx = buf.findIndex((c) => c.request_i === candidate.request_i);
  if (existingIdx >= 0) buf[existingIdx] = candidate;
  else buf.push(candidate);
  if (buf.length > PER_SESSION_CAP) {
    buf.splice(0, buf.length - PER_SESSION_CAP);
  }
}

/**
 * Find every accumulated candidate whose response body contained the given
 * literal value. Matches exact equality on `sample_value` (no prefix /
 * substring).
 *
 * Returns candidates sorted by `lookup_confidence` descending.
 */
export function findCandidatesForLiteral(sessionId: string, literal: string): LookupCandidate[] {
  if (!sessionId || typeof literal !== 'string' || literal.length === 0) return [];
  const buf = _observations.get(sessionId);
  if (!buf) return [];
  const matches: LookupCandidate[] = [];
  for (const candidate of buf) {
    if (candidate.output_shape.id_fields.some((f) => f.sample_value === literal)) {
      matches.push(candidate);
    }
  }
  matches.sort((a, b) => b.lookup_confidence - a.lookup_confidence);
  return matches;
}

/** Return every accumulated candidate for a session (oldest first).
 * Used by diagnostic tools / tests; not typically consumed by the
 *  save-path directly. */
export function getAllCandidates(sessionId: string): LookupCandidate[] {
  const buf = _observations.get(sessionId);
  if (!buf) return [];
  return buf.slice();
}

/** Count of accumulated candidates (all shapes, not just lookup-like). */
export function getCandidateCount(sessionId: string): number {
  const buf = _observations.get(sessionId);
  return buf ? buf.length : 0;
}

/** Record the raw captured bytes for a request so match paths can do
 * exact substring matching against caller-declared literals. The index is
 * shared lineage with `_observations` — same session key, same
 *  PER_SESSION_CAP, cleared together on close_session. */
export function recordRawCapture(
  sessionId: string,
  record: {
    request_i: number;
    method: string;
    url: string;
    response_body: unknown;
    post_data: unknown;
  },
): void {
  if (!sessionId) return;
  let buf = _rawCaptures.get(sessionId);
  if (!buf) {
    buf = [];
    _rawCaptures.set(sessionId, buf);
  }
  const bodyStr = stringifyCapped(record.response_body, RAW_BODY_CAP);
  const postStr = stringifyCapped(record.post_data, RAW_BODY_CAP);
  const existingIdx = buf.findIndex((r) => r.request_i === record.request_i);
  const entry: RawCaptureRecord = {
    request_i: record.request_i,
    method: record.method,
    url: record.url,
    body_snippet: bodyStr,
    post_snippet: postStr,
  };
  if (existingIdx >= 0) buf[existingIdx] = entry;
  else buf.push(entry);
  if (buf.length > PER_SESSION_CAP) {
    buf.splice(0, buf.length - PER_SESSION_CAP);
  }
}

function stringifyCapped(v: unknown, cap: number): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return s.length > cap ? s.slice(0, cap) : s;
}

/**
 * Return every captured request whose response body, post data, or URL contains
 * the literal as a substring. Exact match — no pattern, no shape filter. Used
 * by the opaque-param validator as a ground-truth fallback when JSON parsing
 * fails on the response (XSSI-prefixed, HTML-wrapped, binary-framed, etc.) so
 * the classifier's `_observations` path has no candidate.
 */
export function findRawCaptureMatches(
  sessionId: string,
  literal: string,
): Array<{
  request_i: number;
  method: string;
  url: string;
  match_location: 'response' | 'post_data' | 'url';
}> {
  if (!sessionId || typeof literal !== 'string' || literal.length === 0) return [];
  const buf = _rawCaptures.get(sessionId);
  if (!buf) return [];
  const out: Array<{
    request_i: number;
    method: string;
    url: string;
    match_location: 'response' | 'post_data' | 'url';
  }> = [];
  for (const r of buf) {
    if (r.body_snippet.includes(literal)) {
      out.push({
        request_i: r.request_i,
        method: r.method,
        url: r.url,
        match_location: 'response',
      });
      continue;
    }
    if (r.post_snippet.includes(literal)) {
      out.push({
        request_i: r.request_i,
        method: r.method,
        url: r.url,
        match_location: 'post_data',
      });
      continue;
    }
    if (r.url.includes(literal)) {
      out.push({ request_i: r.request_i, method: r.method, url: r.url, match_location: 'url' });
    }
  }
  return out;
}

/** Clear all accumulated candidates for a session. Called from
 *  `closeSession` in index.ts (pattern matches clearStartersForSession). */
export function clearForSession(sessionId: string): void {
  _observations.delete(sessionId);
  _rawCaptures.delete(sessionId);
  _paramObservations.delete(sessionId);
}

/** Test-only reset. Clears ALL sessions. Exported so vm-sandbox tests
 *  don't leak state between cases. */
export function _resetForTests(): void {
  _observations.clear();
  _rawCaptures.clear();
  _paramObservations.clear();
}
