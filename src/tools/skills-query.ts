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
import { computeLiftRate, formatLiftRateReport } from '../lift/report';
import type { LiftRateReport } from '../lift/report';
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
  `    The audit is UNACKABLE — your save will be rejected and you'll\n` +
  `    have to start over with the existing slug anyway.\n\n` +
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
