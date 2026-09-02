import { z } from 'zod';
import { PARAM_EXAMPLE_MAX, PARAM_FIELD_MAX, PARAM_KIND_VALUES } from '../validate/constants';

const structuredExampleFits = (value: unknown): boolean =>
  JSON.stringify(value).length <= PARAM_EXAMPLE_MAX;

const paramExampleSchema = z.union([
  z.string().max(PARAM_EXAMPLE_MAX, 'is too long'),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.json()).refine(structuredExampleFits, { message: 'is too long' }),
  z.record(z.string(), z.json()).refine(structuredExampleFits, { message: 'is too long' }),
]);

export const paramDocSchema = z
  .object({
    description: z.string().max(PARAM_FIELD_MAX, 'is too long').optional(),
    kind: z
      .enum(PARAM_KIND_VALUES)
      .optional()
      .describe(
        'classifies caller-value semantics and structured container shape. Counts/limits/numbers/messages/dates/names are "text" (free-form scalar caller input). "array" and "object" are structured JSON caller inputs. "id" / "uuid" are for opaque server-issued identifiers (long hex blobs, UUIDs, base64 tokens). "slug" is for human-readable IDs. "email" / "url" are those formats. "enum" requires observed_values grounded in capture.',
      ),
    source: z.string().max(PARAM_FIELD_MAX, 'is too long').optional(),
    example: paramExampleSchema.optional(),
    optional: z
      .boolean()
      .optional()
      .describe(
        'true when this param is a filter the caller may omit (e.g. an optional `?cuisine=` query). Optional params are NOT reported as missing at execute time when absent, and the unsatisfied-placeholder check skips them. Omit (defaults to required).',
      ),
    paginates: z
      .boolean()
      .optional()
      .describe(
        'whether this param advances a page/offset window over the same collection rather than selecting different data. REQUIRED — true or false — for any param you template into the request whose example is an integer; omitting it fails the save, because "nothing paginates" and "nobody asked" are otherwise the same bytes. true routes the param into post-save verification, which executes the next consecutive integer and requires the two row sets to be disjoint.',
      ),
    observed_values: z
      .array(
        z
          .object({
            value: z.string(),
            label: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    text_kind_justification: z
      .string()
      .max(PARAM_FIELD_MAX, 'is too long')
      .optional()
      .describe(
        'one-sentence justification when kind: "text" despite UI-click observations on this param — names at least one observed click label verbatim and describes the non-click traffic shape. Substance is validated separately at save-audit time; this field just declares the slot.',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.example === undefined) return;
    if (value.kind === 'array' && !Array.isArray(value.example)) {
      ctx.addIssue({
        code: 'custom',
        path: ['example'],
        message: 'must be an array when kind is "array"',
      });
    }
    if (
      value.kind === 'object' &&
      (value.example === null || Array.isArray(value.example) || typeof value.example !== 'object')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['example'],
        message: 'must be an object when kind is "object"',
      });
    }
  });

export const notesParamsSchema = z
  .record(z.string(), z.union([z.string().max(PARAM_FIELD_MAX, 'is too long'), paramDocSchema]))
  .describe('caller-arg documentation');

export const saveWarningAckSchema = z
  .object({
    kind: z.string().min(1).describe('emitted warning kind'),
    reason: z.string().min(1).describe('one-sentence justification'),
  })
  .loose();

export const notesSchema = z
  .object({
    params: notesParamsSchema.optional(),
    description: z.string().optional().describe('one-line summary of what the capability does'),
    anchor_type: z
      .enum(['module', 'protocol', 'dom', 'unknown'])
      .optional()
      .describe('page-script durability classification'),
    save_warnings_acked: z
      .array(saveWarningAckSchema)
      .optional()
      .describe('agent acknowledgement that unblocks the save despite emitted warnings'),
  })
  .strict();
