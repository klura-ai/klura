// The generator runs inside a vm.Context. A wrong shape crashes the executor at
// generator-resolution time with a confusing error; worse, an agent can paste a
// non-string `code` field and the vm call happily stringifies it. Reject at
// save time instead.

import { isPlainObject } from './helpers';
import { generatedSchema } from '../schemas/generated';
import { zodErrorToIssues } from '../schemas/zod-helpers';

export function validateGeneratedShape(data: Record<string, unknown>): void {
  const generated = data.generated;
  if (generated === undefined || generated === null) return;
  if (!isPlainObject(generated)) return; // already caught by checkOptionalField

  const parsed = generatedSchema.safeParse(generated);
  if (!parsed.success) {
    const issues = zodErrorToIssues(parsed.error, 'generated');
    const bullets = issues.map((issue) => `  - ${issue}`).join('\n');
    const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    throw new Error(
      `invalid_strategy: generated has ${issueLabel} — fix all before retrying:\n${bullets}`,
    );
  }
}
