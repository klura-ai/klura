import { z } from 'zod';
import { recordedPathStepSchema } from './recorded-path';

export const frameFromPageSchema = z
  .object({
    expression: z.string(),
    returns: z.enum(['hex', 'base64']),
    timeout_ms: z.number().int().positive().max(30_000).optional(),
  })
  .loose();

export const wsOpenSchema = z.union([
  z.literal('navigate'),
  z.literal('none'),
  z
    .object({
      steps: z.array(recordedPathStepSchema).min(1),
    })
    .loose(),
]);

export const websocketFieldsSchema = z
  .object({
    protocol: z.literal('websocket'),
    wsUrl: z.string().min(1),
    wsHeaders: z.record(z.string(), z.string()).optional(),
    frame: z.string().min(1).optional(),
    frameEncoding: z.enum(['text', 'binary']).optional(),
    ackMatch: z.string().min(1).optional(),
    ackTimeoutMs: z.number().nonnegative().optional(),
    wsOpen: wsOpenSchema.optional(),
    wsOpenTimeoutMs: z.number().nonnegative().optional(),
    frameFromPage: frameFromPageSchema.optional(),
  })
  .loose();
