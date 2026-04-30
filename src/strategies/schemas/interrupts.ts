import { z } from 'zod';

export const INTERRUPT_AT_VALUES = ['pre_execution', 'between_steps', 'after_response'] as const;

export const interruptEntrySchema = z
  .object({
    name: z.string().min(1),
    at: z.enum(INTERRUPT_AT_VALUES),
    observe: z.record(z.string(), z.unknown()).optional(),
    handler: z.record(z.string(), z.unknown()),
    priority: z.number().int().optional(),
  })
  .strict();

export const interruptsSchema = z.array(interruptEntrySchema);
