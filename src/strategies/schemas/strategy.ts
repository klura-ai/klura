import { z } from 'zod';

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
    response: optionalSlot(objectValue).describe('fetch response handling'),
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
      if (typeof value.baseUrl !== 'string' || value.baseUrl.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'is required' });
      }
      if (typeof value.endpoint !== 'string' || value.endpoint.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'is required' });
      }
      if ('origin' in value) {
        ctx.addIssue({
          code: 'custom',
          path: ['origin'],
          message: 'is not a field on HTTP fetch strategies — the canonical name is "baseUrl"',
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
      if (typeof value.baseUrl !== 'string' || value.baseUrl.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'is required' });
      }
      if (typeof value.endpoint !== 'string' || value.endpoint.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'is required' });
      }
    }
  });

export const recordedPathSchema = z.looseObject({
  strategy: z.literal('recorded-path'),
  steps: z.array(z.record(z.string(), z.unknown())).describe('recorded browser action steps'),
  notes: optionalSlot(objectValue).describe('agent-owned metadata; see notes catalog below'),
  generated: optionalSlot(objectValue).describe('{ name: { code } | { instruction } }'),
  response: optionalSlot(objectValue).describe('recorded-path response handling'),
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
