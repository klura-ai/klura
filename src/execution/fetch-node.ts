// Node HTTP transport — runs fetch() from Node.js without a browser.
//
// Reads the saved strategy headers, device-profile User-Agent +
// Accept-Language, synthesized client hints, and the platform cookie jar.
// Persists any Set-Cookie headers from the response back into the storage-state
// file.
//
// This is the hot path for warm execution — the fetch cliff the race dashboard
// reports. When the Node fire hits a transport-level error it can't satisfy
// (TLS handshake, connection reset, DNS, HTTP/2 protocol), throws
// TransportFailureError; the dispatcher retries the same fetch in-browser via
// `fetch-browser.ts` (fetch/browser) AND records the failure to disk —
// repeated failures eventually demote the saved strategy to page-script for
// future runs.

import * as skills from '../strategies/skills';
import {
  recordNodeTransportFailure as _recordNodeTransportFailure,
  NODE_TRANSPORT_FAIL_THRESHOLD,
} from '../strategies/health';
import { getDeviceProfile, resolveClientHints, DEFAULT_ACCEPT_LANGUAGE } from '../identity/devices';
import { extractFromHtml } from '../response/html-extract';
import {
  applyHtmlExtract,
  extractByPath,
  interpolateVars,
  prepareRequest,
  resolveBody,
  resolveHeaders,
} from './vars';
import type { ExecuteResult, FetchStrategy, Prerequisite, RequestStrategy, AnyPool } from './types';
import type { TokenCache } from '../strategies/tokens';
import { resolveGenerated } from '../strategies/generators';

// Wraps the graduation-layer counter bump with the side-effect of rewriting the
// saved strategy from `fetch` to `page-script` when the threshold crosses. This
// is "persistent demotion" — after N consecutive Node-fire failures the
// strategy moves to the browser path for all future warm runs until a
// re-discovery or probe re-check promotes it back. The in-memory counter drives
// the decision; the on-disk rewrite makes it durable.
export function recordNodeTransportFailure(
  platform: string,
  capability: string,
  tier: 'fetch',
  protocol: 'http' | 'websocket',
  signal: string,
): void {
  const count = _recordNodeTransportFailure(platform, capability, tier, protocol, signal);
  if (count >= NODE_TRANSPORT_FAIL_THRESHOLD) {
    try {
      skills.demoteFetchToPageScript(platform, capability);
    } catch {
      // Best-effort persistence. If the disk write fails, the in-memory counter
      // still gates the next call via the runtime's own code path, so the user
      // experience isn't broken — it's just not durable.
    }
  }
}

export class TransportFailureError extends Error {
  readonly signal: string;
  readonly cause: unknown;
  constructor(signal: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'TransportFailureError';
    this.signal = signal;
    this.cause = cause;
  }
}

// Classify a thrown error from `fetch()` as transport-shaped (retry with
// browser transport) vs something we should let bubble up. Transport-shaped
// failures are ClientHello / early-protocol problems that don't mean the API is
// broken, just that Node can't talk to it.
function classifyFetchThrow(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  // Node's undici wraps low-level errors under `.cause`.
  const errObj = err as Error & { cause?: unknown };
  const cause = errObj.cause as { code?: string; message?: string } | undefined;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  if (code) {
    if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') return 'dns_failure';
    if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
    if (code === 'EPROTO') return 'tls_protocol_error';
    if (code.startsWith('ERR_SSL_') || code.startsWith('CERT_')) return 'tls_handshake';
    if (code === 'ERR_HTTP2_PROTOCOL_ERROR' || code === 'ERR_HTTP2_STREAM_ERROR') {
      return 'http2_protocol';
    }
  }
  // Fallback: messages that carry diagnostic strings without a code.
  const message = typeof cause?.message === 'string' ? cause.message : err.message;
  if (/socket hang up|ECONNRESET|client network socket disconnected/i.test(message)) {
    return 'connection_reset';
  }
  if (/unable to verify|self.?signed|CERT_/i.test(message)) return 'tls_handshake';
  return null;
}

// Build the outgoing headers for a Node fetch call. Applies the merge order
// documented in the plan (most → least specific): strategy headers win over
// device-level defaults win over synthesis.
function buildNodeHeaders(
  strategyHeaders: Record<string, string>,
  bodyIsSerialized: boolean,
  isForm: boolean,
  cookieHeader: string | null,
  _platform: string,
  _url: string,
): Record<string, string> {
  const profile = getDeviceProfile();
  const out: Record<string, string> = {};

  // Lowercase-key map so we can check for presence case-insensitively without
  // losing the canonical casing from the saved strategy. `lower` tracks which
  // header names are already set (by lowercased key).
  const lower = new Set<string>();
  const put = (name: string, value: string): void => {
    out[name] = value;
    lower.add(name.toLowerCase());
  };

  // Strategy-captured headers come first — they are the source of truth when
  // present. These include User-Agent, sec-ch-ua-*, accept-language, and any
  // per-endpoint auth headers the discovery agent captured.
  for (const [k, v] of Object.entries(strategyHeaders)) {
    put(k, v);
  }

  // Content-Type for bodies, unless the strategy already declared one.
  if (bodyIsSerialized && !lower.has('content-type')) {
    put('Content-Type', isForm ? 'application/x-www-form-urlencoded' : 'application/json');
  }

  // User-Agent from device profile — only if strategy didn't supply one.
  if (!lower.has('user-agent') && profile.userAgent) {
    put('User-Agent', profile.userAgent);
  }

  // Accept-Language from device profile (or the default baseline).
  if (!lower.has('accept-language')) {
    put('Accept-Language', profile.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE);
  }

  // Client hints — only fall back to synthesis if the strategy didn't capture
  // them. Captured values always win because they came from a real
  // browser-origin request during discovery.
  const hints = resolveClientHints(profile);
  if (!lower.has('sec-ch-ua') && hints['sec-ch-ua']) put('sec-ch-ua', hints['sec-ch-ua']);
  if (!lower.has('sec-ch-ua-mobile') && hints['sec-ch-ua-mobile']) {
    put('sec-ch-ua-mobile', hints['sec-ch-ua-mobile']);
  }
  if (!lower.has('sec-ch-ua-platform') && hints['sec-ch-ua-platform']) {
    put('sec-ch-ua-platform', hints['sec-ch-ua-platform']);
  }

  // Cookie jar, if any match the request URL.
  if (cookieHeader) {
    put('Cookie', cookieHeader);
  }

  return out;
}

interface FireNodeOptions {
  /** Override body serialization — used when an assisted synthetic strategy
   *  already has the body resolved. */
  preResolvedBody?: string;
  /** Account name on the platform — see klura://reference#identities. */
  identity?: string;
}

async function fireRequestFromNode(
  strategy: RequestStrategy,
  args: Record<string, unknown>,
  platform: string,
  options: FireNodeOptions = {},
): Promise<ExecuteResult> {
  const prepared = prepareRequest(strategy, args);
  const { method, url, isForm } = prepared;
  const serializedBody = options.preResolvedBody ?? prepared.serializedBody;

  // Cookie jar: read once before the request, persist Set-Cookie after.
  const jarBeforeRequest = skills.readStorageStateCookies(platform, url, options.identity);
  const strategyHeaders = resolveHeaders(strategy.headers, args);
  const headers = buildNodeHeaders(
    strategyHeaders,
    serializedBody !== undefined,
    isForm,
    jarBeforeRequest.header,
    platform,
    url,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: serializedBody,
      // redirect: 'follow' is the Node fetch default — mirror what a browser
      // does on a same-origin redirect chain. cross-origin redirects strip the
      // Authorization header automatically, which matches the in-browser fetch
      // path as well.
      redirect: 'follow',
    });
  } catch (err) {
    const signal = classifyFetchThrow(err);
    if (signal) {
      throw new TransportFailureError(
        signal,
        `node transport failed (${signal}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    return {
      status: 0,
      body: {
        error: 'fetch_failed',
        details: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Persist any Set-Cookie headers the response issued. `getSetCookie()` is the
  // Node 20+ API that returns the individual values without splitting on commas
  // inside Expires attribute values — the critical difference from
  // `headers.get('set-cookie')`.
  const getSetCookie = (response.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === 'function') {
    const values = getSetCookie.call(response.headers);
    if (Array.isArray(values) && values.length > 0) {
      skills.writeStorageStateCookies(platform, values, url, options.identity);
    }
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  let body: unknown;
  try {
    const bodyText = await response.text();
    if (bodyText.length === 0) {
      body = null;
    } else if (contentType.includes('application/json') || contentType.includes('+json')) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Content-Type lied — return the raw text so the caller sees what
        // actually came back instead of an opaque parse error.
        body = bodyText;
      }
    } else {
      body = bodyText;
    }
  } catch (err) {
    return {
      status: response.status,
      body: {
        error: 'body_read_failed',
        details: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const extracted = applyHtmlExtract(strategy.response, body);
  if (!extracted.ok) {
    return {
      status: response.status,
      body: { error: extracted.code, details: extracted.details },
    };
  }

  return {
    status: response.status,
    body: extracted.body,
    finalUrl: response.url,
  };
}

// Fetch a prerequisite URL and run the extractors against its response body.
// Supports both page-extract (HTML via cheerio) and fetch-extract (JSON via
// dot-path — shares the existing extractByPath helper). The shared cookie jar
// is read before and persisted after so auth cookies rotate correctly across
// prereq + final-call sequences.
async function fetchPrereqFromNode(
  prereq: Prerequisite,
  args: Record<string, unknown>,
  platform: string,
  identity?: string,
): Promise<Record<string, string>> {
  if (!prereq.url) {
    throw new Error(`prereq "${prereq.name}": missing url`);
  }
  const resolvedUrl = interpolateVars(prereq.url, args);

  // fetch-extract: REST-style JSON lookup, no HTML parsing.
  if (prereq.kind === 'fetch-extract') {
    if (!prereq.vars || typeof prereq.vars !== 'object') {
      throw new Error(
        `prereq "${prereq.name}": fetch-extract requires "vars" object {name: "dot.path.into.json"}`,
      );
    }
    const httpMethod = (prereq.method ?? 'GET').toUpperCase();
    const headersMap = prereq.headers_map ?? { Accept: 'application/json' };
    const bodyObj = prereq.fetch_body ? resolveBody(prereq.fetch_body, args) : undefined;
    const jar = skills.readStorageStateCookies(platform, resolvedUrl, identity);
    const headers = buildNodeHeaders(
      resolveHeaders(headersMap, args),
      bodyObj !== undefined,
      false,
      jar.header,
      platform,
      resolvedUrl,
    );
    let response: Response;
    try {
      response = await fetch(resolvedUrl, {
        method: httpMethod,
        headers,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined,
        redirect: 'follow',
      });
    } catch (err) {
      const signal = classifyFetchThrow(err);
      if (signal) {
        throw new TransportFailureError(
          signal,
          `prereq "${prereq.name}" (fetch-extract): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      throw new Error(
        `prereq "${prereq.name}" (fetch-extract): fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const getSetCookie = (response.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie;
    if (typeof getSetCookie === 'function') {
      const values = getSetCookie.call(response.headers);
      if (Array.isArray(values) && values.length > 0) {
        skills.writeStorageStateCookies(platform, values, resolvedUrl, identity);
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `prereq "${prereq.name}" (fetch-extract): HTTP ${response.status} from ${resolvedUrl}`,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(
        `prereq "${prereq.name}" (fetch-extract): response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const tokens: Record<string, string> = {};
    for (const [varName, rawPath] of Object.entries(prereq.vars)) {
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        throw new Error(
          `prereq "${prereq.name}" (fetch-extract): var "${varName}" must be a non-empty dot-path string`,
        );
      }
      const value = extractByPath(json, rawPath);
      if (value === undefined) {
        throw new Error(
          `prereq "${prereq.name}" (fetch-extract): var "${varName}" path "${rawPath}" did not resolve in response body`,
        );
      }
      tokens[varName] = value;
    }
    return tokens;
  }

  // page-extract: HTML fetch + cheerio selector.
  if (prereq.kind !== 'page-extract') {
    throw new Error(
      `prereq "${prereq.name}": kind "${prereq.kind}" is not supported by node transport. ` +
        `Only "cached", "fetch-extract", and "page-extract" prereqs work without a browser. ` +
        `For "browser" kind prereqs (imperative click/type steps), set the strategy's transport ` +
        `to "browser" so the in-browser fetch path handles it.`,
    );
  }
  if (!prereq.vars || typeof prereq.vars !== 'object') {
    throw new Error(
      `prereq "${prereq.name}": page-extract requires "vars" object {name: {selector, attr?}}`,
    );
  }

  const jar = skills.readStorageStateCookies(platform, resolvedUrl, identity);
  const headers = buildNodeHeaders({}, false, false, jar.header, platform, resolvedUrl);
  // Page-extract prereqs always GET. Accept: text/html is polite and matches
  // what a real browser navigation sends.
  headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  let response: Response;
  try {
    response = await fetch(resolvedUrl, { method: 'GET', headers, redirect: 'follow' });
  } catch (err) {
    const signal = classifyFetchThrow(err);
    if (signal) {
      throw new TransportFailureError(
        signal,
        `prereq "${prereq.name}" (page-extract): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    throw new Error(
      `prereq "${prereq.name}" (page-extract): fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const getSetCookie = (response.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === 'function') {
    const values = getSetCookie.call(response.headers);
    if (Array.isArray(values) && values.length > 0) {
      skills.writeStorageStateCookies(platform, values, resolvedUrl, identity);
    }
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `prereq "${prereq.name}" (page-extract): HTTP ${response.status} from ${resolvedUrl}`,
    );
  }

  const html = await response.text();
  // Build the cheerio selector spec from prereq.vars shape.
  const selectorSpec: Record<string, { selector: string; attr?: string }> = {};
  for (const [varName, rawSpec] of Object.entries(prereq.vars)) {
    if (!rawSpec || typeof rawSpec !== 'object') {
      throw new Error(`prereq "${prereq.name}": var "${varName}" must be {selector, attr?}`);
    }
    const spec = rawSpec as { selector?: unknown; attr?: unknown };
    if (typeof spec.selector !== 'string' || spec.selector.length === 0) {
      throw new Error(`prereq "${prereq.name}": var "${varName}" requires a "selector" string`);
    }
    const specOut: { selector: string; attr?: string } = { selector: spec.selector };
    if (typeof spec.attr === 'string' && spec.attr.length > 0) specOut.attr = spec.attr;
    selectorSpec[varName] = specOut;
  }

  let extracted: Record<string, string | string[]>;
  try {
    extracted = extractFromHtml(html, selectorSpec);
  } catch (err) {
    throw new Error(
      `prereq "${prereq.name}" (page-extract): cheerio parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const tokens: Record<string, string> = {};
  for (const [varName, value] of Object.entries(extracted)) {
    const stringValue = Array.isArray(value) ? value.join(',') : value;
    if (stringValue === '') {
      throw new Error(
        `prereq "${prereq.name}" (page-extract): var "${varName}" selector ` +
          `"${selectorSpec[varName]?.selector}" did not resolve on ${resolvedUrl}. ` +
          `Either the selector is wrong, the token isn't in the server-shipped HTML ` +
          `(JS-generated — switch the strategy tier to page-script), or the page gated ` +
          `behind an auth wall.`,
      );
    }
    tokens[varName] = stringValue;
  }
  return tokens;
}

// --- fetch executor (Node transport) --- Runs prerequisites and the final
// request from Node. Supports cached, fetch-extract, and page-extract prereqs
// (the latter via cheerio). When a prereq needs a live page (kind:"browser" /
// "js-eval"), this path throws TransportFailureError and the dispatcher retries
// in the browser via executeFetchInBrowser.
export async function executeFetchNode(
  strategy: FetchStrategy,
  args: Record<string, unknown>,
  platform: string,
  capability: string,
  tokenCache: TokenCache | null,
  pool: AnyPool | null,
  depth: number,
  resolveCapabilityPrereq: (
    prereq: Prerequisite,
    callerPlatform: string,
    callerArgs: Record<string, unknown>,
    callerTokens: Record<string, unknown>,
    pool: AnyPool | null,
    tokenCache: TokenCache | null,
    depth: number,
  ) => Promise<Record<string, unknown> | null>,
  stringifyScope: (v: unknown) => string,
  identity?: string,
): Promise<ExecuteResult> {
  const overrides = args._generated as Record<string, string> | undefined;
  const tokens = await resolveNodeCompatiblePrereqs(
    strategy.prerequisites,
    args,
    platform,
    tokenCache,
    pool,
    depth,
    resolveCapabilityPrereq,
    stringifyScope,
    identity,
  );

  const genInputArgs: Record<string, unknown> = { ...tokens, ...args };
  const { resolved: gen, needsLlm } = resolveGenerated(strategy.generated, overrides, genInputArgs);
  if (Object.keys(needsLlm).length > 0) {
    return {
      status: 0,
      body: {
        needs_generation: true,
        platform,
        capability,
        generators_needed: needsLlm,
        retry_with: 'Provide values via args._generated and re-call execute',
      },
    };
  }

  const mergedArgs: Record<string, unknown> = { ...tokens, ...args, __gen: gen };
  const fireStrategy: FetchStrategy = {
    strategy: 'fetch',
    method: strategy.method,
    endpoint: strategy.endpoint,
    baseUrl: strategy.baseUrl,
    contentType: strategy.contentType,
    headers: strategy.headers,
    body: strategy.body,
    params: strategy.params,
    generated: strategy.generated,
  };
  return await fireRequestFromNode(fireStrategy, mergedArgs, platform, { identity });
}

export async function resolveNodeCompatiblePrereqs(
  prerequisites: Prerequisite[] | undefined,
  args: Record<string, unknown>,
  platform: string,
  tokenCache: TokenCache | null,
  pool: AnyPool | null,
  depth: number,
  resolveCapabilityPrereq: (
    prereq: Prerequisite,
    callerPlatform: string,
    callerArgs: Record<string, unknown>,
    callerTokens: Record<string, unknown>,
    pool: AnyPool | null,
    tokenCache: TokenCache | null,
    depth: number,
  ) => Promise<Record<string, unknown> | null>,
  stringifyScope: (v: unknown) => string,
  identity?: string,
): Promise<Record<string, string>> {
  const tokens: Record<string, string> = {};
  for (const prereq of prerequisites ?? []) {
    if (prereq.kind === 'cached') {
      const cached = tokenCache?.get(platform, prereq.name);
      tokens[prereq.name] = cached ?? prereq.value ?? '';
      continue;
    }
    if (prereq.kind === 'capability' || prereq.kind === 'tag') {
      const bound = await resolveCapabilityPrereq(
        prereq,
        platform,
        args,
        tokens,
        pool,
        tokenCache,
        depth,
      );
      if (bound) {
        for (const [k, v] of Object.entries(bound)) tokens[k] = stringifyScope(v);
      }
      continue;
    }
    if (prereq.kind === 'browser' || prereq.kind === 'js-eval') {
      throw new TransportFailureError(
        'browser_prereq_required',
        `prereq "${prereq.name}" uses kind: "${prereq.kind}" which requires DOM interaction. ` +
          `This strategy must execute in the browser; retry via page-script.`,
      );
    }
    if (prereq.kind === 'fetch-extract') {
      const cached = tokenCache?.get(platform, prereq.name);
      if (typeof cached === 'string' && cached.length > 0) {
        tokens[prereq.name] = cached;
      }
    }
    const extractedTokens = await fetchPrereqFromNode(
      prereq,
      { ...tokens, ...args },
      platform,
      identity,
    );
    Object.assign(tokens, extractedTokens);
    const persistable = extractedTokens[prereq.name];
    if (
      prereq.name &&
      typeof persistable === 'string' &&
      persistable &&
      tokenCache &&
      prereq.ttl !== null
    ) {
      tokenCache.set(platform, prereq.name, persistable, {
        ttl: prereq.ttl ?? 1800,
      });
    }
  }
  return tokens;
}
