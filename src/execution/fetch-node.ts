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
  omittedOptionalParamNames,
  prepareRequest,
  resolveBody,
  resolveHeaders,
  resolveUrlTemplate,
} from './vars';
import type { ExecuteResult, FetchStrategy, Prerequisite, RequestStrategy, AnyPool } from './types';
import type { TokenCache } from '../strategies/tokens';
import { resolveGenerated } from '../strategies/generators';
import { applyResponseFrom, hasResponseFrom } from './response-from';
import {
  acquireLocalOriginPermit,
  dispatchedHttpDeliveryUnknown,
  httpMethodMayMutate,
  LocalRequestTimeoutError,
  mapDispatchedHttpTimeout,
  localTrafficPolicyForUrl,
  localRequestTimeoutMs,
} from './local-traffic';
import { OriginSchedulerError, type SchedulerCompletionV1 } from './origin-scheduler';
import { recordDiagnosticUrl } from './diagnostic-evidence';

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
  const cause = errObj.cause as { code?: string } | undefined;
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

interface AdmittedNodeResponse {
  response: Response;
  release(completion: SchedulerCompletionV1): void;
  timed_out(): boolean;
}

interface NodeRequestDispatchState {
  request_dispatches: number;
}

async function fetchWithOriginAdmission(
  url: string,
  workloadId: string,
  init: RequestInit,
  dispatchState: NodeRequestDispatchState = { request_dispatches: 0 },
): Promise<AdmittedNodeResponse> {
  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: 'manual' };
  let redirectHops = 0;
  for (;;) {
    const admitted = await fetchOneWithOriginAdmission(
      currentUrl,
      workloadId,
      currentInit,
      dispatchState,
    );
    const response = admitted.response;
    if (!isRedirectResponse(response.status)) return admitted;

    const maxRedirectHops = localTrafficPolicyForUrl(currentUrl).max_redirect_hops;
    if (redirectHops >= maxRedirectHops) {
      await discardRedirectResponse(admitted);
      throw new LocalRedirectError(`redirect limit of ${maxRedirectHops} hops is exhausted`);
    }
    const location = response.headers.get('location');
    if (!location) return admitted;

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      await discardRedirectResponse(admitted);
      throw new LocalRedirectError('redirect response has an invalid Location header');
    }
    await discardRedirectResponse(admitted);
    currentInit = redirectedRequestInit(currentInit, currentUrl, nextUrl, response.status);
    currentUrl = nextUrl;
    redirectHops += 1;
  }
}

async function fetchOneWithOriginAdmission(
  url: string,
  workloadId: string,
  init: RequestInit,
  dispatchState: NodeRequestDispatchState,
): Promise<AdmittedNodeResponse> {
  const permit = await acquireLocalOriginPermit(url, workloadId);
  const timeoutMs = localRequestTimeoutMs();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  try {
    dispatchState.request_dispatches += 1;
    recordDiagnosticUrl('request', url);
    const response = await fetch(url, { ...init, signal });
    let released = false;
    return {
      response,
      release(completion): void {
        if (released) return;
        released = true;
        clearTimeout(timer);
        permit.release(deadline.signal.aborted ? 'transient_failure' : completion);
      },
      timed_out(): boolean {
        return deadline.signal.aborted;
      },
    };
  } catch (error) {
    clearTimeout(timer);
    permit.release('transient_failure');
    if (deadline.signal.aborted) throw new LocalRequestTimeoutError(timeoutMs);
    throw error;
  }
}

async function discardRedirectResponse(admitted: AdmittedNodeResponse): Promise<void> {
  try {
    await admitted.response.body?.cancel();
  } catch {
    // The admission still releases below. The fetch deadline remains armed
    // until that point, so a stalled body cannot make the permit reusable.
  } finally {
    admitted.release(admitted.timed_out() ? 'transient_failure' : 'success');
  }
  if (admitted.timed_out()) throw new LocalRequestTimeoutError(localRequestTimeoutMs());
}

function isRedirectResponse(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectedRequestInit(
  init: RequestInit,
  currentUrl: string,
  nextUrl: string,
  status: number,
): RequestInit {
  const headers = new Headers(init.headers);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    method = 'GET';
    body = undefined;
    headers.delete('content-type');
    headers.delete('content-length');
  }
  if (new URL(currentUrl).origin !== new URL(nextUrl).origin) {
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete('proxy-authorization');
  }
  return {
    ...init,
    method,
    body,
    headers: Object.fromEntries(headers.entries()),
    redirect: 'manual',
  };
}

class LocalRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalRedirectError';
  }
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
  capability: string,
  options: FireNodeOptions = {},
): Promise<ExecuteResult> {
  const prepared = prepareRequest(strategy, args);
  const { method, url, isForm } = prepared;
  const serializedBody = options.preResolvedBody ?? prepared.serializedBody;

  // Cookie jar: read once before the request, persist Set-Cookie after.
  const jarBeforeRequest = skills.readStorageStateCookies(platform, url, options.identity);
  const strategyHeaders = resolveHeaders(
    strategy.headers,
    args,
    omittedOptionalParamNames(strategy, args),
  );
  const headers = buildNodeHeaders(
    strategyHeaders,
    serializedBody !== undefined,
    isForm,
    jarBeforeRequest.header,
    platform,
    url,
  );

  let admitted: AdmittedNodeResponse;
  const dispatchState: NodeRequestDispatchState = { request_dispatches: 0 };
  try {
    admitted = await fetchWithOriginAdmission(
      url,
      `${platform}/${capability}`,
      {
        method,
        headers,
        body: serializedBody,
      },
      dispatchState,
    );
  } catch (err) {
    const mappedTimeout = mapDispatchedHttpTimeout(err, method, url);
    if (mappedTimeout !== err) throw mappedTimeout;
    if (
      err instanceof LocalRequestTimeoutError ||
      (err instanceof OriginSchedulerError &&
        (!httpMethodMayMutate(method) || dispatchState.request_dispatches === 0))
    ) {
      throw err;
    }
    const signal = classifyFetchThrow(err);
    if (httpMethodMayMutate(method)) {
      throw dispatchedHttpDeliveryUnknown(method, url, {
        transport_signal: signal ?? 'unknown',
        request_dispatches: dispatchState.request_dispatches,
        ...(err instanceof OriginSchedulerError ? { scheduler_code: err.code } : {}),
      });
    }
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

  const response = admitted.response;
  try {
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
      if (admitted.timed_out()) throw new LocalRequestTimeoutError(localRequestTimeoutMs());
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
  } catch (error) {
    throw mapDispatchedHttpTimeout(error, method, url);
  } finally {
    admitted.release(response.status >= 500 ? 'transient_failure' : 'success');
  }
}

// Fetch a prerequisite URL and run the extractors against its response body.
// Supports both page-extract (HTML via cheerio) and fetch-extract (JSON via
// dot-path — shares the existing extractByPath helper). The shared cookie jar
// is read before and persisted after so auth cookies rotate correctly across
// prereq + final-call sequences.
// eslint-disable-next-line sonarjs/cognitive-complexity
async function fetchPrereqFromNode(
  prereq: Prerequisite,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string>,
  platform: string,
  capability: string,
  identity?: string,
): Promise<Record<string, string>> {
  if (!prereq.url) {
    throw new Error(`prereq "${prereq.name}": missing url`);
  }
  const resolvedUrl = resolveUrlTemplate(
    prereq.url,
    args,
    omittedOptionalParams,
    `prerequisite ${JSON.stringify(prereq.name)} URL`,
  );

  // fetch-extract: REST-style JSON lookup, no HTML parsing.
  if (prereq.kind === 'fetch-extract') {
    if (!prereq.vars || typeof prereq.vars !== 'object') {
      throw new Error(
        `prereq "${prereq.name}": fetch-extract requires "vars" object {name: "dot.path.into.json"}`,
      );
    }
    const httpMethod = (prereq.method ?? 'GET').toUpperCase();
    const headersMap = prereq.headers_map ?? { Accept: 'application/json' };
    const bodyObj = prereq.fetch_body
      ? resolveBody(prereq.fetch_body, args, omittedOptionalParams)
      : undefined;
    const jar = skills.readStorageStateCookies(platform, resolvedUrl, identity);
    const headers = buildNodeHeaders(
      resolveHeaders(headersMap, args, omittedOptionalParams),
      bodyObj !== undefined,
      false,
      jar.header,
      platform,
      resolvedUrl,
    );
    let admitted: AdmittedNodeResponse;
    const dispatchState: NodeRequestDispatchState = { request_dispatches: 0 };
    try {
      admitted = await fetchWithOriginAdmission(
        resolvedUrl,
        `${platform}/${capability}`,
        {
          method: httpMethod,
          headers,
          body: bodyObj ? JSON.stringify(bodyObj) : undefined,
        },
        dispatchState,
      );
    } catch (err) {
      const mappedTimeout = mapDispatchedHttpTimeout(err, httpMethod, resolvedUrl);
      if (mappedTimeout !== err) throw mappedTimeout;
      if (
        err instanceof OriginSchedulerError &&
        (!httpMethodMayMutate(httpMethod) || dispatchState.request_dispatches === 0)
      ) {
        throw err;
      }
      const signal = classifyFetchThrow(err);
      if (httpMethodMayMutate(httpMethod)) {
        throw dispatchedHttpDeliveryUnknown(httpMethod, resolvedUrl, {
          transport_signal: signal ?? 'unknown',
          prerequisite: prereq.name,
          request_dispatches: dispatchState.request_dispatches,
          ...(err instanceof OriginSchedulerError ? { scheduler_code: err.code } : {}),
        });
      }
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
    const response = admitted.response;
    try {
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
        if (admitted.timed_out()) throw new LocalRequestTimeoutError(localRequestTimeoutMs());
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
    } catch (error) {
      throw mapDispatchedHttpTimeout(error, httpMethod, resolvedUrl);
    } finally {
      admitted.release(response.status >= 500 ? 'transient_failure' : 'success');
    }
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

  let admitted: AdmittedNodeResponse;
  try {
    admitted = await fetchWithOriginAdmission(resolvedUrl, `${platform}/${capability}`, {
      method: 'GET',
      headers,
    });
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
  const response = admitted.response;
  try {
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

    let html: string;
    try {
      html = await response.text();
    } catch (err) {
      if (admitted.timed_out()) throw new LocalRequestTimeoutError(localRequestTimeoutMs());
      throw new Error(
        `prereq "${prereq.name}" (page-extract): response body could not be read: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
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

    let extracted: Record<string, unknown>;
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
      let stringValue: string;
      if (typeof value === 'string') {
        stringValue = value;
      } else if (Array.isArray(value)) {
        stringValue = value.map((v) => (typeof v === 'string' ? v : '')).join(',');
      } else {
        stringValue = '';
      }
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
  } finally {
    admitted.release(response.status >= 500 ? 'transient_failure' : 'success');
  }
}

// --- fetch executor (Node transport) --- Runs prerequisites and the final
// request from Node. Supports cached, fetch-extract, and page-extract prereqs
// (the latter via cheerio). Browser-bound prereq kinds (js-eval, browser) are
// rejected at save time by validateFetchPrereqKinds — fetch tier strategies
// never carry them.
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
    omittedOptionalParams?: ReadonlySet<string>,
  ) => Promise<Record<string, unknown> | null>,
  stringifyScope: (v: unknown) => string,
  identity?: string,
): Promise<ExecuteResult> {
  const overrides = args._generated as Record<string, string> | undefined;
  const omittedOptionalParams = omittedOptionalParamNames(strategy, args);
  const tokens = await resolveNodeCompatiblePrereqs(
    strategy.prerequisites,
    args,
    omittedOptionalParams,
    platform,
    capability,
    tokenCache,
    pool,
    depth,
    resolveCapabilityPrereq,
    stringifyScope,
    identity,
  );

  // `response.from` short-circuit — strategy returns the named prereq's value
  // directly; no HTTP fires. Schema-side validation (validateResponseShape)
  // already verified the named prereq exists and is value-producing, so any
  // throw here is a runtime data issue (e.g. prereq returned an unparseable
  // JSON string).
  if (hasResponseFrom(strategy)) {
    try {
      const { body } = applyResponseFrom(strategy, tokens);
      return { status: 200, body };
    } catch (err) {
      return {
        status: 500,
        body: {
          error: 'response_from_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  const genInputArgs: Record<string, unknown> = { ...tokens, ...args };
  const { resolved: gen, needsLlm } = resolveGenerated(strategy.generated, overrides, genInputArgs);
  if (Object.keys(needsLlm).length > 0) {
    return {
      status: 0,
      executionState: 'not_run',
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
    notes: strategy.notes,
    // `response` carries format + extract; fireRequestFromNode reads it via
    // applyHtmlExtract to convert raw HTML into the strategy's structured
    // row shape. Dropping it here silently degrades every html-extract
    // fetch into "return the raw body" — the symptom that first surfaced
    // with a search-results row-group extract.
    response: strategy.response,
  };
  return await fireRequestFromNode(fireStrategy, mergedArgs, platform, capability, { identity });
}

export async function resolveNodeCompatiblePrereqs(
  prerequisites: Prerequisite[] | undefined,
  args: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string>,
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
    omittedOptionalParams?: ReadonlySet<string>,
  ) => Promise<Record<string, unknown> | null>,
  _stringifyScope: (v: unknown) => string,
  identity?: string,
): Promise<Record<string, unknown>> {
  const tokens: Record<string, unknown> = {};
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
        omittedOptionalParams,
      );
      if (bound) {
        Object.assign(tokens, bound);
      }
      continue;
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
      omittedOptionalParams,
      platform,
      capability,
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
