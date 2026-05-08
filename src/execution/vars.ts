// Variable, template, header, and endpoint resolution — pure utilities shared
// across the fetch, page-script, recorded-path, and websocket executors. No
// pool access, no page access; stringly-typed in, stringly- typed out.

import { getIdentity } from '../identity/identities';
import { resolveSecrets } from '../identity/secrets';
import { extractFromHtml } from '../response/html-extract';
import { lookupPlaceholderPath, replacePlaceholders } from '../execution/placeholders';

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
export function interpolateVars(
  s: string,
  args: Record<string, unknown>,
  encode = false,
  jsonEscape = false,
): string {
  return replacePlaceholders(s, (path, match) => {
    const value = lookupPlaceholderPath(args, path);
    if (value === undefined) return match;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
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
  return JSON.parse(json) as T;
}

function resolveEndpoint(baseUrl: string, template: string, args: Record<string, unknown>): string {
  // Support both `:key` (REST style) and `{{key}}` (template style),
  // URL-encoded.
  let resolved = template;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' || typeof value === 'number') {
      resolved = resolved.split(`:${key}`).join(encodeURIComponent(String(value)));
    }
  }
  resolved = resolveSecrets(interpolateVars(resolved, args, true));
  // Also interpolate placeholders in baseUrl. Agents legitimately embed
  // per-caller slugs in the origin path (e.g. `https://host/@{{username}}`)
  // when a site's API uses the canonical user page URL as its "base." Per docs,
  // "if the LLM keeps making the same mistake, the runtime is wrong":
  // substituting here is the LLM-friendly fix — the alternative would require
  // agents to keep templates out of baseUrl, which isn't documented and isn't
  // obvious from the shape.
  const resolvedBase = resolveSecrets(interpolateVars(baseUrl, args));
  return joinBaseAndPath(resolvedBase, resolved);
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
): Record<string, unknown> {
  // jsonEscape=true: interpolated values go through a stringify → interpolate →
  // parse round-trip, and raw values containing `"` or `\` would break
  // JSON.parse. Same bug pattern as resolveVariables — concrete case: MediaWiki
  // CSRF tokens end with a literal `\` and `"token":"{{csrf_token}}"` becomes
  // `"token":"...+\"` without escape, which reads as unterminated-string.
  const json = resolveSecrets(interpolateVars(JSON.stringify(template), args, false, true));
  return JSON.parse(json) as Record<string, unknown>;
}

export function resolveHeaders(
  template: Record<string, string> | undefined,
  args: Record<string, unknown>,
): Record<string, string> {
  if (!template) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(template)) {
    out[k] = resolveSecrets(interpolateVars(v, args));
  }
  return out;
}

export function resolveBrowserPrereqStep<T extends Record<string, unknown>>(
  step: T,
  args: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...step };
  for (const field of ['url', 'selector', 'attribute', 'value'] as const) {
    const raw = step[field];
    if (typeof raw !== 'string') continue;
    out[field] = resolveSecrets(interpolateVars(raw, args));
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
  },
  args: Record<string, unknown>,
): PreparedRequest {
  const method = (strategy.method ?? strategy.endpoint.split(' ')[0] ?? 'GET').toUpperCase();
  const endpointPath = strategy.endpoint.includes(' ')
    ? strategy.endpoint.split(' ').slice(1).join(' ')
    : strategy.endpoint;
  const resolvedArgs = strategy.params ? { ...args, ...resolveBody(strategy.params, args) } : args;
  const url = resolveEndpoint(strategy.baseUrl, endpointPath, resolvedArgs);
  const bodyObj = strategy.body ? resolveBody(strategy.body, args) : undefined;
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
