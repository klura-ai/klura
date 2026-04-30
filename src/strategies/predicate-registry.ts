// Predicate kind registry — the extension seam for interrupt `observe`
// vocabularies. klura ships three bundled kinds (selector_visible,
// response_body_matches, js_eval) registered at module load. Deployments can
// register additional kinds via `registerPredicateKind` without editing
// validator or executor source.
//
// One source of truth: the registry drives BOTH validator shape-checking (via
// the registered Zod `shape`) AND runtime evaluation (via the
// registered `evaluate` function). Adding a kind is one `registerPredicateKind`
// call — no hardcoded enum list anywhere.
//
// Event-driven posture: the `subscribe` field on a spec is the advanced hook
// for true in-flight observation (MutationObserver, CDP events). MVP kinds
// ship with only `evaluate`; the dispatcher calls it on a lifecycle edge.

import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import { z } from 'zod';
import { ValidationError } from '../validators';
import { asBoundedScript } from './js-eval-validators';

/**
 * Context passed to a predicate's evaluate / subscribe function. Extended over
 * time — the registry interface is stable, fields are add-only.
 */
interface PredicateCtx {
  readonly session: Session;
  readonly driver: BrowserDriver;
}

type PredicateUnsubscribe = () => Promise<void> | void;

interface PredicateKindSpec {
  readonly kind: string;
  /** Per-kind shape used by save-time validation and schema rendering. */
  readonly shape: z.ZodType;
  /** Edge-triggered evaluation: called at a lifecycle boundary, returns
   *  whether the predicate is currently truthy. Must never itself loop
   *  or sleep — one observation, one answer. */
  readonly evaluate: (predicate: unknown, ctx: PredicateCtx) => Promise<boolean>;
  /** Subscribe hook: attach to a natural event source (MutationObserver,
   *  CDP, etc.) and call `onFire` the moment the condition becomes true.
   *  Returns an unsubscribe function. When present, runtime subscribes at
   *  strategy start instead of edge-evaluating. Optional — kinds without
   *  a subscribable source (arbitrary js_eval, response_body_matches
   *  against unhooked traffic) simply omit it. */
  readonly subscribe?: (
    predicate: unknown,
    ctx: PredicateCtx,
    onFire: () => void,
  ) => Promise<PredicateUnsubscribe> | PredicateUnsubscribe;
}

const registry = new Map<string, PredicateKindSpec>();

export function registerPredicateKind(spec: PredicateKindSpec): void {
  if (registry.has(spec.kind)) {
    throw new Error(`predicate kind "${spec.kind}" is already registered`);
  }
  registry.set(spec.kind, spec);
}

export function getPredicateKind(kind: string): PredicateKindSpec | undefined {
  return registry.get(kind);
}

export function listPredicateKinds(): readonly string[] {
  return Array.from(registry.keys());
}

/** Evaluate a predicate via the registry. Unknown kinds evaluate to
 * false — the validator catches unknown kinds at save time, so an
 *  unknown kind at execute time means someone bypassed the save path. */
export async function evaluatePredicate(
  predicate: { kind?: string } | undefined,
  ctx: PredicateCtx,
): Promise<boolean> {
  if (!predicate || typeof predicate.kind !== 'string') return false;
  const spec = registry.get(predicate.kind);
  if (!spec) return false;
  try {
    return await spec.evaluate(predicate, ctx);
  } catch {
    // Predicates must never throw into the dispatcher — a broken predicate
    // should be "condition not matched," not a runtime crash.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bundled kinds — registered at module load.
// ---------------------------------------------------------------------------

const EVAL_TIMEOUT = { timeoutMs: 5_000 };

registerPredicateKind({
  kind: 'selector_visible',
  shape: z
    .object({
      kind: z.literal('selector_visible'),
      selector: z
        .string()
        .min(1)
        .describe('CSS selector; predicate is truthy when the element is present AND visible'),
    })
    .strict(),
  async evaluate(predicate, { session, driver }) {
    const p = predicate as { selector: string };
    const raw = await driver.evaluateExpression(
      session,
      `(() => { const el = document.querySelector(${JSON.stringify(p.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; })()`,
      EVAL_TIMEOUT,
    );
    const rect = raw as { w?: number; h?: number } | null;
    return !!(rect && (rect.w ?? 0) > 0 && (rect.h ?? 0) > 0);
  },
});

registerPredicateKind({
  kind: 'response_body_matches',
  shape: z
    .object({
      kind: z.literal('response_body_matches'),
      pattern: z.string().min(1).describe('regex source (JavaScript flavor); truthy on match'),
    })
    .strict(),
  async evaluate(predicate, { session, driver }) {
    const p = predicate as { pattern: string };
    const html = await driver.evaluateExpression(
      session,
      '(() => document.documentElement.outerHTML)()',
      EVAL_TIMEOUT,
    );
    return typeof html === 'string' && new RegExp(p.pattern).test(html);
  },
});

registerPredicateKind({
  kind: 'js_eval',
  shape: z
    .object({
      kind: z.literal('js_eval'),
      expression: z
        .string()
        .min(1)
        .describe('async-compatible JS returning a truthy/falsy value')
        .superRefine((v, ctx) => {
          const where = 'expression';
          try {
            asBoundedScript(v, where);
          } catch (e) {
            ctx.addIssue({
              code: 'custom',
              message: e instanceof ValidationError ? e.message : String(e),
            });
          }
        }),
    })
    .strict(),
  async evaluate(predicate, { session, driver }) {
    const p = predicate as { expression: string };
    const raw = await driver.evaluateExpression(
      session,
      `(async () => { return (${p.expression}); })()`,
      EVAL_TIMEOUT,
    );
    return !!raw;
  },
});
