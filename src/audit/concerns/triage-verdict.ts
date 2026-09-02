// Triage-verdict concern — the one logbook read for "what tier did the
// agent's own triage plan commit to for this surface."
//
// Consumers:
//   - `tierBelowTriageVerdictDetector` (audit/lift/save-strategy.ts) —
//     resolves the surface bound to the strategy's target URL, then asks
//     for that surface's verdict.
//   - `composeSaveAuthoringContract` (phases/lift/save-authoring-contract.ts)
//     — resolves the surface from the primary data-load URL via
//     `lookupSurface` and only falls back to first-plan iteration when the
//     URL is unbound, so with multiple triaged surfaces the contract
//     surfaces the same tier floor the detector will enforce.
//
// Parity is enforced by runtime/test/authoring-contract-parity.test.js.

import { loadLogbook } from '../../working-dir/logbook';

export type VerdictTier = 'fetch' | 'page-script' | 'recorded-path';

export interface TriageVerdict {
  tier: VerdictTier;
  surface: string;
  /** The plan's tier_justification, when present — the detector quotes an
   *  excerpt back at the agent. */
  justification?: string;
}

function verdictFromPlan(plan: unknown, surface: string): TriageVerdict | null {
  if (!plan || typeof plan !== 'object') return null;
  const t = (plan as { expected_tier?: unknown }).expected_tier;
  if (t !== 'fetch' && t !== 'page-script' && t !== 'recorded-path') return null;
  const j = (plan as { tier_justification?: unknown }).tier_justification;
  return {
    tier: t,
    surface,
    ...(typeof j === 'string' && j.length > 0 ? { justification: j } : {}),
  };
}

/** Verdict for one specific surface of one capability, or null when the
 *  logbook has no plan (or an unreadable one) for that surface. */
export function findTriageVerdict(
  platform: string,
  capability: string,
  surface: string,
): TriageVerdict | null {
  let logbook: ReturnType<typeof loadLogbook>;
  try {
    logbook = loadLogbook(platform);
  } catch {
    return null;
  }
  const plan = logbook.per_capability[capability]?.triage_plans_by_surface?.[surface];
  return verdictFromPlan(plan, surface);
}

/** Fallback when the caller cannot resolve a specific surface (e.g. the
 *  contract composer with no bound data-load URL): first surface with a
 *  valid tier, in plan-map iteration order. */
export function findFirstTriageVerdict(platform: string, capability: string): TriageVerdict | null {
  let logbook: ReturnType<typeof loadLogbook>;
  try {
    logbook = loadLogbook(platform);
  } catch {
    return null;
  }
  const plansBySurface = logbook.per_capability[capability]?.triage_plans_by_surface;
  if (!plansBySurface || typeof plansBySurface !== 'object') return null;
  for (const [surface, plan] of Object.entries(plansBySurface)) {
    const verdict = verdictFromPlan(plan, surface);
    if (verdict) return verdict;
  }
  return null;
}
