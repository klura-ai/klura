import { z } from 'zod';
import { PARAM_EXAMPLE_MAX, PARAM_FIELD_MAX, PARAM_KIND_VALUES } from '../validate/constants';

export const paramDocSchema = z
  .object({
    description: z.string().max(PARAM_FIELD_MAX, 'is too long').optional(),
    kind: z.enum(PARAM_KIND_VALUES).optional(),
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
