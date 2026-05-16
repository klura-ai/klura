import type { BrowserDriver } from '../../drivers/interface';
import type { Session } from '../../drivers/types/session';
import { ValidationError } from '../../validators';
import { assertReturnShape, asReturnShape, type JsEvalReturnShape } from '../js-eval-validators';
import { JS_EVAL_TIMEOUT_DEFAULT_MS, JS_EVAL_TIMEOUT_HARD_CAP_MS } from '../skills';
import { isLoginWallUrl, tryGetUrl } from '../../response/auth-wall';
import { isTransientNavigationError } from './errors';

/** Build a stand-in `args` object for probe-time evaluation of a per-call
 *  js-eval prereq. The probe runs without a real caller scope (no execute()
 *  payload exists at save time), so each declared key is bound to a benign
 *  string placeholder. The expression gets to run end-to-end — proving the
 *  signer is reachable and returns a value matching `return_shape` — without
 *  requiring fixture data per-prereq. The shape is the same shape the runtime
 *  hands the expression at execute time: `{<key>: <value>}`. */
function stubArgsForProbe(template: Record<string, unknown>): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(template)) {
    stub[key] = '__klura_probe_stub__';
  }
  return stub;
}

/** Compare two URLs by origin. Both must parse as valid URLs and resolve to
 *  the same `protocol + host + port` for this to return true. Used to decide
 *  whether the save-time probe can reuse the session's existing page or has
 *  to navigate fresh. */
function haveSameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export interface JsEvalPrereq {
  name: string;
  kind: 'js-eval';
  url: string;
  expression: string;
  binds: string;
  return_shape: JsEvalReturnShape;
  timeout_ms: number;
  /** Per-call payload template — when present, the probe synthesizes a
   *  placeholder `args` object (keys preserved, values stubbed) so the
   *  expression can run end-to-end at save time without real caller input. */
  args_template?: Record<string, unknown>;
  /** CSS selector for an iframe — when present, the probe evaluates the
   *  expression inside that frame. */
  frame?: string;
}

export function extractJsEvalPrereqs(data: Record<string, unknown>): JsEvalPrereq[] {
  if (data.strategy !== 'fetch' && data.strategy !== 'page-script') return [];
  const prerequisites = data.prerequisites;
  if (!Array.isArray(prerequisites)) return [];
  const out: JsEvalPrereq[] = [];
  for (const raw of prerequisites) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (p.kind !== 'js-eval') continue;
    if (typeof p.url !== 'string' || typeof p.name !== 'string') continue;
    if (typeof p.expression !== 'string' || typeof p.binds !== 'string') continue;
    // asReturnShape throws ValidationError, which we let the outer skills.ts
    // validator already catch. By the time we read it here, shape has been
    // validated at least once. Re-narrow defensively.
    let shape: JsEvalReturnShape;
    try {
      shape = asReturnShape(p.return_shape, `prerequisite "${p.name}".return_shape`);
    } catch {
      continue;
    }
    const timeout =
      typeof p.timeout_ms === 'number' && p.timeout_ms > 0
        ? p.timeout_ms
        : JS_EVAL_TIMEOUT_DEFAULT_MS;
    out.push({
      name: p.name,
      kind: 'js-eval',
      url: p.url,
      expression: p.expression,
      binds: p.binds,
      return_shape: shape,
      timeout_ms: timeout,
      ...(p.args_template && typeof p.args_template === 'object'
        ? { args_template: p.args_template as Record<string, unknown> }
        : {}),
      ...(typeof p.frame === 'string' && p.frame.length > 0 ? { frame: p.frame } : {}),
    });
  }
  return out;
}

// Probe a js-eval prereq against a live browser session. Navigates to the
// prereq's url, evaluates the expression with its declared timeout, and
// validates the return against the declared shape. Rejects the save with
// `invalid_strategy: ...` if anything fails — the three most common
// hallucination modes are: 1. Agent referenced a global that doesn't exist on
// this page (undefined) 2. Agent declared kind: "string" but the expression
// returns a Promise that never resolves (timeout) 3. Agent's return_shape
// doesn't match what the expression actually produced at runtime (e.g. object
// vs string)
//
// All three are caught at save time so the agent can self-correct in the same
// turn, before the degraded strategy ever lands in the skill corpus.
export async function probeOneJsEvalPrereq(
  driver: BrowserDriver,
  session: Session,
  prereq: JsEvalPrereq,
  warnings: string[],
): Promise<void> {
  // Retry-once on transient context-destroyed errors. Observed failure mode
  // (2026-04-21 wiki edit flow): page finishes async rehydration after
  // domcontentloaded and triggers a redirect while the probe's evaluate is in
  // flight. First attempt throws "Execution context was destroyed"; second
  // attempt lands on the settled page and succeeds. Never masks real expression
  // bugs — a TypeError / SyntaxError throws on BOTH attempts and the second
  // rethrow carries the real error.
  let lastErr: unknown;
  let raw: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // Reuse the session's existing page when its origin already matches the
      // prereq's. The agent verified the expression works against the live
      // page state seconds ago via save_verified_expression — the page has
      // its async-loaded scripts, in-memory globals, and post-navigation
      // hydration in place. A fresh navigate at probe time tears that down
      // and re-enters the page in a half-bootstrapped state where late-
      // loading SDKs / page-globals the expression depends on may not exist
      // yet, causing the probe to throw on a value the live session can
      // produce reliably. Same-origin reuse keeps the probe consistent with
      // what the agent verified; cross-origin still navigates because the
      // expression's contract names a different origin.
      const currentUrl = await tryGetUrl(driver, session);
      const sameOrigin = haveSameOrigin(currentUrl, prereq.url);
      if (!sameOrigin) {
        await driver.navigate(session, prereq.url, { waitUntil: 'domcontentloaded' });
      }
    } catch (err) {
      if (attempt === 1 && isTransientNavigationError(err)) {
        lastErr = err;
        continue;
      }
      throw new Error(
        `invalid_strategy: prerequisite "${prereq.name}" (js-eval) failed save-time probe — ` +
          `could not navigate to ${prereq.url}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // Login-wall soft-warn — the expression typically reads from page globals
    // that exist on the authenticated route; on /login they will not.
    const finalUrl = await tryGetUrl(driver, session);
    if (isLoginWallUrl(finalUrl)) {
      warnings.push(
        `prerequisite "${prereq.name}" (js-eval) navigated to ${prereq.url} but landed on a login wall ` +
          `at ${finalUrl}. Storage-state may be stale or missing — re-login via start_remote_session and ` +
          `save again. Strategy saved without expression-result verification for this prereq.`,
      );
      return;
    }

    try {
      raw = await driver.evaluateExpression(session, prereq.expression, {
        timeoutMs: Math.min(prereq.timeout_ms, JS_EVAL_TIMEOUT_HARD_CAP_MS),
        ...(prereq.args_template ? { args: stubArgsForProbe(prereq.args_template) } : {}),
        ...(prereq.frame ? { frame: prereq.frame } : {}),
      });
      lastErr = undefined;
      break;
    } catch (err) {
      if (attempt === 1 && isTransientNavigationError(err)) {
        lastErr = err;
        continue;
      }
      // SPA-bootstrap race: the page just transitioned (e.g. a chat UI moved
      // from / to /c/<conv-id>) and the global the expression names is still
      // being loaded async. The agent verified the same expression worked
      // seconds ago via save_verified_expression — refusing it here for a
      // load-order race the agent can't see is exactly the friction the
      // runtime should absorb. Crisp by construction: ReferenceError is a
      // built-in JS error class with a fixed message shape; the polled check
      // (`typeof window[name] !== 'undefined'`) is binary set membership.
      const refMatch =
        err instanceof Error
          ? /ReferenceError: ([A-Za-z_$][A-Za-z0-9_$]*) is not defined/.exec(err.message)
          : null;
      if (refMatch && attempt === 1) {
        const globalName = refMatch[1] as string;
        const POLL_INTERVAL_MS = 200;
        const POLL_TIMEOUT_MS = 3000;
        const start = Date.now();
        let appeared = false;
        while (Date.now() - start < POLL_TIMEOUT_MS) {
          try {
            const present = await driver.evaluateExpression(
              session,
              `typeof window[${JSON.stringify(globalName)}] !== "undefined" || typeof globalThis[${JSON.stringify(globalName)}] !== "undefined"`,
              { timeoutMs: 1000 },
            );
            if (present === true) {
              appeared = true;
              break;
            }
          } catch {
            /* page in transition — keep polling */
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (appeared) {
          try {
            raw = await driver.evaluateExpression(session, prereq.expression, {
              timeoutMs: Math.min(prereq.timeout_ms, JS_EVAL_TIMEOUT_HARD_CAP_MS),
              ...(prereq.args_template ? { args: stubArgsForProbe(prereq.args_template) } : {}),
              ...(prereq.frame ? { frame: prereq.frame } : {}),
            });
            lastErr = undefined;
            break;
          } catch {
            /* fall through to existing rejection — global appeared but
             * expression still fails, so the bug is in the expression */
          }
        }
        // Global never appeared OR retry still failed → fall through.
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Crash-during-probe: the page tab itself crashed (Chromium OOM on a
      // heavy bundle, navigator process death, etc). This is structurally
      // different from "the expression threw" — the runtime physically
      // can't verify ANY expression on a corpse. Surface with a marker the
      // save-time call site can recognize and convert into an ackable
      // warning, instead of forcing the agent into a third-session retry
      // that will hit the same crash. See `save_probe_target_crashed` in
      // save-strategy.ts.
      if (/Target crashed|page\.evaluate.*crashed|page has been closed/i.test(msg)) {
        throw new Error(
          `invalid_strategy: save_probe_target_crashed: prerequisite "${prereq.name}" (js-eval) — ` +
            `the page tab crashed during save-time probe (${msg}). The runtime physically can't ` +
            `verify the expression on a crashed tab, but the strategy may still be correct if you ` +
            `verified the underlying call earlier this session via js_eval. Ack via ` +
            `notes.save_warnings_acked: [{kind: "save_probe_target_crashed", reason: "<one-sentence ` +
            `reason that QUOTES a substring (≥40 chars) of a prior js_eval expression from this ` +
            `session that exercised the same module/global>"}]. The runtime will validate the ` +
            `quoted substring appears in session.jsEvalCalls. Anti-canned: prose-only reasons rejected. ` +
            `Expression was: ${JSON.stringify(prereq.expression).slice(0, 240)}.`,
          { cause: err },
        );
      }
      throw new Error(
        `invalid_strategy: prerequisite "${prereq.name}" (js-eval) failed save-time probe — ` +
          `evaluating the expression on ${prereq.url} threw: ${msg}. ` +
          `The expression was: ${JSON.stringify(prereq.expression)}. ` +
          `The LLM likely referenced a global that doesn't exist, called into an object ` +
          `that the page hasn't initialized yet, or wrote an expression that throws. ` +
          `Re-inspect the page in discovery: open devtools, type the expression into the ` +
          `console, and confirm it returns a usable value before saving.`,
        { cause: err },
      );
    }
  }
  if (lastErr !== undefined) {
    // Both attempts threw transient — surface the last one so the agent sees
    // the actual error rather than a silent retry-exhausted state.
    throw new Error(
      `invalid_strategy: prerequisite "${prereq.name}" (js-eval) failed save-time probe after one retry — ` +
        `the page context kept getting torn down by navigation. Last error: ${lastErr instanceof Error ? lastErr.message : JSON.stringify(lastErr)}. ` +
        `The target URL (${prereq.url}) may be redirecting or async-rehydrating. ` +
        `Point the prereq's \`url\` at the post-redirect page directly.\n\n` +
        `See klura://reference#js-eval for the full prereq schema (return_shape, async-expression rules, refresh).`,
      { cause: lastErr instanceof Error ? lastErr : undefined },
    );
  }

  try {
    assertReturnShape(raw, prereq.return_shape, `prerequisite "${prereq.name}" (js-eval) result`);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new Error(
        `invalid_strategy: ${err.message} at save-time probe on ${prereq.url}. ` +
          `The expression ran without throwing but produced a value that does not match ` +
          `the declared return_shape. Either the declared shape is wrong (update ` +
          `return_shape to match what the site actually returns) or the expression is ` +
          `wrong (rewrite so it returns the intended shape). ` +
          `Common cause: the expression returns a Promise; the runtime wraps it in an async IIFE, ` +
          `but if your expression is \`somePromise.then(t => t)\` the resolved value is whatever the promise yielded — ` +
          `inspect it (e.g. \`js_eval\` the same expression in the live page) before declaring its shape.\n\n` +
          `See klura://reference#js-eval for the full prereq schema (return_shape kinds, required_keys, examples).`,
        { cause: err },
      );
    }
    throw err;
  }
}
