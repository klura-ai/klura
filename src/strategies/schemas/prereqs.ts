// Zod schemas for every prereq kind. Replaces the prior PREREQ_SHAPE_HINTS
// table + per-kind validate() callbacks with one declaration per kind that
// both validates and renders. The validator (validatePrereqShape in
// `validate/prereqs.ts`) and the catalog (`schema-catalog.ts`) both walk
// these schemas — single source of truth, no parallel describer table.

import { z } from 'zod';
import { ValidationError, asPlatformSlug, asIdentifierSlug } from '../../validators';
import { asBoundedScript, asReturnShape } from '../js-eval-validators';
import { JS_EVAL_TIMEOUT_DEFAULT_MS, JS_EVAL_TIMEOUT_HARD_CAP_MS } from '../validate/constants';

// Wrap a klura-domain validator (asPlatformSlug / asIdentifierSlug / etc.)
// that throws `ValidationError` into a Zod `.superRefine()` callback. The
// throw becomes a `code: 'custom'` Zod issue carrying the validator's
// message verbatim — existing tests asserting against the message string
// continue to pass.
function refineKluraValidator(
  check: (v: string, where: string) => unknown,
  where = 'value',
): (v: string, ctx: z.RefinementCtx) => void {
  return (v, ctx) => {
    try {
      check(v, where);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: e instanceof ValidationError ? e.message : String(e),
      });
    }
  };
}

const snakeIdent = /^[a-z_][a-z0-9_]*$/;

// ---------- js-eval ----------

const jsEvalRefreshSchema = z
  .object({
    enabled: z.boolean().describe('background re-mint when true'),
    interval_seconds: z
      .number()
      .int()
      .min(
        5,
        'is below the minimum (5s). Cadences shorter than this hammer the site with no real benefit — the caller can refresh on every execute if it truly needs sub-5s freshness.',
      )
      .optional()
      .describe('cadence floor 5s; required only when enabled:true'),
    jitter_seconds: z.number().int().nonnegative().optional().describe('±jitter window'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.enabled && (typeof v.interval_seconds !== 'number' || v.interval_seconds <= 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['interval_seconds'],
        message: 'must be a positive number when refresh.enabled is true',
      });
    }
  });

const jsEvalSchema = z
  .object({
    name: z.string().min(1).describe('unique id, referenced in resume-pointers'),
    kind: z.literal('js-eval'),
    url: z.string().min(1).describe('page the expression runs inside; prereq navigates here first'),
    expression: z
      .string()
      .min(1)
      .superRefine((v, ctx) => {
        try {
          asBoundedScript(v, 'expression');
        } catch (e) {
          ctx.addIssue({
            code: 'custom',
            message: e instanceof ValidationError ? e.message : String(e),
          });
        }
      })
      .describe('async-compatible JS returning the value; wrapped in an async IIFE'),
    binds: z
      .string()
      .min(1)
      .describe('placeholder name; becomes {{<binds>}} in body/headers/endpoint'),
    return_shape: z
      .object({
        kind: z.enum(['string', 'number', 'boolean', 'object']),
        min_length: z.number().int().nonnegative().optional(),
        max_length: z.number().int().nonnegative().optional(),
        required_keys: z.array(z.string()).optional(),
      })
      .superRefine((v, ctx) => {
        try {
          asReturnShape(v, 'return_shape');
        } catch (e) {
          ctx.addIssue({
            code: 'custom',
            message: e instanceof ValidationError ? e.message : String(e),
          });
        }
      })
      .describe('executor validates the minted value against this on every refresh'),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(JS_EVAL_TIMEOUT_HARD_CAP_MS, `exceeds the hard cap of ${JS_EVAL_TIMEOUT_HARD_CAP_MS}ms`)
      .optional()
      .describe(`default ${JS_EVAL_TIMEOUT_DEFAULT_MS}, hard cap ${JS_EVAL_TIMEOUT_HARD_CAP_MS}`),
    refresh: jsEvalRefreshSchema
      .optional()
      .describe(
        'warm-pool background refresh; interval floor 5s. Mutually exclusive with args_template.',
      ),
    args_template: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'per-call payload exposed to the expression as `args` — switches the prereq to per-call mode (no cache, no refresh). Values may template against the caller scope via {{placeholder}}. Mutually exclusive with refresh.',
      ),
    frame: z
      .string()
      .min(1)
      .optional()
      .describe(
        'CSS selector for an <iframe> on the page. When set, the expression evaluates inside that frame — needed when the global the expression names lives in a cross-origin iframe.',
      ),
  })
  .strict()
  .superRefine((val, ctx) => {
    // args_template + refresh.enabled is incoherent (per-call args vs cached
    // background mint). Reject with the same diagnostic the prior validator
    // produced.
    if (val.args_template && val.refresh?.enabled === true) {
      ctx.addIssue({
        code: 'custom',
        message:
          "declares both args_template and refresh.enabled — these are mutually exclusive. args_template makes the prereq per-call (the expression reads the caller's payload), so the result is body-dependent and cannot be cached. refresh schedules a background re-mint on a fixed interval with no per-call args, so it only makes sense for values that don't depend on per-call inputs. Pick one: drop `refresh` for a per-call signer, or drop `args_template` for a cacheable mint.",
      });
    }
  });

// ---------- page-extract ----------

const pageExtractVarSchema = z
  .object({
    selector: z.string().min(1).describe('CSS selector resolving the element'),
    attr: z.string().optional().describe('attribute to read; omit for text content'),
  })
  .strict();

const pageExtractSchema = z
  .object({
    name: z.string().min(1).describe('unique id'),
    kind: z.literal('page-extract'),
    url: z.string().min(1).describe('page to load before extracting'),
    vars: z
      .record(z.string(), pageExtractVarSchema)
      .refine((v) => Object.keys(v).length > 0, {
        message:
          'must be a non-empty object: {varName: {selector, attr?}} — for JSON-in-<script> use js-eval instead',
      })
      .describe('{ varName: { selector, attr? } } — CSS only; for JSON use js-eval'),
  })
  .strict();

// ---------- browser ----------

const browserSchema = z
  .object({
    name: z.string().min(1).describe('unique id'),
    kind: z.literal('browser'),
    steps: z
      .array(z.unknown())
      .min(
        1,
        'must be a non-empty array of {action, ...} steps. If you only need to load a page and read some values, use kind:"page-extract" instead.',
      )
      .describe('non-empty step list — use page-extract for pure extraction'),
  })
  .strict();

// ---------- fetch-extract ----------

const fetchExtractSchema = z
  .object({
    name: z.string().min(1).describe('unique id'),
    kind: z.literal('fetch-extract'),
    url: z.string().min(1).describe('API endpoint to call'),
    vars: z
      .record(
        z.string(),
        z
          .string()
          .min(
            1,
            'must be a non-empty dot-path string (e.g. "node_id", "data.items[0].id"). Did you confuse fetch-extract with page-extract? page-extract uses {selector, attr?} objects; fetch-extract uses dot-path strings.',
          ),
      )
      .refine((v) => Object.keys(v).length > 0, {
        message: 'must be a non-empty object: {varName: "dot.path.into.json.response"}',
      })
      .describe('{ varName: "dot.path.into.json.response" } — dot-paths, not selectors'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().describe('default "GET"'),
    headers_map: z.record(z.string(), z.string()).optional().describe('request headers'),
    fetch_body: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSON body for POST/PUT/PATCH'),
  })
  .strict();

// ---------- capability ----------

const capabilitySchema = z
  .object({
    name: z.string().min(1).describe('unique id for this prereq'),
    kind: z.literal('capability'),
    capability: z
      .string()
      .min(1)
      .superRefine(refineKluraValidator(asIdentifierSlug))
      .describe('target capability slug, e.g. "lookup_thread_by_name"'),
    vars: z
      .record(
        z.string().regex(snakeIdent, {
          message:
            'bind name must be a snake_case identifier (lowercase, underscores, no leading digit)',
        }),
        z.string(),
      )
      .optional()
      .describe(
        '{ <name>: "dot.path" } — bindings from the sub-execute response. Omit for side-effect-only prereqs (e.g. login).',
      ),
    platform: z
      .string()
      .min(1)
      .superRefine(refineKluraValidator(asPlatformSlug))
      .optional()
      .describe("defaults to caller's platform"),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('{ arg_name: value_or_template } — template via {{placeholder}}'),
    optional: z
      .boolean()
      .optional()
      .describe('when true, a failed sub-execute binds null instead of failing the caller'),
  })
  .strict();

// ---------- tag ----------

const tagSchema = z
  .object({
    name: z.string().min(1).describe('unique id for this prereq'),
    kind: z.literal('tag'),
    tag: z
      .string()
      .min(1)
      .superRefine(refineKluraValidator(asIdentifierSlug))
      .describe(
        'tag declared by a sibling capability via top-level `provides: ["<tag>"]`. Runtime resolves to a slug by scanning saved capabilities.',
      ),
    vars: z
      .record(
        z.string().regex(snakeIdent, {
          message: 'bind name must be a snake_case identifier',
        }),
        z.string(),
      )
      .optional()
      .describe('{ <name>: "dot.path" } — bindings from the resolved capability'),
    platform: z
      .string()
      .min(1)
      .superRefine(refineKluraValidator(asPlatformSlug))
      .optional()
      .describe("defaults to caller's platform"),
    args: z.record(z.string(), z.unknown()).optional().describe('forwarded to resolved capability'),
    optional: z.boolean().optional().describe('when true, failure binds null'),
  })
  .strict();

// ---------- cached (no validation; runtime checks at execute time) ----------

const cachedSchema = z
  .looseObject({
    name: z.string().min(1).optional(),
    kind: z.literal('cached'),
  })
  .describe('runtime-cached value; checked at execute time');

// ---------- registry ----------

export const prereqSchemas = {
  'js-eval': jsEvalSchema,
  'page-extract': pageExtractSchema,
  browser: browserSchema,
  'fetch-extract': fetchExtractSchema,
  capability: capabilitySchema,
  tag: tagSchema,
  cached: cachedSchema,
} as const;

export type PrereqKind = keyof typeof prereqSchemas;

export const PREREQ_KINDS: readonly PrereqKind[] = Object.keys(prereqSchemas) as PrereqKind[];

export function getPrereqSchema(kind: string): z.ZodType | null {
  return (prereqSchemas as Record<string, z.ZodType>)[kind] ?? null;
}

const PREREQ_REFERENCE_SLUGS: Record<string, string> = {
  'js-eval': 'js-eval-prereq',
  'page-extract': 'page-extract-prereq',
  browser: 'browser-prereq',
  'fetch-extract': 'fetch-extract-prereq',
  capability: 'capability-prereq',
  tag: 'tag-prereq',
};

export function prereqReferenceSlug(kind: string): string {
  return PREREQ_REFERENCE_SLUGS[kind] ?? 'capability-prereq';
}
