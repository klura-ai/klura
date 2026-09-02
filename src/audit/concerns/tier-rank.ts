// Tier-rank concern — the one speed ordering of strategy tiers.
//
// Consumers: the `tier_below_triage_verdict` Detector
// (audit/lift/save-strategy.ts), the save-authoring contract's tier-floor
// constraint + `submit_triage_plan`'s tier-above-floor advisory (via the
// re-export in phases/lift/save-authoring-contract.ts), and the capture
// stream's session-outcome fold + lift-attempt dedup
// (phases/drive/build-capture-events.ts). One table — the audit, the
// authoring hint, and the logbook evidence cannot disagree about which
// tier is "worse."

/** Speed-ordered rank: fetch fastest (0) → recorded-path slowest (2). */
export const TIER_RANK: Record<string, number> = {
  fetch: 0,
  'page-script': 1,
  'recorded-path': 2,
};

/** Rank of a tier string. Unknown tiers rank 0 (never flagged as a
 *  downgrade — the shape validators own tier-enum enforcement). */
export function tierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0;
}
