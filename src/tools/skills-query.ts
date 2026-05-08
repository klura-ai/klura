import * as skills from '../strategies/skills';
import type { Strategy, SkillInfo } from '../strategies/skills';
import { loadLogbook as loadLogbookForPlatform } from '../working-dir/logbook';
import { recomputeFieldStability } from '../working-dir/derived/field-stability';
import { recomputeBundleHistory } from '../working-dir/derived/bundle-history';
import { recomputeSignerHistory } from '../working-dir/derived/signer-history';
import { recomputeKnownModules } from '../working-dir/derived/known-modules';
import {
  readArtifactFromDisk,
  LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET,
} from '../strategies/discovery-artifact';
import { computeLiftRate, formatLiftRateReport } from '../telemetry/report';
import type { LiftRateReport } from '../telemetry/report';
import { asEnum } from '../validators';
import { inlineArtifactForResponse } from './_internals';

/** Loud nudge attached to list_platform_skills responses when at least
 *  one platform has saved capabilities. Read inline from the response,
 *  not loaded into SKILL.md (token-precious every-conversation surface). */
const TEST_BEFORE_BUILD_HINT =
  `========================================================================\n` +
  `STOP. READ THE CAPABILITIES ABOVE BEFORE YOUR NEXT TOOL CALL.\n` +
  `========================================================================\n\n` +
  `EVERY capability above is ALREADY SAVED on this platform. Use them by\n` +
  `their EXACT \`name\`. Klura slugs are the platform's shared vocabulary\n` +
  `— agents pick from this list, they don't translate the user's prose\n` +
  `into a new slug. Two slugs that mean the same thing fragment the\n` +
  `vocabulary and bake the same data twice.\n\n` +
  `BEFORE YOU CONSIDER start_session for a new capability:\n\n` +
  `  1. SCAN this list. For each user request, ask: which capability's\n` +
  `     \`signature\` + \`params\` covers what the user wants?\n\n` +
  `  2. CHECK the params. Each enum param has \`observed_values\` listing\n` +
  `     the EXACT values the API accepts (with optional \`label\`). The\n` +
  `     value the user types in prose almost never matches an enum value\n` +
  `     directly — match against \`label\` if present, then pass the\n` +
  `     matching \`value\`. If no labels exist, pick the \`value\` that\n` +
  `     best fits the user's intent.\n\n` +
  `  3. CALL it. \`execute({platform, capability, args})\` — ONE round\n` +
  `     trip. If the result is what the user needs → done. If it's\n` +
  `     wrong shape / wrong scope → THEN consider start_session.\n\n` +
  `WHY THIS MATTERS:\n` +
  `  • Calling an existing capability is 1 round trip.\n` +
  `  • Driving a fresh discovery is 10–40 rounds + save-time audit\n` +
  `    cycle + a duplicate strategy file on disk.\n` +
  `  • Inventing a new slug for an existing operation TRIPS THE\n` +
  `    endpoint_collides_with_saved_capability AUDIT AT SAVE TIME.\n` +
  `    The audit is ACKABLE for genuinely-different ops on multiplexed\n` +
  `    gateways (GraphQL, JSON-RPC) — but a same-op-under-new-slug save\n` +
  `    still has to articulate the (nonexistent) structural diff and\n` +
  `    leaves a permanent reason on disk. Use the existing slug.\n\n` +
  `If you find yourself typing a capability name that doesn't appear\n` +
  `in the list above — STOP and look harder. The right answer is almost\n` +
  `always one of the names you already see.`;

export interface ListPlatformSkillsResult {
  platforms: SkillInfo[];
  _hint?: string;
}

export function listPlatformSkills(): ListPlatformSkillsResult {
  const list = skills.listPlatformSkills();
  // Inline discovery_artifact onto every capability that has one on disk. The
  // artifact summarizes what prior sessions learned so the next-run agent can
  // resume without re-discovering from zero. See
  // klura://reference#discovery-artifact for the full mechanics.
  for (const skill of list) {
    for (const cap of skill.capabilities) {
      const artifact = readArtifactFromDisk(skill.platform, cap.name);
      if (artifact) {
        const inlined = inlineArtifactForResponse(
          skill.platform,
          cap.name,
          artifact,
          LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET,
        );
        (cap as unknown as Record<string, unknown>).discovery_artifact = inlined;
      }
    }
  }
  const hasAnyCapability = list.some((s) => s.capabilities.length > 0);
  const result: ListPlatformSkillsResult = { platforms: list };
  if (hasAnyCapability) result._hint = TEST_BEFORE_BUILD_HINT;
  return result;
}

/**
 * Render a terse markdown summary of saved skills suitable for front-loading
 * into the MCP server's `instructions` block at startup. One line per
 * platform, slug-only — full schemas + discovery_artifacts come from
 * `list_platform_skills`. Returns an empty string when no platform has saved
 * capabilities (so the caller can skip appending an empty section).
 *
 * Loaded once at MCP server-init via `getSkillMd()`-adjacent assembly. The
 * deliberate principle break is documented in
 * memory/feedback_klura_always_save_default.md and the plan note: agents skip
 * the documented "list_platform_skills first" step, so the catalog has to be
 * visible at conversation-start, not behind a tool call. The trailing
 * always-save sentence rides the same pre-load surface.
 */
export function getSavedSkillsSummaryMd(): string {
  const list = skills.listPlatformSkills();
  const rows: string[] = [];
  for (const skill of list) {
    if (skill.capabilities.length === 0) continue;
    const caps = skill.capabilities.map((c) => c.name).join(', ');
    rows.push(`${skill.platform}: ${caps}`);
  }
  if (rows.length === 0) return '';
  return [
    '## Currently saved skills',
    '',
    ...rows,
    '',
    'Klura is always for saving — if the user invoked klura, they want this saved. Default is save; the only non-save exit is `abort_session(reason)` for an explicit reason (existing capability covers this, user said no, site dead). "This is a one-off" is not a legitimate reason — it isn\'t your call.',
    '',
    'Call `list_platform_skills()` for full schemas, params, and discovery_artifacts before `start_session`.',
  ].join('\n');
}

const STRATEGY_TIER_VALUES = ['fetch', 'page-script', 'recorded-path'] as const;
type GetStrategyTier = (typeof STRATEGY_TIER_VALUES)[number];

export interface GetStrategyArgs {
  platform: string;
  capability: string;
  tier?: GetStrategyTier;
}

/**
 * Fetch a previously-saved strategy's full body so the LLM can continue from a
 * prior discovery attempt instead of re-inventing it. `list_platform_skills` only
 * surfaces a summary; this returns the whole strategy — including
 * `generated.frame.code` and `notes.params` — so the agent can read the prior
 * context and iterate.
 *
 * Ordering when `tier` is omitted: return the highest-tier strategy (fetch →
 * page-script → recorded-path).
 */
export function getStrategy(args: GetStrategyArgs): Strategy | null {
  let platform: string;
  let capability: string;
  let tier: GetStrategyTier | undefined;
  try {
    const obj = args as unknown as Record<string, unknown>;
    if (typeof obj !== 'object') {
      throw new Error('args must be an object');
    }
    platform = obj.platform as string;
    capability = obj.capability as string;
    if (typeof platform !== 'string' || !platform.trim()) {
      throw new Error('platform is required');
    }
    if (typeof capability !== 'string' || !capability.trim()) {
      throw new Error('capability is required');
    }
    if (obj.tier !== undefined && obj.tier !== null) {
      const t = obj.tier;
      asEnum(t, 'tier', STRATEGY_TIER_VALUES);
      tier = t as GetStrategyTier;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`invalid_get_strategy_args: ${msg}`, { cause: e });
  }

  const all = skills.loadStrategies(platform, capability);
  if (all.length === 0) return null;
  if (tier) {
    return all.find((s) => s.strategy === tier) ?? null;
  }
  return all[0] ?? null;
}

export function liftRate(): LiftRateReport {
  return computeLiftRate();
}

/**
 * Return the platform working-dir summary: logbook + latest derived signals
 * (field stability, bundle history, signer history). Runtime recomputes the
 * derived signals on every call (cheap over a few dozen archives; worth it to
 * avoid staleness).
 *
 * Agent-facing — this is the cross-run-awareness tool the triage step reads.
 * Pass a specific `capability` to narrow the payload.
 */
export function getPlatformLogbook(args: { platform: string; capability?: string }): {
  logbook: import('../working-dir/schema').PlatformLogbook;
  field_stability: import('../working-dir/derived/field-stability').FieldStabilityReport | null;
  bundle_history: import('../working-dir/derived/bundle-history').BundleHistoryReport | null;
  signer_history: import('../working-dir/derived/signer-history').SignerHistoryReport | null;
  known_modules: import('../working-dir/derived/known-modules').KnownModulesReport | null;
} {
  // Cheap: every derived module walks session archives (or saved strategies)
  // from disk. Worst-case O(N × M) where N = sessions and M = captured requests
  // per session; fine for the logbook surface which is read at consent-time,
  // not on every tool call.
  const logbook = loadLogbookForPlatform(args.platform);
  const field_stability = recomputeFieldStability(args.platform);
  const bundle_history = recomputeBundleHistory(args.platform);
  const signer_history = recomputeSignerHistory(args.platform);
  const known_modules = recomputeKnownModules(args.platform);
  if (args.capability) {
    const capLogbook = logbook.per_capability[args.capability];
    if (capLogbook) {
      const capFieldStability = field_stability.per_capability[args.capability];
      // Narrow known_modules to entries that name the requested capability in
      // their used_by list. Cross-capability re-use is still valuable signal (a
      // signer used across several capabilities is more trustworthy), so keep
      // the global list in scope when the caller filtered — but prioritize the
      // capability-specific subset.
      const capKnownModules = {
        ...known_modules,
        modules: known_modules.modules.filter((m) => m.used_by.includes(args.capability as string)),
      };
      return {
        logbook: {
          ...logbook,
          per_capability: { [args.capability]: capLogbook },
        },
        field_stability: capFieldStability
          ? {
              ...field_stability,
              per_capability: {
                [args.capability]: capFieldStability,
              },
            }
          : field_stability,
        bundle_history,
        signer_history,
        known_modules: capKnownModules,
      };
    }
  }
  return { logbook, field_stability, bundle_history, signer_history, known_modules };
}

export function liftRateFormatted(): string {
  return formatLiftRateReport(computeLiftRate());
}

export function clearAll(): void {
  skills.clearAll();
}

export function clearSkills(): void {
  skills.clearSkills();
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';
import { getStrategyEvents } from '../public-api';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.listPlatformSkills,
    description:
      'List every platform skill — one entry per platform with its saved capabilities and any observed-but-not-lifted ones. The "platform skill" is the bundle of all capabilities klura has learned for one site.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => listPlatformSkills(),
  },

  {
    name: TOOL_NAMES.getStrategy,
    description:
      "Return the full body of a previously-saved strategy — including `generated.<name>.code` and the complete `notes` block — so you can inspect a saved skill in detail. `list_platform_skills` only returns a summary; this is the detail-on-demand tool. Prior-discovery continuation context (verified expressions, envelope notes, resume pointers) lives in the capability's discovery_artifact, not in the strategy body — fetch it via `get_discovery_artifact_field` or read the inline block on end_drive's LIFT handoff (`triage[<cap>].discovery_artifact`). Ordering: if `tier` is omitted, returns the highest-tier saved strategy. Returns the raw strategy object, or `null` if none exists.",
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform name (e.g. "chat-app")' },
        capability: { type: 'string', description: 'Capability name (e.g. "send_message")' },
        tier: {
          type: 'string',
          enum: ['fetch', 'page-script', 'recorded-path'],
          description:
            'Optional: fetch a specific tier. Omit to use the default ordering (highest-tier saved strategy).',
        },
      },
      required: ['platform', 'capability'],
    },
    handler: (args: any) =>
      getStrategy({
        platform: args.platform,
        capability: args.capability,
        tier: args.tier,
      }),
  },

  {
    name: TOOL_NAMES.getStrategyEvents,
    description:
      'Return strategy life-cycle events for a platform, most recent first. Events are appended whenever a saved strategy is mutated: `discovered` / `rediscovered` on save, `tier_demote` on persistent transport failure, `archived` / `unarchived` on manual reset, `patched` on step patch, `healed` when a broken strategy recovers. Pass `capability` to narrow; pass `limit` to cap the slice (default 50). Use to answer "what changed about this skill lately?" without loading the full logbook.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        capability: { type: 'string', description: 'Optional capability slug to narrow.' },
        limit: { type: 'number', description: 'Max events to return (default 50).' },
      },
      required: ['platform'],
    },
    handler: (args: any) => getStrategyEvents(args.platform, args.capability, args.limit),
  },

  {
    name: TOOL_NAMES.getPlatformLogbook,
    description:
      'Return the platform working-dir summary: per-capability lift history, cross-session data sufficiency, field-stability classifier output, bundle-drift events, signer-anchor history, AND `known_modules` (in-page module / global names referenced by the platform\'s saved strategies — extract source is lexical, so if `LSMqttChannel` appears in a saved `require(...)` call, it\'s listed here as `{name:"LSMqttChannel", source:"require", used_by:["send_message", ...]}`). Use at end_drive / LIFT entry to see "how much do we already know about this platform?" — BEFORE enumerating training-prior module name guesses at `js_eval`, probe the names in `known_modules` first; those are the identifiers the page actually exposed in prior successful lifts. Pass `capability` to narrow the payload to one capability.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        capability: { type: 'string', description: 'Optional capability slug to narrow.' },
      },
      required: ['platform'],
    },
    handler: (args: any) =>
      getPlatformLogbook({
        platform: args.platform,
        capability: args.capability,
      }),
  },
];
