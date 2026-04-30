// CDP-based network capture.
//
// Attaches Network domain listeners on a CDPSession and pushes captured
// requests onto a sink array. Driver-agnostic: the caller owns the CDP session
// and the sink. Used by PlaywrightDriver in-process and — eventually — by the
// docker driver-server so both modes share one capture path.
//
// Why CDP and not page.on('request'|'response'): Network.requestWillBeSent
// fires for every request the browser process makes, including those from
// iframes, service workers (when not blocked), Turbo/Relay submissions, and
// prefetch requests. Playwright's higher-level page.on('request') hooks only
// see frame-bound main-thread requests and miss the SPA edge cases that matter
// for strategy discovery.
//
// The same filter rules apply as in the page.on path: - drop static assets by
// extension - drop GET requests that don't look like API calls The filter
// exists because the captured stream feeds directly into the LLM's network log
// view, and seeing 200 CSS/font/image requests per page swamps the interesting
// traffic.

import type { InterceptedRequest } from './types/network';
import type { Session } from './types/session';

// CDPSession is Playwright's type — we import it structurally to stay
// driver-agnostic. The fields we touch are on() for event subscription and
// send() for issuing commands. Detaching is the caller's responsibility.
interface CDPLike {
  on(event: string, handler: (params: unknown) => void): void;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Per-entry response-body size cap. Bodies larger than this are stored as a
 * clipped-with-marker string to bound memory on long-lived sessions that hit
 * pages with large HTML / JSON responses. 256 KB is generous enough that
 * realistic graphql / REST responses land verbatim; the cap mainly exists to
 * stop a rogue full-page HTML dump or a streaming endpoint from eating
 * gigabytes of RAM in a single session.
 */
const RESPONSE_BODY_CAP_CHARS = 256 * 1024;

const STATIC_EXTENSIONS = new Set([
  '.css',
  '.js',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.map',
]);

export function isStaticAsset(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return STATIC_EXTENSIONS.has(pathname.slice(pathname.lastIndexOf('.')).toLowerCase());
  } catch {
    return false;
  }
}

interface CdpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: string;
}

interface CdpResponseHeaders {
  [k: string]: string | undefined;
}

interface RequestWillBeSentParams {
  requestId: string;
  request: CdpRequest;
  type?: string;
  redirectResponse?: {
    status: number;
    headers?: CdpResponseHeaders;
  };
}

interface ResponseReceivedParams {
  requestId: string;
  response: {
    status: number;
    headers?: CdpResponseHeaders;
  };
}

interface LoadingFinishedParams {
  requestId: string;
}

interface ResponseReceivedExtraInfoParams {
  requestId: string;
  /** All response headers including Set-Cookie / Cookie that
   *  Network.Response.headers omits for security policy. */
  headers?: CdpResponseHeaders;
  statusCode?: number;
}

interface GetResponseBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

interface RawIntercepted extends InterceptedRequest {
  headers: Record<string, string>;
}

/**
 * Wire Network domain listeners on the given CDP session. The capture array is
 * filled in place. Returns a disposer that removes listeners (best-effort — CDP
 * doesn't expose off(), so we rely on detach() from the caller for true
 * cleanup).
 *
 * The caller must have already called `Network.enable` on the session (or will
 * immediately after, which is the same — Network events fire from the enable
 * point forward).
 */
export async function attachCdpNetworkCapture(cdp: CDPLike, sink: RawIntercepted[]): Promise<void> {
  await cdp.send('Network.enable');

  // CDP's Network.responseReceived doesn't carry the URL in a form convenient
  // for matching against entries by URL substring (redirect chains reuse the
  // same requestId). Keep a requestId → entry map so we can correlate without
  // walking the sink on every event.
  const byReqId = new Map<string, RawIntercepted>();
  // Per-requestId chain of all entries for that request (initial + each
  // redirect hop's destination). Lets `responseReceivedExtraInfo` attribute
  // its Set-Cookie names to the correct hop in the chain (matched by
  // statusCode) — without this, the cookie set by a POST→302 lands on the
  // GET-the-redirect-resolves-to entry instead of the original POST.
  const chainByReqId = new Map<string, RawIntercepted[]>();

  cdp.on('Network.requestWillBeSent', (raw) => {
    const params = raw as RequestWillBeSentParams;
    // A redirectResponse means the previous hop of this requestId just finished
    // with a 3xx. Finalize the old entry before overwriting it with the new
    // one.
    if (params.redirectResponse) {
      const prev = byReqId.get(params.requestId);
      if (prev && prev.status === null) {
        prev.status = params.redirectResponse.status;
        const loc =
          params.redirectResponse.headers?.['location'] ??
          params.redirectResponse.headers?.['Location'];
        if (loc) prev.redirectUrl = loc;
        // Set-Cookie on a 3xx redirect arrives via Network.responseReceivedExtraInfo
        // (CDP omits it from regular response.headers for security policy).
        // The extraInfo handler below populates setCookieNames against this
        // same requestId before this point.
      }
    }

    const request = params.request;
    if (isStaticAsset(request.url)) return;
    if (request.method === 'GET') {
      try {
        const pathname = new URL(request.url).pathname;
        if (!pathname.includes('/api/')) return;
      } catch {
        return;
      }
    }

    const entry: RawIntercepted = {
      method: request.method,
      url: request.url,
      headers: request.headers ?? {},
      postData: null,
      status: null,
      responseBody: null,
      timestamp: Date.now(),
    };
    // CDP resource type 'Document' = top-level navigation. Flag so T1 form-POST
    // recognition can treat this as an HTML form submission, not a JSON API
    // call.
    if (params.type === 'Document') entry.isNavigation = true;
    if (request.postData) {
      try {
        entry.postData = JSON.parse(request.postData) as unknown;
      } catch {
        entry.postData = request.postData;
      }
    }
    sink.push(entry);
    byReqId.set(params.requestId, entry);
    const chain = chainByReqId.get(params.requestId) ?? [];
    chain.push(entry);
    chainByReqId.set(params.requestId, chain);
  });

  cdp.on('Network.responseReceived', (raw) => {
    const params = raw as ResponseReceivedParams;
    const entry = byReqId.get(params.requestId);
    if (!entry) return;
    entry.status = params.response.status;
    if (params.response.status >= 300 && params.response.status < 400) {
      const loc = params.response.headers?.['location'] ?? params.response.headers?.['Location'];
      if (loc) entry.redirectUrl = loc;
    }
    // Set-Cookie isn't on params.response.headers — CDP delivers it via
    // Network.responseReceivedExtraInfo (security carve-out). See the
    // extraInfo handler below.
  });

  // Network.responseReceivedExtraInfo carries the auth-relevant headers
  // (Set-Cookie, Cookie) that the regular response.headers omits for
  // security policy. Fires alongside responseReceived AND on each redirect
  // hop, all keyed by the same requestId. Extract Set-Cookie NAMES (not
  // values — those are typically session secrets) and attribute to the
  // correct entry in the redirect chain via statusCode. Powers the
  // auth-gated-without-login-prereq save-time detector.
  //
  // Why chain matching: a POST→302 with Set-Cookie sets the cookie on the
  // 302 response, but `byReqId` already points at the post-redirect (GET
  // /landing) entry by the time extraInfo fires. Without statusCode-based
  // matching, the cookie gets attributed to the landing page instead of
  // the actual session-establishing request. The detector's self-skip then
  // fails when the agent tries to save the login capability itself.
  cdp.on('Network.responseReceivedExtraInfo', (raw) => {
    const params = raw as ResponseReceivedExtraInfoParams;
    const setCookie = params.headers?.['set-cookie'] ?? params.headers?.['Set-Cookie'];
    if (typeof setCookie !== 'string' || setCookie.length === 0) return;
    const names: string[] = [];
    for (const line of setCookie.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const name = line.slice(0, eq).trim();
      if (name.length > 0) names.push(name);
    }
    if (names.length === 0) return;

    // Pick the chain entry whose status matches this extraInfo's statusCode
    // AND has no setCookieNames yet. Falls back to the latest entry when
    // status hasn't been set or there's only one hop.
    const chain = chainByReqId.get(params.requestId) ?? [];
    let target: RawIntercepted | undefined;
    const statusCode = params.statusCode;
    if (typeof statusCode === 'number') {
      target = chain.find((e) => e.status === statusCode && !e.setCookieNames);
    }
    if (!target) target = byReqId.get(params.requestId);
    if (!target) return;
    const merged = new Set([...(target.setCookieNames ?? []), ...names]);
    target.setCookieNames = Array.from(merged);
  });

  cdp.on('Network.loadingFinished', (raw) => {
    const params = raw as LoadingFinishedParams;
    const entry = byReqId.get(params.requestId);
    if (!entry || entry.responseBody !== null) return;
    // Network.getResponseBody can fail with "No resource with given identifier"
    // if the request is still in flight, was a redirect, or the frame detached.
    // Swallow both — a missing body is fine.
    cdp
      .send('Network.getResponseBody', { requestId: params.requestId })
      .then((result) => {
        const { body } = result as GetResponseBodyResult;
        if (!body) return;
        // Store the parsed JSON when possible (structured access for downstream
        // consumers that classify by shape), fall back to the raw string
        // otherwise (HTML, form responses, plaintext) so diagnostic dumps and
        // text_contains searches can still grep it. Cap at
        // RESPONSE_BODY_CAP_CHARS to bound memory; over-cap bodies are clipped
        // with a marker.
        let stored: unknown;
        try {
          stored = JSON.parse(body);
        } catch {
          stored = body;
        }
        if (typeof stored === 'string' && stored.length > RESPONSE_BODY_CAP_CHARS) {
          stored =
            stored.slice(0, RESPONSE_BODY_CAP_CHARS) +
            `\n…[responseBody clipped at ${RESPONSE_BODY_CAP_CHARS} bytes; original was ${body.length}]`;
        }
        entry.responseBody = stored;
      })
      .catch(() => {
        /* resource gone */
      });
  });
}

export function getInterceptedFromSink(session: Session): InterceptedRequest[] {
  return session.intercepted.map((e) => {
    const raw = e as RawIntercepted;
    return {
      method: raw.method,
      url: raw.url,
      headers: raw.headers,
      postData: raw.postData,
      status: raw.status,
      responseBody: raw.responseBody,
      ...(typeof raw.timestamp === 'number' ? { timestamp: raw.timestamp } : {}),
      ...(raw.isNavigation ? { isNavigation: true } : {}),
      ...(raw.redirectUrl ? { redirectUrl: raw.redirectUrl } : {}),
      ...(raw.setCookieNames && raw.setCookieNames.length > 0
        ? { setCookieNames: raw.setCookieNames }
        : {}),
    };
  });
}
