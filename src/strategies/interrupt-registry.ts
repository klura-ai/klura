// Interrupt handler registry — the extension seam for
// `strategy.interrupts[].handler`. klura ships one bundled kind (`user-assist`,
// which routes human-handoff through the active remote backend). Deployments
// can register additional handler kinds via `registerInterruptHandler` at
// startup without editing validator or executor source.
//
// One source of truth: the registry drives BOTH validator shape-checking (via
// a Zod `shape`) AND runtime dispatch (via `run`). Adding a kind is
// one `registerInterruptHandler` call — no hardcoded enum list elsewhere.
//
// See runtime/docs/principles.md §"Pluggability is welcome" — the registry is a
// direct instance of that clause.

import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import { z } from 'zod';
import { ValidationError } from '../validators';
import { asBoundedScript } from './js-eval-validators';
import { getActiveRemoteBackend } from '../remote/backend';
import { interpolateVars } from '../execution/vars';

/** Context passed to an interrupt handler's run function. Mutating
 * `tokens` is the handler's one-way channel for binding values into
 *  subsequent step / body / header interpolation. */
interface HandlerCtx {
  readonly session: Session;
  readonly driver: BrowserDriver;
  readonly tokens: Record<string, string>;
  readonly args: Record<string, unknown>;
}

export interface HandlerResult {
  /** Optional: a token map to merge into `ctx.tokens`. Separate from
   *  mutating `ctx.tokens` directly so handlers can compute the result
   *  before deciding whether to commit it (e.g. timeout → no bind). */
  readonly boundTokens?: Record<string, string>;
  /** Set by the `user-assist` handler when the operator indicates they
   *  did NOT complete the task (timeout, bail). The executor uses this
   *  to decide whether to continue or fail the strategy. */
  readonly operatorAborted?: boolean;
}

interface InterruptHandlerSpec {
  readonly kind: string;
  readonly shape: z.ZodType;
  readonly run: (handler: unknown, ctx: HandlerCtx) => Promise<HandlerResult>;
}

const registry = new Map<string, InterruptHandlerSpec>();

export function registerInterruptHandler(spec: InterruptHandlerSpec): void {
  if (registry.has(spec.kind)) {
    throw new Error(`interrupt handler kind "${spec.kind}" is already registered`);
  }
  registry.set(spec.kind, spec);
}

export function getInterruptHandler(kind: string): InterruptHandlerSpec | undefined {
  return registry.get(kind);
}

export function listInterruptHandlerKinds(): readonly string[] {
  return Array.from(registry.keys());
}

// ---------------------------------------------------------------------------
// Bundled "user-assist" handler — lifts the prior user-assist-prereq body.
// ---------------------------------------------------------------------------

const USER_ASSIST_TIMEOUT_DEFAULT_MS = 120_000;
const USER_ASSIST_TIMEOUT_HARD_CAP_MS = 600_000;

const bindFromCookieSchema = z
  .object({
    kind: z.literal('cookie'),
    name: z.string().min(1).describe('cookie name to read'),
  })
  .strict();

const bindFromSelectorSchema = z
  .object({
    kind: z.literal('selector'),
    selector: z.string().min(1).describe('CSS selector'),
    attr: z.string().optional().describe('attribute to read; omit for text content'),
  })
  .strict();

const bindFromJsEvalSchema = z
  .object({
    kind: z.literal('js-eval'),
    expression: z
      .string()
      .min(1)
      .describe('async-compatible JS returning the token')
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
  .strict();

const bindFromSchema = z.discriminatedUnion('kind', [
  bindFromCookieSchema,
  bindFromSelectorSchema,
  bindFromJsEvalSchema,
]);

function validateBindFrom(value: unknown, where: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${where} must be a bind_from object {kind, ...}`;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    return `${where}.kind must be a string (one of: "cookie", "selector", "js-eval")`;
  }
  if (kind !== 'cookie' && kind !== 'selector' && kind !== 'js-eval') {
    return `${where}.kind = ${JSON.stringify(kind)} is not allowed; must be one of: "cookie", "selector", "js-eval"`;
  }
  const parsed = bindFromSchema.safeParse(value);
  if (parsed.success) return null;
  const issues = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${where}.${issue.path.join('.')}` : where;
    if (issue.code === 'invalid_type' && /received undefined/.test(issue.message)) {
      return `${path} is required`;
    }
    return `${path}: ${issue.message}`;
  });
  return issues.length > 0 ? issues.join('; ') : null;
}

registerInterruptHandler({
  kind: 'user-assist',
  shape: z
    .object({
      kind: z.literal('user-assist'),
      message: z.string().min(1).describe('what the operator sees in the remote viewer'),
      url: z
        .string()
        .optional()
        .describe("page to open in the viewer; defaults to session's current URL"),
      binds: z
        .string()
        .min(1)
        .optional()
        .describe('token name; becomes {{<binds>}} in endpoint/body/headers'),
      bind_from: bindFromSchema.optional().describe('how to mint the token after operator done'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(
          USER_ASSIST_TIMEOUT_HARD_CAP_MS,
          `exceeds the hard cap of ${USER_ASSIST_TIMEOUT_HARD_CAP_MS}ms`,
        )
        .optional()
        .describe(`default ${USER_ASSIST_TIMEOUT_DEFAULT_MS}`),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.bind_from !== undefined) {
        const err = validateBindFrom(value.bind_from, 'bind_from');
        if (err) ctx.addIssue({ code: 'custom', path: ['bind_from'], message: err });
      }
      if (value.timeout_ms !== undefined) {
        const v = value.timeout_ms;
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
          ctx.addIssue({
            code: 'custom',
            path: ['timeout_ms'],
            message: `must be a positive integer (got ${JSON.stringify(v)})`,
          });
        }
        if (v > USER_ASSIST_TIMEOUT_HARD_CAP_MS) {
          ctx.addIssue({
            code: 'custom',
            path: ['timeout_ms'],
            message: `= ${v} exceeds the hard cap of ${USER_ASSIST_TIMEOUT_HARD_CAP_MS}ms`,
          });
        }
      }
    }),

  async run(handler, ctx) {
    const h = handler as {
      message: string;
      url?: string;
      binds?: string;
      bind_from?: { kind: 'cookie' | 'selector' | 'js-eval'; [k: string]: unknown };
      timeout_ms?: number;
    };

    // Navigate first if `url` is supplied. The prereq/interrupt may target a
    // different page than the one the agent is currently on (e.g. the "verify
    // your account" URL returned by a challenge response).
    if (typeof h.url === 'string' && h.url.length > 0) {
      const resolvedUrl = interpolateVars(h.url, ctx.args);
      await ctx.driver.navigate(ctx.session, resolvedUrl, { waitUntil: 'domcontentloaded' });
    }

    const timeoutMs = h.timeout_ms ?? USER_ASSIST_TIMEOUT_DEFAULT_MS;
    const backend = getActiveRemoteBackend();
    const remoteHandle = await backend.start(ctx.session.id, ctx.driver, ctx.session, {
      mode: 'auto',
      prompt: h.message,
    });
    try {
      const result = await backend.waitForDone(remoteHandle, timeoutMs);
      if (!result.done) {
        throw new ValidationError(
          `interrupt.user-assist`,
          `timed out after ${timeoutMs}ms (reason: ${result.reason ?? 'unknown'}). Operator did not signal done.`,
        );
      }
    } finally {
      await backend.stop(remoteHandle).catch(() => {
        // best-effort teardown
      });
    }

    if (h.binds && h.bind_from) {
      const minted = await extractUserAssistToken(h.bind_from, ctx);
      return { boundTokens: { [h.binds]: minted } };
    }
    return {};
  },
});

async function extractUserAssistToken(
  bindFrom: { kind: string; [k: string]: unknown },
  ctx: HandlerCtx,
): Promise<string> {
  const evalTimeout = { timeoutMs: 5_000 };
  if (bindFrom.kind === 'cookie') {
    const name = bindFrom.name as string;
    const nameJson = JSON.stringify(name);
    const raw = await ctx.driver.evaluateExpression(
      ctx.session,
      `(() => {
        const target = ${nameJson};
        for (const part of document.cookie.split(';')) {
          const trimmed = part.trim();
          const eq = trimmed.indexOf('=');
          if (eq === -1) continue;
          if (trimmed.slice(0, eq) === target) return decodeURIComponent(trimmed.slice(eq + 1));
        }
        return null;
      })()`,
      evalTimeout,
    );
    if (typeof raw !== 'string') {
      throw new ValidationError(
        `interrupt.user-assist.bind_from`,
        `cookie "${name}" not present after operator signaled done`,
      );
    }
    return raw;
  }
  if (bindFrom.kind === 'selector') {
    const selector = bindFrom.selector as string;
    const attr =
      typeof bindFrom.attr === 'string' && bindFrom.attr.length > 0 ? bindFrom.attr : null;
    return attr
      ? await ctx.driver.getAttribute(ctx.session, selector, attr)
      : await ctx.driver.getText(ctx.session, selector);
  }
  // js-eval
  const raw = await ctx.driver.evaluateExpression(
    ctx.session,
    `(async () => { return (${bindFrom.expression as string}); })()`,
    evalTimeout,
  );
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  throw new ValidationError(
    `interrupt.user-assist.bind_from`,
    `js-eval must return string/number/boolean (got ${raw === null ? 'null' : typeof raw})`,
  );
}
