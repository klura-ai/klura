// Health-surface tools. Reads the per-strategy rolling success rate that
// the execute path's rediscover gate consumes — useful for the user to
// answer "is anything rotting on this platform?" before the gate fires
// mid-flow.

import fs from 'fs';
import path from 'path';
import { getKluraHome } from '../paths';
import { listPlatformHealth, successRate, isSilenced } from '../strategies/health';
import { loadConfig } from '../config/handler';
import { asPlatformSlug, ValidationError } from '../validators';

export interface StrategyHealthEntry {
  platform: string;
  capability: string;
  strategy_type: string;
  status: 'healthy' | 'degraded' | 'broken';
  /** Rolling success rate over up to the last 20 calls. `null` when the
   *  sample size is below MIN_SAMPLES_FOR_RATE — treat as "not enough
   *  signal" rather than "100%". */
  success_rate: number | null;
  samples: number;
  failure_count: number;
  last_success?: number;
  last_failure?: number;
  last_error?: string;
  silenced: boolean;
  /** True when the rolling rate has fallen below the configured rediscover
   *  threshold AND the capability is not silenced — i.e. the next `execute`
   *  call would raise the rediscover gate. */
  rediscover_gate_armed: boolean;
}

export interface GetStrategyHealthArgs {
  platform?: string;
}

export interface GetStrategyHealthResult {
  threshold: number;
  entries: StrategyHealthEntry[];
}

function workdirRoot(): string {
  return path.join(getKluraHome(), 'workdir');
}

function listKnownPlatforms(): string[] {
  const root = workdirRoot();
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function getStrategyHealth(args: GetStrategyHealthArgs = {}): GetStrategyHealthResult {
  let platforms: string[];
  if (args.platform !== undefined) {
    try {
      asPlatformSlug(args.platform, 'platform');
    } catch (e) {
      if (e instanceof ValidationError) {
        throw new Error(`invalid_get_strategy_health: ${e.message}`, { cause: e });
      }
      throw e;
    }
    platforms = [args.platform];
  } else {
    platforms = listKnownPlatforms();
  }

  const cfg = loadConfig();
  const threshold = cfg.pool.rediscoverThreshold;
  const entries: StrategyHealthEntry[] = [];

  for (const platform of platforms) {
    const rows = listPlatformHealth(platform);
    for (const r of rows) {
      const rate = successRate(r.status);
      const silenced = isSilenced(platform, r.capability);
      const rediscover_gate_armed = threshold > 0 && rate !== null && rate < threshold && !silenced;
      entries.push({
        platform,
        capability: r.capability,
        strategy_type: r.strategyType,
        status: r.status.status,
        success_rate: rate,
        samples: r.status.recent?.length ?? 0,
        failure_count: r.status.failureCount,
        last_success: r.status.lastSuccess,
        last_failure: r.status.lastFailure,
        last_error: r.status.lastError,
        silenced,
        rediscover_gate_armed,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    if (a.capability !== b.capability) return a.capability.localeCompare(b.capability);
    return a.strategy_type.localeCompare(b.strategy_type);
  });

  return { threshold, entries };
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tool-types';

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.getStrategyHealth,
  description:
    'Per-strategy rolling success rate + status for saved skills. Returns one row per (platform, capability, strategy_type) with `success_rate` (over the last ≤20 calls; null when fewer than 5 samples), `samples`, `status` (healthy/degraded/broken), `last_error`, `silenced`, and `rediscover_gate_armed` (true when the next `execute` call would raise the rediscover ack-gate). Pass `platform` to scope to one platform; omit to list all known platforms. Use this proactively to spot strategies that have rotted before they fire mid-flow. Threshold lives in `pool.rediscoverThreshold` (configure via the `configure` tool).',
  inputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string', description: 'Platform slug. Omit to list all platforms.' },
    },
  },
  handler: (args: any) => getStrategyHealth({ platform: args.platform }),
};
