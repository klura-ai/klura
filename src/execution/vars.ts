// Variable, template, header, and endpoint resolution — pure utilities shared
// across the fetch, page-script, recorded-path, and websocket executors. No
// pool access, no page access; stringly-typed in, stringly- typed out.

import { getIdentity } from '../identity/identities';
import { resolveSecrets } from '../identity/secrets';
import { extractFromHtml } from '../response/html-extract';
import {
  collectInlinePlaceholderRefs,
  lookupPlaceholderPath,
  normalizeUrlColonPlaceholders,
  replacePlaceholders,
} from '../execution/placeholders';
import { FactoryExecutionStateError } from './result-classification';

// Walk a dotted path into a nested object. Supports `response.items[0].node_id`
// style. Returns undefined if the path doesn't resolve, or if the final value
// isn't a string/number (we stringify numbers since request bodies expect
// strings). Used by the fetch-extract prereq executor.
export function extractByPath(obj: unknown, path: string): string | undefined {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const rawPart of parts) {
    if (cur === null || cur === undefined) return undefined;
    // Handle `key[0]` array indexing in one segment.
    const arrMatch = /^([^[]*)(\[(\d+)\])+$/.exec(rawPart);
    if (arrMatch) {
      const key = arrMatch[1] ?? '';
      if (key.length > 0) {
        if (typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[key];
      }
      const idxMatches = rawPart.matchAll(/\[(\d+)\]/g);
      for (const m of idxMatches) {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[Number(m[1])];
      }
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[rawPart];
  }
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return undefined;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

// Replace every `{{path}}` occurrence in s with the looked-up value. Used by
// resolveBody / resolveHeaders / resolveVariables / resolveEndpoint.
//
// `encode` = URL-encode the substituted value (for endpoint / query-string
// templates). `jsonEscape` = JSON-escape the value (for templates that will be
// JSON.parsed after substitution — the resolveVariables hot path). Both are off
// by default; at most one is meaningful at a time.
//
// Without jsonEscape, values containing a backslash or quote break
// resolveVariables' stringify → interpolate → parse round-trip. Concrete case:
// MediaWiki CSRF tokens end with `+\` (real trailing backslash); a template
// like `"token":"{{csrf_token}}"` after raw substitution becomes
// `"token":"...+\"` — the backslash escapes the closing quote, producing
// unterminated-string at JSON.parse.
/** Encode a value destined for a URL PATH: encode each `/`-delimited segment
 *  with encodeURIComponent but keep the `/` separators, so a value that is
 *  itself a path (e.g. `/items` minted by a page-extract prereq) keeps its
 *  structure instead of collapsing to `%2Fitems`. Query-position values still
 *  use full encodeURIComponent (a `/` there is data, and `&`/`=` must escape). */
function encodePathSegments(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/');
}

export function interpolateVars(
  s: string,
  args: Record<string, unknown>,
  encode: boolean | 'path' = false,
  jsonEscape = false,
): string {
  return replacePlaceholders(s, (path, match) => {
    const value = lookupPlaceholderPath(args, path);
    if (isMissingTemplateValue(value)) return match;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (encode === 'path') return encodePathSegments(str);
    if (encode) return encodeURIComponent(str);
    if (jsonEscape) {
      // JSON.stringify yields a quoted, fully-escaped JSON string
      // (`"foo\\bar"`); slice the outer quotes so the substitution lands
      // cleanly inside an existing string literal.
      return JSON.stringify(str).slice(1, -1);
    }
    return str;
  });
}

function isMissingTemplateValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function isEmptyOptionalContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

export function unresolvedPlaceholderNames(value: string): string[] {
  return [...collectInlinePlaceholderRefs(value)].sort((a, b) => a.localeCompare(b));
}

export function assertNoUnresolvedPlaceholders(value: string, field: string): void {
  const unresolved = unresolvedPlaceholderNames(value);
  if (unresolved.length === 0) return;
  throw new FactoryExecutionStateError(
    'not_run',
    'unresolved_placeholders',
    `unresolved_placeholders: ${field} still contains ${unresolved
      .map((name) => `{{${name}}}`)
      .join(', ')} after argument and prerequisite resolution; request not sent`,
    { field, unresolved },
  );
}

export function omittedOptionalParamNames(
  strategy: { notes?: unknown },
  args: Record<string, unknown>,
): ReadonlySet<string> {
  const notes = strategy.notes;
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return new Set();
  const params = (notes as { params?: unknown }).params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return new Set();
  const omitted = new Set<string>();
  for (const [name, doc] of Object.entries(params as Record<string, unknown>)) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
    if ((doc as { optional?: unknown }).optional !== true) continue;
    const value = lookupPlaceholderPath(args, name);
    if (isMissingTemplateValue(value) || isEmptyOptionalContainer(value)) omitted.add(name);
  }
  return omitted;
}

const OMIT_OPTIONAL_VALUE = Symbol('omit_optional_value');

function omittedOptionalRoot(
  ref: string,
  omittedOptionalParams: ReadonlySet<string>,
): string | undefined {
  if (omittedOptionalParams.has(ref)) return ref;
  const dot = ref.indexOf('.');
  if (dot <= 0) return undefined;
  const root = ref.slice(0, dot);
  return omittedOptionalParams.has(root) ? root : undefined;
}

function pruneOmittedOptionalValues(
  value: unknown,
  omittedOptionalParams: ReadonlySet<string>,
  args: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const refs = [...collectInlinePlaceholderRefs(value)];
    if (
      refs.length === 1 &&
      value === `{{${refs[0]}}}` &&
      omittedOptionalRoot(refs[0] ?? '', omittedOptionalParams) !== undefined &&
      isMissingTemplateValue(lookupPlaceholderPath(args, refs[0] ?? ''))
    ) {
      return OMIT_OPTIONAL_VALUE;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      const pruned = pruneOmittedOptionalValues(entry, omittedOptionalParams, args);
      // Removing an array element shifts positional meaning. Keep the original
      // unresolved token so the transport guard rejects it instead.
      out.push(pruned === OMIT_OPTIONAL_VALUE ? entry : pruned);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneOmittedOptionalValues(entry, omittedOptionalParams, args);
      if (pruned !== OMIT_OPTIONAL_VALUE) out[key] = pruned;
    }
    return out;
  }
  return value;
}

export function mergeWithIdentity(
  args: Record<string, unknown>,
  platform: string,
  identity?: string,
): Record<string, unknown> {
  const profile = getIdentity(platform, identity);
  return { ...profile, ...args };
}

export function resolveVariables<T>(step: T, args: Record<string, unknown>): T {
  const json = resolveSecrets(interpolateVars(JSON.stringify(step), args, false, true));
  assertNoUnresolvedPlaceholders(json, 'recorded-path step');
  return JSON.parse(json) as T;
}

// Resolve the query-string portion of a URL template. Only an exact
// `key={{ref}}` value declared optional may disappear. Required refs and
// embedded optional refs stay unresolved so the final transport guard rejects
// them instead of changing `after:{{cursor}}` into `after:`.
function resolveQueryString(
  queryPart: string,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string>,
): string {
  const leading = queryPart.startsWith('?') ? '?' : '';
  const raw = leading ? queryPart.slice(1) : queryPart;
  if (raw.length === 0) return queryPart;
  const resolveSegmentPart = (template: string): string => interpolateVars(template, args, true);
  const kept: string[] = [];
  for (const segment of raw.split('&')) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf('=');
    if (eq === -1) {
      kept.push(resolveSegmentPart(segment));
      continue;
    }
    const key = resolveSegmentPart(segment.slice(0, eq));
    const valueTemplate = segment.slice(eq + 1);
    const refs = [...collectInlinePlaceholderRefs(valueTemplate)];
    const exactRef = refs.length === 1 && valueTemplate === `{{${refs[0]}}}` ? refs[0] : undefined;
    if (
      exactRef &&
      omittedOptionalRoot(exactRef, omittedOptionalParams) !== undefined &&
      isMissingTemplateValue(lookupPlaceholderPath(args, exactRef))
    ) {
      continue;
    }
    const value = resolveSegmentPart(valueTemplate);
    kept.push(`${key}=${value}`);
  }
  if (kept.length === 0) return '';
  return `${leading}${kept.join('&')}`;
}

export function renderUrlTemplate(
  template: string,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string> = new Set(),
): string {
  const normalizedTemplate = normalizeUrlColonPlaceholders(template);
  const refs = [...collectInlinePlaceholderRefs(normalizedTemplate)];
  if (refs.length === 1 && normalizedTemplate === `{{${refs[0]}}}`) {
    const value = lookupPlaceholderPath(args, refs[0] ?? '');
    if (!isMissingTemplateValue(value)) {
      return resolveSecrets(typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  // Support both `:key` (REST style) and `{{key}}` (template style). Encode
  // position-aware: tokens in the PATH keep `/` separators (a value that is a
  // path, e.g. `/items` from a page-extract, must not become `%2Fitems`);
  // tokens in the QUERY use full encodeURIComponent (`&`/`=`/`/` are data there).
  const qIdx = normalizedTemplate.indexOf('?');
  const pathPart = qIdx === -1 ? normalizedTemplate : normalizedTemplate.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : normalizedTemplate.slice(qIdx); // keeps the leading '?'
  return resolveSecrets(
    interpolateVars(pathPart, args, 'path') +
      resolveQueryString(queryPart, args, omittedOptionalParams),
  );
}

export function resolveUrlTemplate(
  template: string,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string>,
  field: string,
): string {
  const resolved = renderUrlTemplate(template, args, omittedOptionalParams);
  assertNoUnresolvedPlaceholders(resolved, field);
  return resolved;
}

function resolveEndpoint(
  baseUrl: string,
  template: string,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string>,
): string {
  const resolved = resolveUrlTemplate(template, args, omittedOptionalParams, 'request URL');
  // Also interpolate placeholders in baseUrl. Agents legitimately embed
  // per-caller slugs in the origin path (e.g. `https://host/@{{username}}`)
  // when a site's API uses the canonical user page URL as its "base." Per docs,
  // "if the LLM keeps making the same mistake, the runtime is wrong":
  // substituting here is the LLM-friendly fix — the alternative would require
  // agents to keep templates out of baseUrl, which isn't documented and isn't
  // obvious from the shape.
  const resolvedBase = resolveUrlTemplate(baseUrl, args, omittedOptionalParams, 'request base URL');
  const url = joinBaseAndPath(resolvedBase, resolved);
  assertNoUnresolvedPlaceholders(url, 'request URL');
  return url;
}

// Combine a baseUrl and an endpoint template using WHATWG URL resolution
// semantics (RFC 3986 §5.3) rather than plain string concat. This is the
// resolution agents expect from training on every URL library in the
// universe — and the one they keep reaching for. Semantics:
//   - endpoint = absolute URL ("https://x/y")     → returns endpoint as-is
//   - endpoint = rooted path ("/api/x")            → replaces base's path
//   - endpoint = relative path ("api/x")           → resolves against
//                                                    base's dir
//   - endpoint = query ("?q=1")                    → replaces base's query
//   - endpoint = empty                             → returns base as-is
// Falls back to the historical concat when `new URL()` rejects the
// inputs (weird opaque schemes, non-URL baseUrl); better to produce
// something than crash at execute time with an obscure URL error.
export function joinBaseAndPath(base: string, path: string): string {
  if (!base) return path;
  if (!path) return base;
  try {
    return new URL(path, base).toString();
  } catch {
    // RFC-3986-ish fallback: if the path is rooted, keep only the scheme+host
    // from the base; otherwise concat with a single slash.
    const rooted = path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path);
    if (rooted && /^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
    if (rooted) {
      const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(base);
      const scheme = m?.[1];
      return scheme !== undefined ? scheme + path : trimTrailingSlashes(base) + path;
    }
    return trimTrailingSlashes(base) + '/' + path;
  }
}

// Form-encoding signal inferred from a strategy's Content-Type header. When an
// agent sets `Content-Type: application/x-www-form-urlencoded` in the headers
// but forgets the top-level `contentType: "form"` field, the request body would
// otherwise be JSON-stringified — the declared header lies about the wire shape
// and the server rejects. Case-insensitive match; charset / boundary params are
// tolerated.
function strategyHeadersDeclareForm(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'content-type') continue;
    if (typeof v === 'string' && /application\/x-www-form-urlencoded/i.test(v)) return true;
  }
  return false;
}

export function resolveBody(
  template: Record<string, unknown>,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const pruned = pruneOmittedOptionalValues(template, omittedOptionalParams, args);
  const resolveValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const refs = [...collectInlinePlaceholderRefs(value)];
      if (refs.length === 1 && value === `{{${refs[0]}}}`) {
        const resolved = lookupPlaceholderPath(args, refs[0] ?? '');
        if (resolved !== undefined && resolved !== '') return cloneResolvedValue(resolved);
      }
      return resolveSecrets(interpolateVars(value, args));
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [
          key,
          resolveValue(child),
        ]),
      );
    }
    return value;
  };
  const resolved = resolveValue(pruned) as Record<string, unknown>;
  const json = JSON.stringify(resolved);
  assertNoUnresolvedPlaceholders(json, 'request body');
  return resolved;
}

function cloneResolvedValue(value: unknown): unknown {
  if (typeof value === 'string') return resolveSecrets(value);
  if (Array.isArray(value)) return value.map(cloneResolvedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        cloneResolvedValue(child),
      ]),
    );
  }
  return value;
}

export function resolveHeaders(
  template: Record<string, string> | undefined,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string> = new Set(),
): Record<string, string> {
  if (!template) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(template)) {
    const pruned = pruneOmittedOptionalValues(v, omittedOptionalParams, args);
    if (pruned === OMIT_OPTIONAL_VALUE) continue;
    out[k] = resolveSecrets(interpolateVars(v, args));
    assertNoUnresolvedPlaceholders(out[k] ?? '', `request header ${JSON.stringify(k)}`);
  }
  return out;
}

export function resolveBrowserPrereqStep<T extends Record<string, unknown>>(
  step: T,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string> = new Set(),
): T {
  const out: Record<string, unknown> = { ...step };
  for (const field of ['url', 'selector', 'attribute', 'value'] as const) {
    const raw = step[field];
    if (typeof raw !== 'string') continue;
    if (field === 'url') {
      out[field] = resolveUrlTemplate(
        raw,
        args,
        omittedOptionalParams,
        `browser prerequisite ${field}`,
      );
      continue;
    }
    if (pruneOmittedOptionalValues(raw, omittedOptionalParams, args) === OMIT_OPTIONAL_VALUE) {
      Reflect.deleteProperty(out, field);
      continue;
    }
    out[field] = resolveSecrets(interpolateVars(raw, args));
    assertNoUnresolvedPlaceholders(String(out[field]), `browser prerequisite ${field}`);
  }
  return out as T;
}

export interface PreparedRequest {
  method: string;
  url: string;
  isForm: boolean;
  bodyObj: Record<string, unknown> | undefined;
  serializedBody: string | undefined;
}

// Build the wire-level request shape (method, resolved URL, serialized body)
// from a strategy + args. Transport-agnostic; both Node and in-browser
// executors start from this and diverge at header synthesis and transport.
export function prepareRequest(
  strategy: {
    method?: string;
    endpoint: string;
    baseUrl: string;
    contentType?: 'json' | 'form';
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    params?: Record<string, unknown>;
    notes?: unknown;
  },
  args: Record<string, unknown>,
): PreparedRequest {
  const method = (strategy.method ?? strategy.endpoint.split(' ')[0] ?? 'GET').toUpperCase();
  const endpointPath = strategy.endpoint.includes(' ')
    ? strategy.endpoint.split(' ').slice(1).join(' ')
    : strategy.endpoint;
  const omittedOptionalParams = omittedOptionalParamNames(strategy, args);
  const resolvedArgs = strategy.params
    ? { ...args, ...resolveBody(strategy.params, args, omittedOptionalParams) }
    : args;
  const url = resolveEndpoint(strategy.baseUrl, endpointPath, resolvedArgs, omittedOptionalParams);
  const bodyObj = strategy.body
    ? resolveBody(strategy.body, args, omittedOptionalParams)
    : undefined;
  const isForm = strategy.contentType === 'form' || strategyHeadersDeclareForm(strategy.headers);
  let serializedBody: string | undefined;
  if (bodyObj && method !== 'GET') {
    serializedBody = isForm
      ? new URLSearchParams(bodyObj as Record<string, string>).toString()
      : JSON.stringify(bodyObj);
  }
  return { method, url, isForm, bodyObj, serializedBody };
}

export type HtmlExtractResult =
  | { ok: true; body: unknown }
  | { ok: false; code: 'response_format_mismatch' | 'html_extract_failed'; details: string };

// Apply a strategy's response.extract over an HTML body. Returns the original
// body untouched when the strategy didn't request extraction.
export function applyHtmlExtract(
  responseSpec:
    | {
        format?: string;
        extract?: Record<string, { selector: string; attr?: string; multiple?: boolean }>;
      }
    | undefined,
  body: unknown,
): HtmlExtractResult {
  if (!responseSpec || responseSpec.format !== 'html' || !responseSpec.extract) {
    return { ok: true, body };
  }
  if (typeof body !== 'string') {
    return {
      ok: false,
      code: 'response_format_mismatch',
      details: `response.format = "html" but response body is of type ${typeof body}`,
    };
  }
  try {
    return { ok: true, body: extractFromHtml(body, responseSpec.extract) };
  } catch (err) {
    return {
      ok: false,
      code: 'html_extract_failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}
