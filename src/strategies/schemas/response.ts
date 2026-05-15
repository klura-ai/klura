import { z } from 'zod';

// Flat leaf entry — what `fields` entries inside a row-group are. No further
// nesting, no `fields` key. The runtime extractor `extractFromHtml` resolves
// these scoped to the row's matched element.
const responseExtractLeafSchema = z
  .object({
    selector: z
      .string()
      .describe(
        'CSS selector scoped to the parent row. Empty string means "the row element itself" — read attr/text directly from the matched row without descending.',
      ),
    attr: z.string().optional(),
    multiple: z.boolean().optional(),
  })
  .strict();

// Top-level extract entry — either a leaf (selector + attr?/multiple?) or a
// row-group (selector + fields + multiple). The schema is `.strict()` so
// silently-degraded shapes (extra keys the extractor would ignore) are
// rejected at save time instead of yielding useless extractions at run time.
export const responseExtractEntrySchema = z
  .object({
    selector: z.string().min(1, 'requires a "selector" string'),
    attr: z.string().optional(),
    multiple: z.boolean().optional(),
    fields: z
      .record(z.string(), responseExtractLeafSchema)
      .optional()
      .describe(
        'Per-row sub-extract for listing-shaped data. Each field is a leaf spec ({selector, attr?, multiple?}) scoped to the matched row element. Use with `multiple:true` to produce Array<Record<string,string>> (search results, product cards, table rows); use without `multiple` to produce a single Record<string,string> for the first match. Mutually exclusive with `attr` — a row-group has no attribute of its own.',
      ),
  })
  .strict()
  .refine((spec) => !(spec.attr !== undefined && spec.fields !== undefined), {
    message:
      "`attr` and `fields` are mutually exclusive — `attr` reads an attribute on the matched element; `fields` runs a sub-extract on the matched element's descendants. Pick one.",
    path: ['fields'],
  })
  .refine((spec) => !(spec.fields !== undefined && spec.multiple === undefined), {
    message:
      '`fields` requires explicit `multiple` (true for listings producing rows[]; false for a single scoped row). Implicit single-vs-list defaults bite the agent when the page returns 0 vs 1 vs many matches.',
    path: ['multiple'],
  });

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
