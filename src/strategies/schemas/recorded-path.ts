import { z } from 'zod';

export const recordedPathA11yLocatorSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
  })
  .loose();

export const recordedPathLocatorAlternativeSchema = z
  .object({
    a11y: recordedPathA11yLocatorSchema.optional(),
    css: z.string().optional(),
  })
  .loose();

export const recordedPathLocatorsSchema = z
  .object({
    a11y: recordedPathA11yLocatorSchema.optional(),
    css: z.string().optional(),
    alternatives: z.array(recordedPathLocatorAlternativeSchema).optional(),
  })
  .loose();

export const recordedPathStepSchema = z
  .object({
    id: z.string().optional(),
    action: z.string(),
    url: z.string().optional(),
    locators: z.unknown().optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    waitSelector: z.string().optional(),
    optional: z.unknown().optional(),
    page: z.unknown().optional(),
  })
  .loose();
