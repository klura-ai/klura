// Tier stamping for saved strategies. Every save_strategy call records which
// tier the strategy landed at on first save, so LIFT rate (% of capabilities
// that escape the browser on warm runs) is measurable from the skill corpus
// without replaying anything.

export type LiftTier = 'fetch' | 'page-script' | 'recorded-path';

export interface TierStamp {
  tier: LiftTier;
  stampedAt: string;
}

export function stampTier(tier: LiftTier): TierStamp {
  return {
    tier,
    stampedAt: new Date().toISOString(),
  };
}
