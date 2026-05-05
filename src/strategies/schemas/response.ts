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
    from: z
      .string()
      .min(1)
      .optional()
      .describe(
        'name of a prereq whose bound value IS the strategy result. When set, the strategy does NOT fire HTTP / WS / UI replay — the prereq runs, its return value is parsed per `format` (default "json"), `extract` (if any) is applied, and the result is returned. Use this for "the data is already in the prereq" cases (e.g. a js-eval prereq that scrapes the live DOM) to avoid faking an HTTP target. The named prereq must be one of: js-eval, page-extract, fetch-extract, capability, tag.',
      ),
  })
  .loose();
