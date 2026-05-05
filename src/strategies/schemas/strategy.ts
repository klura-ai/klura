import { z } from 'zod';
import { responseSchema } from './response';

const nonEmptyString = z.string().min(1, 'must be a non-empty string');
const objectValue = z.record(z.string(), z.unknown());
const stringRecord = z.record(z.string(), z.string());
const optionalSlot = <T extends z.ZodType>(schema: T): z.ZodOptional<z.ZodNullable<T>> =>
  schema.nullable().optional();
const prereqList = z
  .array(z.record(z.string(), z.unknown()))
  .optional()
  .describe('array of prereq objects; see prereq catalog below for per-kind fields');

const commonStrategyFields = {
  schema_version: optionalSlot(z.number().int().positive()),
  method: optionalSlot(nonEmptyString).describe('HTTP method; omitted defaults at execute time'),
  contentType: optionalSlot(z.enum(['json', 'form'])),
  headers: optionalSlot(stringRecord).describe('{ header: value }'),
  body: optionalSlot(objectValue).describe('JSON/template request body'),
  params: optionalSlot(objectValue).describe('template defaults / static params'),
  prerequisites: prereqList,
  notes: optionalSlot(objectValue).describe('agent-owned metadata; see notes catalog below'),
  generated: optionalSlot(objectValue).describe('{ name: { code } | { instruction } }'),
  runtime_meta: optionalSlot(objectValue).describe('runtime-owned metadata'),
  cache: optionalSlot(objectValue).describe('{ ttl: "5m" } return-value cache hint'),
  provides: optionalSlot(z.array(nonEmptyString)).describe('tags this capability fulfills'),
  protocol: z.unknown().optional().describe('default "http"; set "websocket" for ws'),
  wsUrl: optionalSlot(nonEmptyString).describe('captured WebSocket URL'),
  wsHeaders: optionalSlot(stringRecord).describe('WebSocket headers safe for the client to set'),
  frame: optionalSlot(nonEmptyString).describe('WebSocket frame template'),
  frameEncoding: z.unknown().optional(),
  ackMatch: optionalSlot(nonEmptyString).describe('substring/marker expected in an ack frame'),
  ackTimeoutMs: z.unknown().optional(),
  wsOpen: z
    .unknown()
    .optional()
    .describe('"none", "navigate", or steps to open the socket page before dialing'),
  wsOpenTimeoutMs: z.unknown().optional(),
};

export const fetchSchema = z
  .looseObject({
    strategy: z.literal('fetch'),
    baseUrl: optionalSlot(nonEmptyString).describe('HTTP(S) API origin'),
    endpoint: optionalSlot(nonEmptyString).describe('HTTP endpoint/path'),
    origin: optionalSlot(nonEmptyString).describe('page origin for websocket strategies'),
    response: optionalSlot(responseSchema).describe(
      'response handling — extract from HTTP body, or skip the fetch entirely with `from: "<prereq-name>"`',
    ),
    ...commonStrategyFields,
  })
  .superRefine((value, ctx) => {
    if (value.protocol === 'websocket') {
      if ('baseUrl' in value) {
        ctx.addIssue({
          code: 'custom',
          path: ['baseUrl'],
          message: 'is not a valid field for websocket strategies — the canonical name is "origin"',
        });
      }
      if (typeof value.wsUrl !== 'string' || value.wsUrl.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['wsUrl'], message: 'is required' });
      }
      if (
        value.wsOpen !== 'none' &&
        (typeof value.origin !== 'string' || value.origin.length === 0)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['origin'],
          message: 'requires "origin" unless wsOpen is "none"',
        });
      }
    } else {
      // `response.from` short-circuits the fire entirely — the strategy
      // returns the named prereq's bound value as its result, no HTTP. In
      // that mode, baseUrl/endpoint are optional; they don't go on the
      // wire. validateResponseShape (in `validate/response.ts`) verifies
      // the named prereq exists and is a value-producing kind.
      const responseFromSet =
        typeof (value.response as { from?: unknown } | null | undefined)?.from === 'string' &&
        ((value.response as { from?: string }).from?.length ?? 0) > 0;
      if (!responseFromSet) {
        if (typeof value.baseUrl !== 'string' || value.baseUrl.length === 0) {
          ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'is required' });
        }
        if (typeof value.endpoint !== 'string' || value.endpoint.length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['endpoint'],
            message:
              'is required (or set `response.from: "<prereq-name>"` to skip HTTP and return that prereq\'s bound value as the strategy result — useful when a js-eval / page-extract prereq already produces the data).',
          });
        }
      }
      if ('origin' in value) {
        ctx.addIssue({
          code: 'custom',
          path: ['origin'],
          message: 'is not a field on HTTP fetch strategies — the canonical name is "baseUrl"',
        });
      }
      if ('frameFromPage' in value && value.frameFromPage !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['frameFromPage'],
          message:
            'is only valid on WebSocket strategies (set protocol:"websocket" + wsUrl). For HTTP fetch with caller-supplied data, template the body with {{placeholder}} and bind from a js-eval / page-extract / fetch-extract / capability prereq. If the data IS the prereq\'s return value (no real HTTP needed), set `response.from: "<prereq-name>"` instead — the strategy then returns the prereq\'s value directly without firing. The runtime silently ignores frameFromPage on non-ws strategies, which would produce a working save but a broken warm execute.',
        });
      }
    }
  });

export const pageScriptSchema = z
  .looseObject({
    strategy: z.literal('page-script'),
    baseUrl: optionalSlot(nonEmptyString).describe('HTTP(S) API origin'),
    endpoint: optionalSlot(nonEmptyString).describe('HTTP endpoint/path'),
    origin: optionalSlot(nonEmptyString).describe('page origin when different from baseUrl'),
    response: optionalSlot(responseSchema).describe(
      'response handling — extract from HTTP body, or skip the fetch entirely with `from: "<prereq-name>"` so the strategy returns a prereq\'s bound value (no HTTP fires). Use the latter for DOM-extraction page-scripts.',
    ),
    ...commonStrategyFields,
  })
  .superRefine((value, ctx) => {
    if (value.protocol === 'websocket') {
      if ('baseUrl' in value) {
        ctx.addIssue({
          code: 'custom',
          path: ['baseUrl'],
          message: 'is not a valid field for websocket strategies — the canonical name is "origin"',
        });
      }
      if (typeof value.wsUrl !== 'string' || value.wsUrl.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['wsUrl'], message: 'is required' });
      }
      if (
        value.wsOpen !== 'none' &&
        (typeof value.origin !== 'string' || value.origin.length === 0)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['origin'],
          message: 'requires "origin" unless wsOpen is "none"',
        });
      }
    } else {
      // `response.from` short-circuits the fire — see fetchSchema for the
      // full rationale. Same behavior on page-script.
      const responseFromSet =
        typeof (value.response as { from?: unknown } | null | undefined)?.from === 'string' &&
        ((value.response as { from?: string }).from?.length ?? 0) > 0;
      if (!responseFromSet) {
        if (typeof value.baseUrl !== 'string' || value.baseUrl.length === 0) {
          ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'is required' });
        }
        if (typeof value.endpoint !== 'string' || value.endpoint.length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['endpoint'],
            message:
              'is required (or set `response.from: "<prereq-name>"` to skip HTTP and return that prereq\'s bound value as the strategy result — useful for DOM-extraction page-scripts where a js-eval prereq scrapes the live page and the strategy has no real fetch to fire).',
          });
        }
      }
      if ('frameFromPage' in value && value.frameFromPage !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['frameFromPage'],
          message:
            'is only valid on WebSocket strategies (set protocol:"websocket" + wsUrl). For DOM extraction with no real HTTP, model it as a js-eval prereq with `binds: "<name>"` and either (a) reference {{<name>}} in the body / endpoint to template into a real request, or (b) set `response.from: "<name>"` so the strategy returns the prereq\'s bound value directly without firing HTTP. The runtime silently ignores frameFromPage on non-ws page-scripts, producing a working save but a broken warm execute.',
        });
      }
    }
  });

export const recordedPathSchema = z.looseObject({
  strategy: z.literal('recorded-path'),
  steps: z.array(z.record(z.string(), z.unknown())).describe('recorded browser action steps'),
  prerequisites: prereqList,
  notes: optionalSlot(objectValue).describe('agent-owned metadata; see notes catalog below'),
  generated: optionalSlot(objectValue).describe('{ name: { code } | { instruction } }'),
  response: optionalSlot(responseSchema).describe(
    'post-replay extraction from the live page DOM (format:"html" + extract). response.from is rejected here — use page-script with response.from for prereq-sourced returns.',
  ),
  runtime_meta: optionalSlot(objectValue).describe('runtime-owned metadata'),
  cache: optionalSlot(objectValue).describe('{ ttl: "5m" } return-value cache hint'),
});

export const strategySchemas = {
  fetch: fetchSchema,
  'page-script': pageScriptSchema,
  'recorded-path': recordedPathSchema,
} as const;

export const strategySchema = z.union([fetchSchema, pageScriptSchema, recordedPathSchema]);

export type StrategyTier = keyof typeof strategySchemas;
