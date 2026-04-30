import fs from 'fs';
import path from 'path';
import { SKILLS_DIR } from './skills';
import {
  asPlatformSlug,
  asIdentifierSlug,
  asObject,
  asEnum,
  asArray,
  asNonEmptyString,
  asPositiveInt,
  asBoundedString,
  ValidationError,
} from '../validators';

// Tier order: least lifty → most lifty (matches the cascade in
// skills.ts:loadStrategies and the T0/T1/T2 labels in lift/report.ts).
// `default_max_strategy_tier` caps how far up this ladder the platform can go
// by default; `per_capability[<cap>].max_strategy_tier` overrides the default
// for a specific capability (the more restrictive of the two wins).
const TIER_ORDER = ['recorded-path', 'page-script', 'fetch'] as const;
export type StrategyTier = (typeof TIER_ORDER)[number];

const MAX_PER_CAPABILITY_ENTRIES = 50;
const MAX_REASON_LEN = 200;

interface PerCapabilityPolicy {
  max_strategy_tier?: StrategyTier;
  // Audit trail for the user's reason when they set this cap — typically via
  // the `klura policy set` CLI or by editing ~/.klura/skills/<platform>/
  // policy.json directly. Policy is user-owned (permanent, ToS/compliance).
  reason?: string;
}

export interface PlatformPolicy {
  default_max_strategy_tier?: StrategyTier;
  per_capability?: Record<string, PerCapabilityPolicy>;
  throttle?: {
    min_interval_ms?: number;
    max_concurrent?: number;
    burst?: number;
  };
  respect_robots_txt?: boolean;
  forbid_capabilities?: string[];
  notes?: string;
}

const DEFAULT_POLICY: Required<Pick<PlatformPolicy, 'default_max_strategy_tier'>> & PlatformPolicy =
  {
    default_max_strategy_tier: 'fetch',
  };

function policyPath(platform: string): string {
  return path.join(SKILLS_DIR, platform, 'policy.json');
}

export function loadPolicy(platform: string): PlatformPolicy {
  try {
    return JSON.parse(fs.readFileSync(policyPath(platform), 'utf-8')) as PlatformPolicy;
  } catch {
    return {};
  }
}

export function policyExists(platform: string): boolean {
  try {
    asPlatformSlug(platform, 'platform');
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_policy: ${e.message}`, { cause: e });
    }
    throw e;
  }
  return fs.existsSync(policyPath(platform));
}

export function savePolicy(platform: string, policy: PlatformPolicy): void {
  try {
    asPlatformSlug(platform, 'platform');
    const obj = asObject(policy, 'policy');
    if ('default_max_strategy_tier' in obj && obj.default_max_strategy_tier !== undefined) {
      asEnum(obj.default_max_strategy_tier, 'policy.default_max_strategy_tier', TIER_ORDER);
    }
    if ('per_capability' in obj && obj.per_capability !== undefined) {
      const per = asObject(obj.per_capability, 'policy.per_capability');
      const entries = Object.keys(per);
      if (entries.length > MAX_PER_CAPABILITY_ENTRIES) {
        throw new ValidationError(
          'policy.per_capability',
          `has ${entries.length} entries; max is ${MAX_PER_CAPABILITY_ENTRIES}`,
        );
      }
      for (const cap of entries) {
        asIdentifierSlug(cap, `policy.per_capability["${cap}"]`);
        const v = asObject(per[cap], `policy.per_capability["${cap}"]`);
        if ('max_strategy_tier' in v && v.max_strategy_tier !== undefined) {
          asEnum(
            v.max_strategy_tier,
            `policy.per_capability["${cap}"].max_strategy_tier`,
            TIER_ORDER,
          );
        }
        if ('reason' in v && v.reason !== undefined) {
          asBoundedString(v.reason, `policy.per_capability["${cap}"].reason`, MAX_REASON_LEN);
        }
      }
    }
    if ('forbid_capabilities' in obj && obj.forbid_capabilities !== undefined) {
      const arr = asArray(obj.forbid_capabilities, 'policy.forbid_capabilities');
      arr.forEach((item, i) => {
        asNonEmptyString(item, `policy.forbid_capabilities[${i}]`);
      });
    }
    if ('throttle' in obj && obj.throttle !== undefined) {
      const t = asObject(obj.throttle, 'policy.throttle');
      if ('min_interval_ms' in t && t.min_interval_ms !== undefined) {
        asPositiveInt(t.min_interval_ms, 'policy.throttle.min_interval_ms');
      }
      if ('max_concurrent' in t && t.max_concurrent !== undefined) {
        asPositiveInt(t.max_concurrent, 'policy.throttle.max_concurrent');
      }
      if ('burst' in t && t.burst !== undefined) {
        asPositiveInt(t.burst, 'policy.throttle.burst');
      }
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_policy: ${e.message}`, { cause: e });
    }
    throw e;
  }

  const dir = path.join(SKILLS_DIR, platform);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(policyPath(platform), JSON.stringify(policy, null, 2));
}

export function clearPolicy(platform: string): void {
  try {
    asPlatformSlug(platform, 'platform');
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_policy: ${e.message}`, { cause: e });
    }
    throw e;
  }
  try {
    fs.unlinkSync(policyPath(platform));
  } catch {
    // already gone
  }
}

export function getEffectivePolicy(platform: string): PlatformPolicy {
  const saved = loadPolicy(platform);
  return { ...DEFAULT_POLICY, ...saved };
}

/**
 * Merge a per-capability cap into the platform's policy. Typically called when
 * the user declines an RE-lift prompt at close_session time — the runtime
 * writes the user's decision as a per-capability cap so future sessions don't
 * re-ask.
 */
/**
 * Set a user-owned capability policy. Called by the CLI path ( `klura policy
 * set ...`) and not exposed to the agent via MCP — the agent has no write path
 * to policy.json. Agent "I tried and couldn't" context accumulates in the
 * working-dir logbook and is read via get_platform_logbook.
 */
export function setCapabilityPolicy(
  platform: string,
  capability: string,
  max_strategy_tier: StrategyTier,
  reason?: string,
): void {
  try {
    asPlatformSlug(platform, 'platform');
    asIdentifierSlug(capability, 'capability');
    asEnum(max_strategy_tier, 'max_strategy_tier', TIER_ORDER);
    if (reason !== undefined) {
      asBoundedString(reason, 'reason', MAX_REASON_LEN);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_policy: ${e.message}`, { cause: e });
    }
    throw e;
  }
  const existing = loadPolicy(platform);
  const per: Record<string, PerCapabilityPolicy> = { ...(existing.per_capability ?? {}) };
  per[capability] = {
    max_strategy_tier,
    ...(reason !== undefined ? { reason } : {}),
  };
  savePolicy(platform, { ...existing, per_capability: per });
}

/**
 * Read the full per-capability policy entry. Used by close_session +
 * start_session + execute to check for user-owned caps.
 */
export function loadCapabilityPolicy(
  platform: string,
  capability: string,
): PerCapabilityPolicy | null {
  const policy = loadPolicy(platform);
  const entry = policy.per_capability?.[capability];
  return entry ?? null;
}

/**
 * Check whether a strategy tier is allowed for the given platform + capability.
 * Per-capability cap is consulted first, then the platform default. The more
 * restrictive of the two wins.
 */
export function isTierAllowed(platform: string, capability: string, tier: string): boolean {
  const policy = getEffectivePolicy(platform);
  const perCap = policy.per_capability?.[capability]?.max_strategy_tier;
  const defaultCap = policy.default_max_strategy_tier ?? 'fetch';
  const capsToCheck = perCap !== undefined ? [perCap, defaultCap] : [defaultCap];
  const tierIdx = TIER_ORDER.indexOf(tier as StrategyTier);
  if (tierIdx === -1) return true; // unknown tier → don't block
  for (const cap of capsToCheck) {
    const capIdx = TIER_ORDER.indexOf(cap);
    if (capIdx === -1) continue;
    if (tierIdx > capIdx) return false;
  }
  return true;
}

/** Check whether a capability is forbidden by the platform's policy. */
export function isCapabilityForbidden(platform: string, capability: string): boolean {
  const policy = getEffectivePolicy(platform);
  if (!policy.forbid_capabilities || policy.forbid_capabilities.length === 0) return false;
  return policy.forbid_capabilities.some((pattern) => globMatch(pattern, capability));
}

/** Simple glob matching — only supports `*` as wildcard. */
function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
  return regex.test(value);
}
