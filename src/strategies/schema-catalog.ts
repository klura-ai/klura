// Save-strategy schema catalog — single dynamic source-of-truth surface
// agents read for save-time shape, derived from the canonical Zod schemas
// in `runtime/src/strategies/schemas/`. Eliminates the SKILL.md / REFERENCE.md
// duplicate-source bug where prose drifted from the validator and required
// fields silently went unmentioned.
//
// Surfaces consumed by:
//   - `submit_triage_plan` ok-response — tier-scoped slice as lift-entry priming.
//   - `save_strategy` `invalid_shape` rejection — inlined in the rejection message.
//   - `klura://reference#save-strategy-schema` — full catalog on demand.

import { z } from 'zod';
import { prereqSchemas, PREREQ_KINDS, prereqReferenceSlug } from './schemas/prereqs';
import { strategySchemas } from './schemas/strategy';
import { renderZodSkeleton } from './schemas/zod-helpers';
import {
  describeNotesAllowlist,
  RECORDED_PATH_ACTIONS,
  PARAM_KIND_VALUES,
  ANCHOR_TYPES,
  WS_UNSAFE_HEADERS,
} from './validate/constants';

export type StrategyTier = 'fetch' | 'page-script' | 'recorded-path';

interface RenderOpts {
  /** Restrict prereq listing to those typically used with the given tier.
   *  Recorded-path doesn't carry prereqs; fetch / page-script share the
   *  full set. */
  tier?: StrategyTier;
}

/**
 * Render the full save-strategy schema as one Markdown block. Fields come
 * from the Zod schemas (reflection over `prereqSchemas`); enum lists come
 * from the validator constants. Adding a field to any prereq schema in
 * `schemas/prereqs.ts` automatically appears here.
 */
export function renderSaveStrategySchemaMarkdown(opts: RenderOpts = {}): string {
  const lines: string[] = [];
  lines.push('## save_strategy schema');
  lines.push('');
  lines.push(
    "_The runtime renders this dynamically from the Zod validators — every required field is enumerated. If a field doesn't appear here, it isn't enforced._",
  );
  lines.push('');

  if (opts.tier) {
    lines.push(`### ${opts.tier} strategy`);
    lines.push('');
    lines.push('```');
    lines.push(renderZodSkeleton(strategySchemas[opts.tier]));
    lines.push('```');
    lines.push('');
    if (opts.tier === 'fetch' || opts.tier === 'page-script') {
      lines.push(
        'HTTP strategies require `baseUrl` + `endpoint`; WebSocket strategies require `origin` + `wsUrl` (`origin` may be omitted only with `wsOpen: "none"`).',
      );
      lines.push('');
    }
  } else {
    lines.push('### Strategy tiers');
    lines.push('');
    for (const tier of ['fetch', 'page-script', 'recorded-path'] as const) {
      lines.push(`**\`${tier}\`**`);
      lines.push('');
      lines.push('```');
      lines.push(renderZodSkeleton(strategySchemas[tier]));
      lines.push('```');
      lines.push('');
    }
  }

  // Prereq kinds — render only when the tier carries prereqs (recorded-path
  // doesn't). For fetch / page-script the full kind list is relevant.
  if (opts.tier !== 'recorded-path') {
    lines.push('### Prereq kinds (`prerequisites: [{kind, ...}, ...]`)');
    lines.push('');
    for (const kind of PREREQ_KINDS) {
      const schema = prereqSchemas[kind];
      const slug = prereqReferenceSlug(kind);
      lines.push(`**\`${kind}\`** — see klura://reference#${slug}`);
      lines.push('');
      lines.push('```');
      lines.push(renderZodSkeleton(schema));
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('### `notes` (agent-owned)');
  lines.push('');
  lines.push('```');
  lines.push(describeNotesAllowlist());
  lines.push('```');
  lines.push('');

  if (opts.tier === 'recorded-path' || !opts.tier) {
    lines.push('### Recorded-path step');
    lines.push('');
    const actionList = RECORDED_PATH_ACTIONS.map((a) => '`' + a + '`').join(', ');
    lines.push(`Actions: ${actionList}`);
    lines.push('');
  }

  lines.push('### Enums');
  lines.push('');
  const kindList = PARAM_KIND_VALUES.map((v) => '`' + v + '`').join(' | ');
  const anchorList = ANCHOR_TYPES.map((v) => '`' + v + '`').join(' | ');
  const unsafeList = [...WS_UNSAFE_HEADERS].map((h) => '`' + h + '`').join(', ');
  lines.push(`- **notes.params.kind**: ${kindList}`);
  lines.push(`- **notes.anchor_type** (page-script): ${anchorList}`);
  lines.push(`- **WebSocket unsafe headers** (auto-rejected on ws strategies): ${unsafeList}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Get the catalog as a structured object. Surfaces:
 *   - `prereqs[kind]`: { schema (Zod), shape_skeleton, reference_slug }
 *   - `notes_allowlist` (rendered string)
 *   - `recorded_path_actions`, `param_kinds`, `anchor_types`, `ws_unsafe_headers` (string arrays)
 *
 * Used by tests (drift-guard) and any caller wanting structured access
 * without parsing the Markdown rendering.
 */
export function getSaveStrategySchema(): {
  prereqs: Record<string, { shape_skeleton: string; reference_slug: string; schema: z.ZodType }>;
  tiers: Record<
    StrategyTier,
    { shape_skeleton: string; reference_slug: string; schema: z.ZodType }
  >;
  notes_allowlist: string;
  recorded_path_actions: readonly string[];
  param_kinds: readonly string[];
  anchor_types: readonly string[];
  ws_unsafe_headers: readonly string[];
} {
  const prereqs: Record<
    string,
    { shape_skeleton: string; reference_slug: string; schema: z.ZodType }
  > = {};
  for (const kind of PREREQ_KINDS) {
    const schema: z.ZodType = prereqSchemas[kind];
    prereqs[kind] = {
      shape_skeleton: renderZodSkeleton(schema),
      reference_slug: prereqReferenceSlug(kind),
      schema,
    };
  }
  const tiers: Record<
    StrategyTier,
    { shape_skeleton: string; reference_slug: string; schema: z.ZodType }
  > = {
    fetch: {
      shape_skeleton: renderZodSkeleton(strategySchemas.fetch),
      reference_slug: 'fetch-schema',
      schema: strategySchemas.fetch,
    },
    'page-script': {
      shape_skeleton: renderZodSkeleton(strategySchemas['page-script']),
      reference_slug: 'page-script-schema',
      schema: strategySchemas['page-script'],
    },
    'recorded-path': {
      shape_skeleton: renderZodSkeleton(strategySchemas['recorded-path']),
      reference_slug: 'recorded-path-schema',
      schema: strategySchemas['recorded-path'],
    },
  };
  return {
    prereqs,
    tiers,
    notes_allowlist: describeNotesAllowlist(),
    recorded_path_actions: RECORDED_PATH_ACTIONS,
    param_kinds: PARAM_KIND_VALUES,
    anchor_types: ANCHOR_TYPES,
    ws_unsafe_headers: [...WS_UNSAFE_HEADERS] as readonly string[],
  };
}
