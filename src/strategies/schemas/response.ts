import { z } from 'zod';

export const responseExtractEntrySchema = z
  .object({
    selector: z.string().min(1, 'requires a "selector" string'),
    attr: z.string().optional(),
    multiple: z.boolean().optional(),
  })
  .loose();

export const responseExtractSchema = z.record(z.string(), responseExtractEntrySchema);

export const responseSchema = z
  .object({
    format: z.enum(['json', 'html']).optional(),
    extract: responseExtractSchema.optional(),
  })
  .loose();
