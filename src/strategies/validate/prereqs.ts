// Per-kind prereq shape validation. The canonical schemas live in
// `runtime/src/strategies/schemas/prereqs.ts` (Zod) — this file is the
// dispatcher: routes by `kind`, runs the Zod schema, and surfaces
// validation results via the existing `validatePrereqShape` /
// `describePrereqShape` / `prereqReferenceSlug` API the rest of the
// codebase consumes.

import {
  PREREQ_KINDS,
  getPrereqSchema,
  prereqReferenceSlug as prereqReferenceSlugFromSchema,
} from '../schemas/prereqs';
import { parseOrThrow, renderZodSkeleton } from '../schemas/zod-helpers';

/** Render the JSON skeleton for a prereq kind. Reads from the canonical
 *  Zod schema in `schemas/prereqs.ts` — single source for both validate
 *  and describe. */
export function describePrereqShape(kind: string): string | null {
  const schema = getPrereqSchema(kind);
  if (!schema) return null;
  return renderZodSkeleton(schema);
}

export function prereqReferenceSlug(kind: string): string {
  return prereqReferenceSlugFromSchema(kind);
}

// Per-kind shape validation for prerequisites. Dispatches by `kind` to the
// canonical Zod schema in `schemas/prereqs.ts`. Adding a field anywhere is
// a one-line change in that schema; the validator + the agent-facing
// rejection skeleton update together — no drift.
export function validatePrereqShape(
  tier?: string,
  i?: number,
  item?: Record<string, unknown>,
): void {
  // Defensive shape: when callers hand in a bare `{kind}` without the
  // surrounding tier context (programmatic probes / inline diagnostics),
  // still return a useful rejection instead of crashing on undefined.
  const tierLoose = tier as unknown;
  if (item === undefined && typeof tierLoose === 'object' && tierLoose !== null) {
    item = tierLoose as Record<string, unknown>;
    tier = 'strategy';
    i = 0;
  }
  if (!item || typeof item !== 'object') {
    throw new Error(
      `invalid_strategy: prerequisite must be an object {kind, ...}\n\n` +
        `Expected shape:\n  { kind: ${PREREQ_KINDS.map((k) => JSON.stringify(k)).join(' | ')}, ... }\n\n` +
        `See klura://reference#capability-prereq.`,
    );
  }
  const kind = item.kind;
  const where = `${tier}.prerequisites[${i}]`;

  // kind === 'cached' has no structural validation — value is optional,
  // runtime checks the cache at execute time. Skip.
  if (kind === 'cached') return;

  if (typeof kind !== 'string') {
    throw new Error(
      `invalid_strategy: ${where}.kind is required (must be one of: ` +
        `${PREREQ_KINDS.map((k) => JSON.stringify(k)).join(', ')}, "cached")\n\n` +
        `Expected shape:\n  { kind: ${PREREQ_KINDS.map((k) => JSON.stringify(k)).join(' | ')}, ... }\n\n` +
        `See klura://reference#capability-prereq.`,
    );
  }

  const schema = getPrereqSchema(kind);
  if (!schema) {
    throw new Error(
      `invalid_strategy: ${where}.kind = ${JSON.stringify(kind)} is not a recognized prereq kind. ` +
        `Allowed: ${PREREQ_KINDS.map((k) => JSON.stringify(k)).join(', ')}, "cached".\n\n` +
        `Expected shape:\n  { kind: ${PREREQ_KINDS.map((k) => JSON.stringify(k)).join(' | ')}, ... }\n\n` +
        `See klura://reference#capability-prereq.`,
    );
  }

  parseOrThrow(schema, item, {
    where,
    kindLabel: `kind:"${kind}"`,
    referenceSlug: prereqReferenceSlugFromSchema(kind),
  });
}
