// LIFT rate reporter: walks the saved skill corpus, picks each capability's
// best-tier strategy, and aggregates tier_stamp counts. "LIFT rate" is the
// share of capabilities that escape the browser on warm runs — i.e.
// capabilities whose best tier is T0 (fetch).

import { listPlatformSkills, loadStrategies } from '../strategies/skills';
import type { LiftTier } from './telemetry';

const TIER_ORDER: LiftTier[] = ['fetch', 'page-script', 'recorded-path'];

const TIER_LABELS: Record<LiftTier, string> = {
  fetch: 'T0 fetch',
  'page-script': 'T1 page-script',
  'recorded-path': 'T2 recorded-path',
};

export interface LiftRateCapability {
  platform: string;
  capability: string;
}

export interface LiftRateReport {
  total: number;
  liftCount: number;
  liftRate: number;
  counts: Record<LiftTier, number>;
  byTier: Record<LiftTier, LiftRateCapability[]>;
  unstamped: number;
}

function emptyCounts(): Record<LiftTier, number> {
  return {
    fetch: 0,
    'page-script': 0,
    'recorded-path': 0,
  };
}

function emptyByTier(): Record<LiftTier, LiftRateCapability[]> {
  return {
    fetch: [],
    'page-script': [],
    'recorded-path': [],
  };
}

function isLiftTier(value: unknown): value is LiftTier {
  return value === 'fetch' || value === 'page-script' || value === 'recorded-path';
}

export function computeLiftRate(): LiftRateReport {
  const counts = emptyCounts();
  const byTier = emptyByTier();
  let total = 0;
  let unstamped = 0;

  for (const skill of listPlatformSkills()) {
    for (const capability of skill.capabilities) {
      const strategies = loadStrategies(skill.platform, capability.name);
      // loadStrategies sorts best-tier-first (fetch > page-script >
      // recorded-path), so strategies[0] is the tier the runtime will actually
      // cascade to first.
      const best = strategies[0];
      if (!best) continue;
      const stampedTier = best.tier_stamp?.tier;
      let tier: LiftTier | null = null;
      if (isLiftTier(stampedTier)) {
        tier = stampedTier;
      } else if (isLiftTier(best.strategy)) {
        tier = best.strategy;
      }

      if (!tier) continue;
      if (!best.tier_stamp) unstamped += 1;

      counts[tier] += 1;
      byTier[tier].push({ platform: skill.platform, capability: capability.name });
      total += 1;
    }
  }

  const liftCount = counts['fetch'];
  const liftRate = total === 0 ? 0 : liftCount / total;

  return { total, liftCount, liftRate, counts, byTier, unstamped };
}

export function formatLiftRateReport(report: LiftRateReport): string {
  const { total, liftCount, liftRate, counts, byTier, unstamped } = report;

  if (total === 0) {
    return 'No saved skills found.';
  }

  const lines: string[] = [];
  const pct = Math.round(liftRate * 100);
  lines.push(`LIFT rate: ${pct}% (${liftCount}/${total} at T0)`);
  lines.push('');

  for (const tier of TIER_ORDER) {
    const label = TIER_LABELS[tier];
    const count = counts[tier];
    const tierPct = total === 0 ? 0 : Math.round((count / total) * 100);
    const examples = byTier[tier].slice(0, 3).map((e) => `${e.platform}/${e.capability}`);
    const more = byTier[tier].length > 3 ? ` +${byTier[tier].length - 3} more` : '';
    const tail = count > 0 ? `   ${examples.join(', ')}${more}` : '';
    lines.push(
      `  ${label.padEnd(18)} ${String(count).padStart(3)} (${String(tierPct).padStart(3)}%)${tail}`,
    );
  }

  if (unstamped > 0) {
    lines.push('');
    lines.push(
      `Note: ${unstamped} capability${unstamped === 1 ? '' : ' entries'} had no tier_stamp (pre-telemetry files). Re-save to backfill.`,
    );
  }

  return lines.join('\n');
}
