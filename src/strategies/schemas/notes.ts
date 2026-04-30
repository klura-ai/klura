import { z } from 'zod';
import { PARAM_EXAMPLE_MAX, PARAM_FIELD_MAX, PARAM_KIND_VALUES } from '../validate/constants';

export const paramDocSchema = z
  .object({
    description: z.string().max(PARAM_FIELD_MAX, 'is too long').optional(),
    kind: z
      .string()
      .optional()
      .superRefine((value, ctx) => {
        if (value === undefined) return;
        if (!PARAM_KIND_VALUES.includes(value as (typeof PARAM_KIND_VALUES)[number])) {
          const allowedKinds = PARAM_KIND_VALUES.map((k) => `"${k}"`).join(', ');
          ctx.addIssue({
            code: 'custom',
            message: `kind = ${JSON.stringify(value)} is not allowed; must be one of: ${allowedKinds}`,
          });
        }
      }),
    source: z.string().max(PARAM_FIELD_MAX, 'is too long').optional(),
    example: z.string().max(PARAM_EXAMPLE_MAX, 'is too long').optional(),
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
  })
  .strict();

export const notesParamsSchema = z.record(
  z.string(),
  z.union([z.string().max(PARAM_FIELD_MAX, 'is too long'), paramDocSchema]),
);

export const saveWarningAckSchema = z
  .object({
    kind: z.string().min(1),
    reason: z.string().min(1),
  })
  .loose();

export const notesSchema = z
  .object({
    params: notesParamsSchema.optional(),
    description: z.string().optional(),
    anchor_type: z.enum(['module', 'protocol', 'dom', 'unknown']).optional(),
    save_warnings_acked: z.array(saveWarningAckSchema).optional(),
  })
  .strict();
