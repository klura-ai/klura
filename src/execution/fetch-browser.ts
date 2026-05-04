// In-browser fetch executor + prereq dispatch.
//
// Runs fetch() inside a browser page, NOT through Node. Used for two shapes: -
// `page-script` strategies — the natural home; the page is the execution
// context, fingerprint cookies & sec-* headers attach. - `fetch` strategies
// that the dispatcher retried in the browser after the Node call hit a TLS /
// bot-check signature it couldn't satisfy. Same captured payload, different
// transport — `transport: 'browser'` on the result.
//
// Also owns the prereq dispatch that lives entirely on the browser side:
// scanCachedPrereqs (cheap pre-pass), runBrowserPrereqs (the live page loop),
// and runPrerequisites (the public single-shot entry point used by the listener
// proactive-refresh watcher).

import * as skills from '../strategies/skills';
import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import { resolveGenerated } from '../strategies/generators';
import { JS_EVAL_TIMEOUT_DEFAULT_MS } from '../strategies/skills';
import { trimA11yTree, MAX_TOOL_OUTPUT_CHARS, truncateString } from '../response/response-size';
import { fireInterrupts, type InterruptEntry } from '../strategies/interrupt-firing';
import type { TokenCache } from '../strategies/tokens';
import {
  applyHtmlExtract,
  extractByPath,
  interpolateVars,
  prepareRequest,
  resolveBrowserPrereqStep,
  resolveBody,
  resolveHeaders,
} from './vars';
import {
  readJsEvalCache,
  writeJsEvalCache,
  schedulePrereqRefreshIfEnabled,
  runJsEvalPrereq,
} from './js-eval';
import type {
  AnyPool,
  ExecuteResult,
  FetchStrategy,
  PageScriptStrategy,
  Prerequisite,
  RequestStrategy,
} from './types';
import { currentDeviceSessionOpts, resolveCapabilityPrereq, stringifyScope } from '../execution';
import { looksLikeHtml } from '../execution';

/**
 * Pre-scan a strategy's prerequisites to separate cached/capability ones
 * (resolved without a browser) from those that need a live page. Cached tokens
 * land in the returned `tokens` map; capability prereqs are resolved by
 * recursively invoking another strategy; browser-method prereqs are served from
 * cache if available. Anything else is pushed onto `browserPrereqs` for a
 * subsequent `runBrowserPrereqs` call.
 */
export async function scanCachedPrereqs(
  prerequisites: Prerequisite[] | undefined,
  platform: string,
  args: Record<string, unknown>,
  pool: AnyPool,
  tokenCache: TokenCache | null,
  depth: number,
): Promise<{ tokens: Record<string, string>; browserPrereqs: Prerequisite[] }> {
  const tokens: Record<string, string> = {};
  const browserPrereqs: Prerequisite[] = [];
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
    // browser / page-extract — check cache for the prereq name first, only
    // queue a browser run if miss. page-extract produces multiple tokens and
    // skips this single-name cache; the cache hit path here only saves a
    // browser session for browser-kind prereqs that wrap a single token.
    if (prereq.kind === 'browser') {
      const cached = tokenCache?.get(platform, prereq.name);
      if (cached) {
        tokens[prereq.name] = cached;
        continue;
      }
    }
    browserPrereqs.push(prereq);
  }
  return { tokens, browserPrereqs };
}

async function runFetchExtractPrereq(
  prereq: Prerequisite,
  session: Session,
  driver: BrowserDriver,
  scope: Record<string, unknown>,
  tokens: Record<string, string>,
): Promise<void> {
  if (!prereq.url) {
    throw new Error(`prereq "${prereq.name}": fetch-extract requires "url" string`);
  }
  if (!prereq.vars || typeof prereq.vars !== 'object') {
    throw new Error(
      `prereq "${prereq.name}": fetch-extract requires "vars" object {name: "dot.path.into.json"}`,
    );
  }

  const resolvedUrl = interpolateVars(prereq.url, scope);
  const currentUrl = await driver.getUrl(session).catch(() => '');
  if (!currentUrl || currentUrl === 'about:blank' || currentUrl === '') {
    await driver.navigate(session, 'about:blank', { waitUntil: 'domcontentloaded' });
  }

  const httpMethod = (prereq.method ?? 'GET').toUpperCase();
  const headers = resolveHeaders(prereq.headers_map ?? { Accept: 'application/json' }, scope);
  const body = prereq.fetch_body
    ? JSON.stringify(resolveBody(prereq.fetch_body, scope))
    : undefined;
  const result = await driver.fetchInBrowser(session, resolvedUrl, {
    method: httpMethod,
    headers,
    ...(body !== undefined ? { body } : {}),
    credentials: 'omit',
  });

  if (!result.ok) {
    throw new Error(`prereq "${prereq.name}" (fetch-extract): fetch failed: ${result.error}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `prereq "${prereq.name}" (fetch-extract): HTTP ${result.status} from ${resolvedUrl}`,
    );
  }

  for (const [varName, rawPath] of Object.entries(prereq.vars)) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw new Error(
        `prereq "${prereq.name}" (fetch-extract): var "${varName}" must be a non-empty dot-path string`,
      );
    }
    const value = extractByPath(result.body, rawPath);
    if (value === undefined) {
      throw new Error(
        `prereq "${prereq.name}" (fetch-extract): var "${varName}" path "${rawPath}" did not resolve in response body`,
      );
    }
    tokens[varName] = value;
  }
}

async function runPageExtractPrereq(
  prereq: Prerequisite,
  session: Session,
  driver: BrowserDriver,
  scope: Record<string, unknown>,
  tokens: Record<string, string>,
): Promise<void> {
  if (!prereq.url) {
    throw new Error(
      `prereq "${prereq.name}": page-extract requires "url" (page to load before extracting)`,
    );
  }
  if (!prereq.vars || typeof prereq.vars !== 'object') {
    throw new Error(
      `prereq "${prereq.name}": page-extract requires "vars" object {name: {selector, attr?}}`,
    );
  }

  const resolvedUrl = interpolateVars(prereq.url, scope);
  await driver.navigate(session, resolvedUrl, { waitUntil: 'domcontentloaded' });
  for (const [varName, rawSpec] of Object.entries(prereq.vars)) {
    if (!rawSpec || typeof rawSpec !== 'object') {
      throw new Error(`prereq "${prereq.name}": var "${varName}" must be {selector, attr?}`);
    }
    const spec = rawSpec as { selector?: unknown; attr?: unknown };
    if (typeof spec.selector !== 'string' || spec.selector.length === 0) {
      throw new Error(`prereq "${prereq.name}": var "${varName}" requires a "selector" string`);
    }
    const attrName = typeof spec.attr === 'string' && spec.attr.length > 0 ? spec.attr : null;
    const value = attrName
      ? await driver.getAttribute(session, spec.selector, attrName)
      : await driver.getText(session, spec.selector);
    tokens[varName] = value;
  }
}

async function runJsEvalBrowserPrereq(
  prereq: Prerequisite,
  session: Session,
  driver: BrowserDriver,
  platform: string,
  pool: AnyPool,
  tokens: Record<string, string>,
  scope: Record<string, unknown>,
): Promise<void> {
  const bindsTo = prereq.binds ?? prereq.name;
  const resolvedUrl = interpolateVars(prereq.url ?? '', scope);
  const timeoutMs = prereq.timeout_ms ?? JS_EVAL_TIMEOUT_DEFAULT_MS;
  const expression = prereq.expression ?? '';

  // Per-call mode: args_template is body-dependent, so caching the result would
  // bind a stale signature for the wrong body. Interpolate the template against
  // the live caller scope, skip cache + refresh entirely, mint fresh on every
  // execute. Save-time validation guarantees args_template + refresh.enabled
  // is rejected, so reaching this branch means refresh is off by construction.
  if (prereq.args_template !== undefined) {
    const resolvedArgs = resolveBody(prereq.args_template, scope);
    const minted = await runJsEvalPrereq(driver, session, {
      name: prereq.name,
      url: resolvedUrl,
      expression,
      returnShape: prereq.return_shape,
      timeoutMs,
      args: resolvedArgs,
      ...(prereq.frame ? { frame: prereq.frame } : {}),
    });
    tokens[bindsTo] = minted;
    return;
  }

  // Cacheable mint-and-reuse path. Cache is keyed on (platform, bindsTo) and
  // ignores the args_template field by construction (per-call prereqs return
  // above before this point), so a cache hit always carries the same shape the
  // strategy would mint from scratch.
  const cached = readJsEvalCache(pool, platform, bindsTo);
  if (cached) {
    tokens[bindsTo] = cached;
    return;
  }

  const minted = await runJsEvalPrereq(driver, session, {
    name: prereq.name,
    url: resolvedUrl,
    expression,
    returnShape: prereq.return_shape,
    timeoutMs,
    ...(prereq.frame ? { frame: prereq.frame } : {}),
  });
  tokens[bindsTo] = minted;
  writeJsEvalCache(pool, platform, bindsTo, minted, prereq);
  schedulePrereqRefreshIfEnabled(pool, platform, prereq, async () => {
    const driver2 = pool.driverFor(session.id);
    return await runJsEvalPrereq(driver2, session, {
      name: prereq.name,
      url: resolvedUrl,
      expression,
      returnShape: prereq.return_shape,
      timeoutMs,
      ...(prereq.frame ? { frame: prereq.frame } : {}),
    });
  });
}

async function runBrowserStepPrereq(
  prereq: Prerequisite,
  session: Session,
  driver: BrowserDriver,
  args: Record<string, unknown>,
  tokens: Record<string, string>,
): Promise<void> {
  for (const step of prereq.steps || []) {
    const stepScope: Record<string, unknown> = { ...tokens, ...args };
    const resolvedStep = resolveBrowserPrereqStep(step, stepScope);
    switch (resolvedStep.action) {
      case 'navigate':
        if (resolvedStep.url) await driver.navigate(session, resolvedStep.url);
        break;
      case 'click':
        if (resolvedStep.selector) await driver.click(session, resolvedStep.selector);
        break;
      case 'type':
        if (resolvedStep.selector && resolvedStep.value) {
          await driver.type(session, resolvedStep.selector, resolvedStep.value);
        }
        break;
      case 'extract': {
        if (!resolvedStep.selector || !resolvedStep.as) break;
        const value = resolvedStep.attribute
          ? await driver.getAttribute(session, resolvedStep.selector, resolvedStep.attribute)
          : await driver.getText(session, resolvedStep.selector);
        tokens[resolvedStep.as] = value;
        break;
      }
    }
    await driver.delay(session, 300);
  }
}

/**
 * Run the browser-session-dependent prereqs on a live Playwright (or
 * driver-abstracted) session. Mutates `tokens` in place with any extracted
 * values and persists browser-method single-token prereqs into the token cache.
 * Session and driver lifetime are the caller's responsibility.
 */
export async function runBrowserPrereqs(
  browserPrereqs: Prerequisite[],
  session: Session,
  driver: BrowserDriver,
  platform: string,
  args: Record<string, unknown>,
  pool: AnyPool,
  tokenCache: TokenCache | null,
  tokens: Record<string, string>,
): Promise<void> {
  for (const prereq of browserPrereqs) {
    const scope: Record<string, unknown> = { ...tokens, ...args };

    if (prereq.kind === 'fetch-extract') {
      await runFetchExtractPrereq(prereq, session, driver, scope, tokens);
      continue;
    }

    if (prereq.kind === 'page-extract') {
      await runPageExtractPrereq(prereq, session, driver, scope, tokens);
      continue;
    }

    if (prereq.kind === 'js-eval') {
      await runJsEvalBrowserPrereq(prereq, session, driver, platform, pool, tokens, scope);
      continue;
    }

    await runBrowserStepPrereq(prereq, session, driver, args, tokens);
    const extracted = tokens[prereq.name];
    if (prereq.name && extracted && tokenCache && prereq.ttl !== null) {
      tokenCache.set(platform, prereq.name, extracted, { ttl: prereq.ttl ?? 1800 });
    }
  }
}

/**
 * Public one-shot prereq runner — used by the listener proactive-refresh
 * watcher to repopulate the token cache before a cached value's TTL expires.
 * Acquires a browser session if any browser-side prereq needs to run and closes
 * it on return. Callers that need to reuse the session for a follow-up fetch
 * (the executor's hot path) should call `scanCachedPrereqs` +
 * `runBrowserPrereqs` directly instead.
 */
export async function runPrerequisites(opts: {
  strategy: { prerequisites?: Prerequisite[]; baseUrl?: string };
  args: Record<string, unknown>;
  platform: string;
  pool: AnyPool;
  tokenCache: TokenCache | null;
  depth?: number;
  /** Account name on the platform — see klura://reference#identities. */
  identity?: string;
}): Promise<{ tokens: Record<string, string> }> {
  const { strategy, args, platform, pool, tokenCache, depth = 0, identity } = opts;
  const { tokens, browserPrereqs } = await scanCachedPrereqs(
    strategy.prerequisites,
    platform,
    args,
    pool,
    tokenCache,
    depth,
  );
  if (browserPrereqs.length === 0) return { tokens };

  const { opts: devOpts, device: resolvedDevice } = currentDeviceSessionOpts();
  const storageStatePath = skills.loadStorageStatePath(platform, identity);

  let session: Session | null = null;
  if (
    typeof strategy.baseUrl === 'string' &&
    strategy.baseUrl.length > 0 &&
    pool.tryCheckoutReadySession
  ) {
    const baseUrlForProbe = strategy.baseUrl;
    session = await pool.tryCheckoutReadySession(
      platform,
      async (s, d) => {
        const r = await d.probePageReady(s, baseUrlForProbe);
        return r.page_on_url;
      },
      identity,
    );
  }
  if (!session) {
    session = await pool.createSession({
      platform,
      ...(identity ? { identity } : {}),
      ...devOpts,
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
    });
  }
  session.device = resolvedDevice;

  try {
    const driver = pool.driverFor(session.id);
    await runBrowserPrereqs(
      browserPrereqs,
      session,
      driver,
      platform,
      args,
      pool,
      tokenCache,
      tokens,
    );
    return { tokens };
  } finally {
    await pool.endDrive(session.id);
  }
}

// In-browser fetch executor. Runs browser prerequisites to extract tokens, then
// fires the HTTP request from inside the page. Handles both `fetch` strategies
// that degraded to the browser path (TLS / bot-check fingerprint rejection on
// the Node handshake) and native `page-script` strategies.
export async function executeFetchInBrowser(
  strategy: FetchStrategy | PageScriptStrategy,
  args: Record<string, unknown>,
  platform: string,
  capability: string,
  pool: AnyPool,
  tokenCache: TokenCache | null,
  depth: number = 0,
  identity?: string,
): Promise<ExecuteResult> {
  // Generators run AFTER prereqs (see below) so they can reference the values
  // prereqs extract — e.g. a `repositoryId` generator that base64- encodes a
  // numeric db id that was just extracted from a meta tag. This makes
  // extract-then-transform flows work without a dedicated prereq type.
  const overrides = args._generated as Record<string, string> | undefined;

  // Pre-scan prerequisites to collect cached tokens without touching the
  // browser. Any prereq that can't be satisfied from cache goes into
  // `browserPrereqs` and runs against the single shared session below.
  const { tokens, browserPrereqs } = await scanCachedPrereqs(
    strategy.prerequisites,
    platform,
    args,
    pool,
    tokenCache,
    depth,
  );

  // One session for prerequisites AND the final fetch. The prereq navigation
  // lands us on the token-bearing page with live cookies + nonce in memory; the
  // fetch fires from that same page context so browser-bound auth (fingerprint
  // cookies, sec-* headers, origin) survives. No storage-state file roundtrip
  // between two short-lived containers.
  const { opts: devOpts, device: resolvedDevice } = currentDeviceSessionOpts();
  const storageStatePath = skills.loadStorageStatePath(platform, identity);

  // Ready-page checkout (see docs/pool.md). For HTTP tiers the probe only
  // requires `page_on_url` — any page already at baseUrl has the cookies +
  // headers a page-script or prereq run needs. Skips `createSession` + prereq
  // navigation on the hot path.
  let session: Session | null = null;
  if (
    typeof strategy.baseUrl === 'string' &&
    strategy.baseUrl.length > 0 &&
    pool.tryCheckoutReadySession
  ) {
    const baseUrlForProbe = strategy.baseUrl;
    session = await pool.tryCheckoutReadySession(
      platform,
      async (s, d) => {
        const r = await d.probePageReady(s, baseUrlForProbe);
        return r.page_on_url;
      },
      identity,
    );
  }
  if (!session) {
    session = await pool.createSession({
      platform,
      ...(identity ? { identity } : {}),
      ...devOpts,
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
    });
  }
  session.device = resolvedDevice;

  try {
    const driver = pool.driverFor(session.id);
    await runBrowserPrereqs(
      browserPrereqs,
      session,
      driver,
      platform,
      args,
      pool,
      tokenCache,
      tokens,
    );

    // pre_execution interrupts fire after prereqs complete (so their bindings
    // are already in `tokens`) but before the main request is composed.
    // Always-fire when observe is absent, conditional when present. Shares the
    // `tokens` table so handler-bound values are available to the main
    // request's {{interpolation}}.
    await fireInterrupts(
      (strategy as { interrupts?: readonly InterruptEntry[] }).interrupts,
      'pre_execution',
      { session, driver, tokens, args },
    );

    // Resolve generators NOW that prereqs have finished extracting tokens. Pass
    // `{...tokens, ...args}` so generator code can reference either plain args
    // OR prereq-extracted values via `args.<name>` — this is what lets a
    // base64-encoding generator consume a numeric id pulled out of a meta tag
    // moments ago. Running generators up-front instead would make
    // extract-then-transform flows impossible without a dedicated prereq type.
    const genInputArgs: Record<string, unknown> = { ...tokens, ...args };
    const { resolved: gen, needsLlm } = resolveGenerated(
      strategy.generated,
      overrides,
      genInputArgs,
    );
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

    // Merge extracted tokens + resolved generators into the caller's args, then
    // fire the fetch on the same session.
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

    // Navigate decision: observe the page's actual origin and compare against
    // the strategy's target. The "did a browser prereq run" boolean is a poor
    // proxy because cache-hit js-eval prereqs early-return without navigating —
    // queueing them in `browserPrereqs` doesn't mean we ended up on the right
    // page. Observing `driver.getUrl()` after `runBrowserPrereqs` is the ground
    // truth: if we're already on the target origin (fresh nonce captured by a
    // prereq, or warm-pool ready-page checkout landed us there) skip the
    // navigate so we don't invalidate a one-time nonce; otherwise navigate so
    // cookies + fingerprint context attach to the fetch. See
    // runtime/docs/principles.md §"Observe, don't probe" — the fetch's CORS
    // outcome is owned by the page's actual origin, not by an inferred flag.
    //
    // waitUntil: 'commit' (not 'domcontentloaded'): we only need navigation to
    // commit so cookies + TLS context attach to the subsequent fetch. Waiting
    // for DOM parse + subresource load is pure latency — typically 2-3s on
    // heavy sites — that we don't need when no value is being extracted from
    // the page. If the strategy later turns out to need DOM state, it'll add
    // a prereq; until then, saving 2-3s per warm execute is a clean win.
    const targetOrigin = (() => {
      try {
        return new URL(strategy.baseUrl).origin;
      } catch {
        return '';
      }
    })();
    const currentUrl = await driver.getUrl(session).catch(() => '');
    const currentOrigin = (() => {
      try {
        return new URL(currentUrl).origin;
      } catch {
        return '';
      }
    })();
    let fireOpts: FireRequestOptions | undefined;
    if (currentOrigin !== targetOrigin) {
      const bfs = strategy as PageScriptStrategy;
      const originTemplate = bfs.origin ?? strategy.baseUrl;
      const resolvedArgsForOrigin = strategy.params
        ? { ...mergedArgs, ...resolveBody(strategy.params, mergedArgs) }
        : mergedArgs;
      const navigateTo = interpolateVars(originTemplate, resolvedArgsForOrigin, true);
      fireOpts = { navigateTo, waitUntil: 'commit' };
    }

    return await fireRequestInSession(session, fireStrategy, mergedArgs, platform, pool, fireOpts);
  } finally {
    await pool.endDrive(session.id);
  }
}

// Headers the browser refuses to let fetch() set. Stripped silently before
// page.evaluate so strategies authored from network logs (which show these
// auto-added by Chrome) don't throw.
const FORBIDDEN_FETCH_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

function stripForbiddenHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (FORBIDDEN_FETCH_HEADERS.has(lower)) continue;
    if (lower.startsWith('proxy-') || lower.startsWith('sec-')) continue;
    out[k] = v;
  }
  return out;
}

interface FireRequestOptions {
  /** If set, navigate here first with the given waitUntil policy. */
  navigateTo?: string;
  /**
   * Navigation settle policy. Default 'domcontentloaded'. Real sites run
   * continuous analytics/telemetry pings and rarely reach a true network idle
   * state, so 'networkidle' is a timeout trap. DCL is enough for cookie-loaded
   * navigations and page-extract prereqs.
   */
  waitUntil?: 'commit' | 'domcontentloaded' | 'networkidle';
  /** Error code to return on fetch failure. Default 'fetch_failed'. */
  errorCode?: string;
}

/**
 * Fires one HTTP request from inside an existing browser session and persists
 * the session's cookies on success. Used by executeDirect, executePageScript,
 * and executeAssisted so the session lifecycle lives at the caller while the
 * request-building and fetch-in-browser plumbing lives here.
 *
 * Callers must resolve _generated values into `args` (via resolveGenerated +
 * spread into __gen) before calling — this helper does not run the generator
 * check.
 */
async function fireRequestInSession(
  session: Session,
  strategy: RequestStrategy,
  args: Record<string, unknown>,
  platform: string,
  pool: AnyPool,
  options: FireRequestOptions = {},
): Promise<ExecuteResult> {
  const { method, url, isForm, bodyObj, serializedBody } = prepareRequest(strategy, args);

  const rawHeaders: Record<string, string> = {
    ...(method !== 'GET' && bodyObj
      ? { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' }
      : {}),
    ...resolveHeaders(strategy.headers, args),
  };
  const headers = stripForbiddenHeaders(rawHeaders);

  const driver = pool.driverFor(session.id);
  if (options.navigateTo) {
    await driver.navigate(session, options.navigateTo, {
      waitUntil: options.waitUntil ?? 'domcontentloaded',
    });
  }

  const evalResult = await driver.fetchInBrowser(session, url, {
    method,
    headers,
    body: serializedBody,
  });

  // Save cookies — challenge clearance tokens, rotated sessions, sensor state.
  const statePath = skills.storageStatePath(platform);
  skills.saveStorageState(platform, '{}');
  await driver.saveStorageState(session, statePath);

  if (!evalResult.ok) {
    return {
      status: 0,
      body: {
        error: options.errorCode ?? 'fetch_failed',
        details: evalResult.error,
        ...(evalResult.diagnostics ? { fetch_diagnostics: evalResult.diagnostics } : {}),
      },
    };
  }

  const extracted = applyHtmlExtract(strategy.response, evalResult.body);
  if (!extracted.ok) {
    return {
      status: evalResult.status,
      body: { error: extracted.code, details: extracted.details },
      finalUrl: evalResult.finalUrl,
    };
  }
  const body: unknown = extracted.body;

  // Body-size guard — defense in depth. If an agent forgets to declare
  // response.format = 'html', or a JSON endpoint returns an unexpectedly large
  // payload, fail loudly with a hint instead of silently blowing the MCP
  // tool-output budget and falling back to "saved to file, Read it". Runs after
  // extraction so a correct HTML strategy benefits from the trim.
  const serialized = JSON.stringify(body);
  if (serialized.length > MAX_TOOL_OUTPUT_CHARS) {
    // HTML fallback: if the body is a raw HTML string, convert it into a
    // trimmed ariaSnapshot-shaped tree via DOMParser (inert — no scripts, no
    // page clobber; see drivers/interface.ts for the full rationale). Reuses
    // the existing trimA11yTree pipeline verbatim so Pass A + Pass D bite the
    // same way they do on start_session's output. Gives the agent enough signal
    // to identify selectors and re-save with proper response.extract, instead
    // of a dead response_too_large.
    if (typeof body === 'string' && looksLikeHtml(body)) {
      try {
        const ariaTree = await driver.htmlToAriaLikeTree(session, body);
        const trimmed = trimA11yTree(ariaTree, MAX_TOOL_OUTPUT_CHARS - 2000);
        return {
          status: evalResult.status,
          body: {
            error: 'response_too_large_html_trimmed',
            total_chars: body.length,
            a11y_tree: trimmed.tree,
            a11y_tree_truncated: trimmed.truncated,
            hint:
              'The HTML response exceeded the tool output budget. A trimmed ' +
              'a11y-style summary of the page is in a11y_tree above — use it to ' +
              'pick CSS selectors, then re-save the strategy with ' +
              '`response: {format: "html", extract: {...}}` so the next execute ' +
              'returns only the fields you need.',
          },
          finalUrl: evalResult.finalUrl,
        };
      } catch {
        // Walker errored — fall through to the generic response_too_large case
        // below. Don't infinite-loop on a single broken document.
      }
    }

    return {
      status: evalResult.status,
      body: {
        error: 'response_too_large',
        total_chars: serialized.length,
        preview: truncateString(serialized, 2000, '…'),
        hint:
          'The response body exceeds the tool output budget. For HTML responses, add ' +
          '`response: {format: "html", extract: {...}}` to the fetch strategy so the ' +
          'runtime extracts only the fields you need. For JSON endpoints, tighten the ' +
          'request so the server returns less data.',
      },
      finalUrl: evalResult.finalUrl,
    };
  }

  return {
    status: evalResult.status,
    body,
    finalUrl: evalResult.finalUrl,
  };
}
