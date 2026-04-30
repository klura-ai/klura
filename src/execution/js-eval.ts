// js-eval prereq runtime helpers.
//
// js-eval runs a short JS expression inside a live browser page, validates the
// return against a declared shape, and binds the serialized value as a token.
// Mint work is cached at the pool layer so warm executes can skip it.

import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import { assertReturnShape, type JsEvalReturnShape } from '../strategies/js-eval-validators';
import { JS_EVAL_TIMEOUT_HARD_CAP_MS } from '../strategies/skills';
import { ValidationError as ValidatorError } from '../validators';
import type { AnyPool, Prerequisite } from './types';

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
  // already has a matching origin + pathname. reCAPTCHA-class minters only
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
    if (
      current &&
      target &&
      current.origin === target.origin &&
      current.pathname === target.pathname
    ) {
      navigate = false;
    }
  } catch {
    /* fall through — navigate anyway */
  }

  if (navigate) {
    try {
      await driver.navigate(session, args.url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      throw new Error(
        `prereq "${args.name}" (js-eval): failed to navigate to ${args.url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
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
    throw new Error(
      `prereq "${args.name}" (js-eval): expression evaluation failed: ${
        err instanceof Error ? err.message : String(err)
      }. The expression was: ${JSON.stringify(args.expression)}. ` +
        `Common causes: the global the expression references doesn't exist on this page, ` +
        `the page hasn't finished loading enough for the minter to be defined, ` +
        `or the expression threw at runtime.`,
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
export function readJsEvalCache(pool: AnyPool, platform: string, bindsTo: string): string | null {
  const cache = (pool as unknown as { jsEvalCache?: JsEvalCache }).jsEvalCache;
  if (!cache) return null;
  const entry = cache.get(platform, bindsTo);
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
  cache.set(platform, bindsTo, value, expiresAt);
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
    bindsTo,
    intervalMs: intervalSec * 1000,
    jitterMs: Math.max(0, jitterSec) * 1000,
    refresh: refreshFn,
  });
}
