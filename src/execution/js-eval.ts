// js-eval prereq runtime helpers.
//
// js-eval runs a short JS expression inside a live browser page, validates the
// return against a declared shape, and binds the serialized value as a token.
// Mint work is cached at the pool layer so warm executes can skip it.

import { createHash } from 'crypto';
import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import { assertReturnShape, type JsEvalReturnShape } from '../strategies/js-eval-validators';
import { JS_EVAL_TIMEOUT_HARD_CAP_MS } from '../strategies/skills';
import { ValidationError as ValidatorError } from '../validators';
import type { AnyPool, Prerequisite } from './types';
import {
  assessNavigationReach,
  describeNavigationReachMiss,
  NavigationReachError,
} from './navigation-reach';

/**
 * Cache key for a js-eval prereq's minted value. Keyed on the binding name AND
 * a hash of the expression, because a changed expression is a genuinely
 * different derivation: a deploy drift or an `update_strategy` that re-derives
 * a rotating token (e.g. `__app_c.d.nonce` → `__app_s.cz.nonce`) must NOT reuse
 * the value minted by the old expression. Without the expression component the
 * stale value survives the change and replays — the classic failure is an old
 * nonce POSTed after the page rotated it, returning 401. Falls back to the bare
 * binding when no expression is supplied (preserves behavior for callers that
 * key by binding alone).
 */
function jsEvalCacheKey(bindsTo: string, expression?: string): string {
  if (typeof expression !== 'string' || expression.length === 0) return bindsTo;
  const hash = createHash('sha256').update(expression).digest('hex').slice(0, 16);
  return `${bindsTo}\u0000${hash}`;
}

// Shape of the pool-side js-eval cache that execution reads from. Defined here
// as a structural type so test stubs and the real Pool implementation can both
// satisfy it without a circular import from pool.ts.
interface JsEvalCache {
  get(platform: string, bindsTo: string): { value: string; expiresAt: number | null } | null;
  set(platform: string, bindsTo: string, value: string, expiresAt: number | null): void;
  schedule(opts: {
    platform: string;
    bindsTo: string;
    intervalMs: number;
    jitterMs: number;
    refresh: () => Promise<string>;
  }): void;
  cancel(platform: string, bindsTo?: string): void;
}

interface JsEvalRuntimeArgs {
  name: string;
  url: string;
  expression: string;
  returnShape: JsEvalReturnShape | undefined;
  timeoutMs: number;
  /** Per-call payload exposed inside the expression as the `args` identifier.
   *  Already interpolated against the caller scope by the dispatcher; this
   *  layer just forwards. Undefined for cacheable mint-and-reuse prereqs. */
  args?: Record<string, unknown>;
  /** CSS selector for an iframe — when set, the expression runs inside the
   *  iframe's contentFrame instead of the main page. */
  frame?: string;
  /** Require the exact resolved URL before evaluation. Direct capability
   *  results use this so query/hash-bound entities cannot inherit a warm page. */
  requireExactUrl?: boolean;
  /** Browser-executor navigation boundary. It applies the shared local origin
   *  scheduler and deadline before delegating to the driver. */
  navigate?: (url: string) => Promise<void>;
}

/**
 * Interpret the one failure shape that reads as a coding mistake and is not:
 * an in-page fetch parsed as JSON that was handed a document instead.
 *
 * The engine reports it as a SyntaxError about an unexpected `<`, which sends
 * the author to check their parsing. The parsing is fine — the endpoint refused
 * the request and answered with markup: an interstitial, a login wall, or a
 * gated API path. Observed across eight consecutive saves in one session, each
 * one re-deriving the same fetch because nothing said the response was a page.
 *
 * Matching the engine's error text is narrow but real coupling. It is admissible
 * here because the string comes from the JS runtime in a stable format, not from
 * a site or a model, and because both halves must hold: a JSON-parse failure AND
 * an offending token that opens a tag. A miss costs the generic advice below.
 */
function describeMarkupWhereJsonExpected(detail: string): string | null {
  const parseFailed = /is not valid JSON|JSON\.parse|Unexpected token/.test(detail);
  const gotMarkup = /Unexpected token .?<|"<[a-zA-Z!/]/.test(detail);
  if (!parseFailed || !gotMarkup) return null;
  return (
    `The response was markup, not JSON — the parse is not the problem. Something answered this ` +
    `request with a document: an endpoint that refuses unauthenticated or non-browser callers, a ` +
    `consent or anti-abuse interstitial, or a login wall. Check what that document is before ` +
    `changing the expression. If the endpoint is gated, the data a caller needs is often in the ` +
    `page the site does serve — read that instead of the API path.`
  );
}
/**
 * Run a js-eval prereq's expression against an existing session. Navigates to
 * the prereq's declared URL if the session isn't already there, evaluates the
 * expression with the declared timeout, and validates the return shape. Returns
 * the serialized value ready to bind as a token.
 */
export async function runJsEvalPrereq(
  driver: BrowserDriver,
  session: Session,
  args: JsEvalRuntimeArgs,
): Promise<string> {
  if (!args.url) {
    throw new Error(`prereq "${args.name}" (js-eval): missing url`);
  }
  if (!args.expression) {
    throw new Error(`prereq "${args.name}" (js-eval): missing expression`);
  }
  if (!args.returnShape) {
    throw new Error(
      `prereq "${args.name}" (js-eval): missing return_shape — every js-eval prereq must declare ` +
        `a return_shape so the runtime can validate the minted value`,
    );
  }

  // Warm-reuse fast path: skip the navigate if the session's current URL
  // already has a matching origin + pathname. Challenge-token minters only
  // exist on warm pages, so we should not bounce the page around between mints.
  // If the session is on about:blank or a wildly different URL, do navigate —
  // cold mints always pay the navigation cost.
  let navigate = true;
  try {
    const currentUrl = await driver.getUrl(session);
    const current = (() => {
      try {
        return new URL(currentUrl);
      } catch {
        return null;
      }
    })();
    const target = (() => {
      try {
        return new URL(args.url);
      } catch {
        return null;
      }
    })();
    const reusable =
      current &&
      target &&
      (args.requireExactUrl
        ? current.href === target.href
        : current.origin === target.origin && current.pathname === target.pathname);
    if (reusable) {
      // start_session can expose the target URL before its initial navigation
      // reaches DOMContentLoaded. Reusing that page immediately races the
      // js-eval expression against a document that is still loading. Check the
      // browser's crisp lifecycle state once at this boundary; settled warm
      // pages keep the fast path, while loading pages navigate with the
      // driver's DOMContentLoaded guarantee.
      const readyState = await driver.evaluateExpression(session, 'document.readyState', {
        timeoutMs: Math.min(args.timeoutMs, 1_000),
      });
      navigate = readyState !== 'interactive' && readyState !== 'complete';
    }
  } catch {
    /* fall through — navigate anyway */
  }

  if (navigate) {
    try {
      if (args.navigate) {
        await args.navigate(args.url);
      } else {
        await driver.navigate(session, args.url, { waitUntil: 'domcontentloaded' });
      }
    } catch (err) {
      throw new Error(
        `prereq "${args.name}" (js-eval): failed to navigate to ${args.url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    // Navigation resolving proves a document loaded, not that it is the right
    // one. An origin that gates some visitors serves the gate under a 200 and
    // the expression would run against it, so the arrival is checked before
    // anything is evaluated. Only a navigation this call performed is checked:
    // the warm-reuse path above already matched origin + pathname.
    let miss = null;
    try {
      miss = assessNavigationReach(args.url, await driver.getUrl(session));
    } catch {
      /* the driver could not report a URL — proceed rather than accuse */
    }
    if (miss) {
      throw new NavigationReachError(describeNavigationReachMiss(miss, args.name), miss, args.name);
    }
  }

  const cappedTimeout = Math.max(1, Math.min(args.timeoutMs, JS_EVAL_TIMEOUT_HARD_CAP_MS));

  let raw: unknown;
  try {
    raw = await driver.evaluateExpression(session, args.expression, {
      timeoutMs: cappedTimeout,
      ...(args.args !== undefined ? { args: args.args } : {}),
      ...(args.frame ? { frame: args.frame } : {}),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `prereq "${args.name}" (js-eval): expression evaluation failed: ${detail}. ` +
        `The expression was: ${JSON.stringify(args.expression)}. ` +
        (describeMarkupWhereJsonExpected(detail) ??
          `Common causes: the global the expression references doesn't exist on this page, ` +
            `the page hasn't finished loading enough for the minter to be defined, ` +
            `or the expression threw at runtime.`),
      { cause: err },
    );
  }

  try {
    return assertReturnShape(raw, args.returnShape, `prereq "${args.name}" (js-eval) result`);
  } catch (err) {
    if (err instanceof ValidatorError) {
      const preview = previewRuntimeValue(raw);
      throw new Error(
        `invalid_prereq_result: ${err.message}. Observed value: ${preview}. ` +
          `The expression returned a value that does not match the declared return_shape — ` +
          `the strategy is degraded until a fresh discovery re-mints it.`,
        { cause: err },
      );
    }
    throw err;
  }
}

function previewRuntimeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') {
    return v.length <= 80 ? JSON.stringify(v) : JSON.stringify(v.slice(0, 77) + '…');
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length <= 120 ? s : s.slice(0, 117) + '…';
  } catch {
    return `<unserializable ${typeof v}>`;
  }
}

/**
 * Read a value from the pool's js-eval cache, if one exists and is still fresh.
 * Returns `null` when the pool doesn't implement the cache (e.g. tests with a
 * bare stub pool), when nothing was ever cached for this platform+binding, or
 * when the cached entry has passed its expiry.
 */
export function readJsEvalCache(
  pool: AnyPool,
  platform: string,
  bindsTo: string,
  expression?: string,
): string | null {
  const cache = (pool as unknown as { jsEvalCache?: JsEvalCache }).jsEvalCache;
  if (!cache) return null;
  const entry = cache.get(platform, jsEvalCacheKey(bindsTo, expression));
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return null;
  return entry.value;
}

export function writeJsEvalCache(
  pool: AnyPool,
  platform: string,
  bindsTo: string,
  value: string,
  prereq: Prerequisite,
): void {
  const cache = (pool as unknown as { jsEvalCache?: JsEvalCache }).jsEvalCache;
  if (!cache) return;
  const intervalSec = prereq.refresh?.interval_seconds;
  const expiresAt =
    prereq.refresh?.enabled && typeof intervalSec === 'number' && intervalSec > 0
      ? Date.now() + intervalSec * 1000
      : null;
  cache.set(platform, jsEvalCacheKey(bindsTo, prereq.expression), value, expiresAt);
}

export function schedulePrereqRefreshIfEnabled(
  pool: AnyPool,
  platform: string,
  prereq: Prerequisite,
  refreshFn: () => Promise<string>,
): void {
  const cache = (pool as unknown as { jsEvalCache?: JsEvalCache }).jsEvalCache;
  if (!cache) return;
  if (!prereq.refresh?.enabled) return;
  const intervalSec = prereq.refresh.interval_seconds;
  if (typeof intervalSec !== 'number' || intervalSec <= 0) return;
  const bindsTo = prereq.binds ?? prereq.name;
  const jitterSec = prereq.refresh.jitter_seconds ?? 0;
  cache.schedule({
    platform,
    // Refresh writes back to the same cache slot reads use — key it on the
    // expression too so a re-derived prereq doesn't refresh a stale binding.
    bindsTo: jsEvalCacheKey(bindsTo, prereq.expression),
    intervalMs: intervalSec * 1000,
    jitterMs: Math.max(0, jitterSec) * 1000,
    refresh: refreshFn,
  });
}
