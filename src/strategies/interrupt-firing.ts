// Interrupt firing — the edge-triggered evaluation loop that runs at strategy
// lifecycle boundaries. Never polled on a timer; each call happens at a moment
// we KNOW state just changed (step completed, response arrived, execution about
// to start).

import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import { evaluatePredicate } from './predicate-registry';
import { getInterruptHandler, type HandlerResult } from './interrupt-registry';

export type InterruptAt = 'pre_execution' | 'between_steps' | 'after_response';

export interface InterruptEntry {
  readonly name: string;
  readonly at: InterruptAt;
  readonly priority?: number;
  readonly observe?: { kind?: string; [k: string]: unknown };
  readonly handler: { kind: string; [k: string]: unknown };
}

interface InterruptFireCtx {
  readonly session: Session;
  readonly driver: BrowserDriver;
  readonly tokens: Record<string, string>;
  readonly args: Record<string, unknown>;
}

/**
 * Evaluate and fire all interrupts matching `at` in priority order. Mutates
 * `ctx.tokens` with any handler-bound values. Throws if a handler throws
 * (timeout, missing cookie, etc.) — the executor catches and converts into an
 * execute-time error with the interrupt's name.
 *
 * Silent when `interrupts` is absent / empty — zero runtime cost on the hot
 * path for strategies that don't use the feature.
 */
export async function fireInterrupts(
  interrupts: readonly InterruptEntry[] | undefined,
  at: InterruptAt,
  ctx: InterruptFireCtx,
): Promise<string[]> {
  const fired: string[] = [];
  if (!interrupts || interrupts.length === 0) return fired;

  // Stable sort: by priority desc (higher fires first), preserving array-order
  // for equal priorities. `sort` on a shallow copy so we don't mutate the
  // caller's strategy object.
  const matching = interrupts
    .filter((e) => e.at === at)
    .map((e, i) => ({ entry: e, idx: i }))
    .sort((a, b) => {
      const pa = a.entry.priority ?? 0;
      const pb = b.entry.priority ?? 0;
      if (pb !== pa) return pb - pa;
      return a.idx - b.idx;
    });

  for (const { entry } of matching) {
    // Observer evaluation. Absent observe = always-fire — the
    // unconditional-gate form.
    if (entry.observe !== undefined) {
      const matched = await evaluatePredicate(entry.observe, {
        session: ctx.session,
        driver: ctx.driver,
      });
      if (!matched) continue;
    }

    const handlerSpec = getInterruptHandler(entry.handler.kind);
    if (!handlerSpec) {
      throw new Error(
        `interrupt "${entry.name}": handler kind "${entry.handler.kind}" is not registered at execute time; validator should have caught this at save time`,
      );
    }

    let result: HandlerResult;
    try {
      result = await handlerSpec.run(entry.handler, {
        session: ctx.session,
        driver: ctx.driver,
        tokens: ctx.tokens,
        args: ctx.args,
      });
    } catch (e) {
      throw new Error(
        `interrupt "${entry.name}" (handler:"${entry.handler.kind}") failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }

    if (result.boundTokens) {
      for (const [k, v] of Object.entries(result.boundTokens)) {
        ctx.tokens[k] = v;
      }
    }
    fired.push(entry.name);
  }
  return fired;
}
