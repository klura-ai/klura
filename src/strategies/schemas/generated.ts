import { z } from 'zod';
import { GENERATOR_CODE_MAX, GENERATOR_INSTRUCTION_MAX } from '../validate/constants';

export const generatedEntrySchema = z
  .object({
    code: z
      .string()
      .min(1, 'must be a non-empty string of JavaScript')
      .max(
        GENERATOR_CODE_MAX,
        `is too long; generator functions should be small, self-contained snippets`,
      )
      .optional(),
    instruction: z
      .string()
      .min(1, 'must be a non-empty string')
      .max(GENERATOR_INSTRUCTION_MAX, `is too long`)
      .optional(),
    examples: z.array(z.string()).optional(),
  })
  .loose()
  .superRefine((entry, ctx) => {
    const hasCode = 'code' in entry;
    const hasInstruction = 'instruction' in entry;
    if (!hasCode && !hasInstruction) {
      ctx.addIssue({
        code: 'custom',
        message: 'must contain either a "code" (string) or "instruction" (string) key',
      });
    }
    if (hasCode && hasInstruction) {
      ctx.addIssue({
        code: 'custom',
        message: 'must contain exactly one of "code" or "instruction", not both',
      });
    }
  });

export const generatedSchema = z.record(z.string(), generatedEntrySchema);
