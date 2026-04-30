// Rediscover failure gate — predicate on `execute_failed` payloads in the
// `execute` graph. When the gate fires, the FSM routes execute → triage so
// the agent can re-plan and re-lift the strategy. When it doesn't fire, the
// graph terminates with status: 'failed' and the agent gets a structured
// error back.
//
// Two signals, structural-first then rate-based fallback:
//
//  1. **Structural**: the cascade's `AutoExecDiagnosis.kind` (composed in
//     `runtime/src/execution.ts`). Stale-shape kinds (`stale_nonce`,
//     `endpoint_stale`, `needs_rediscovery`, `prereq_returned_undefined`)
//     trip the gate on the first failure — the runtime already
//     classified the failure as "the saved shape no longer fits the wire,"
//     so retrying is by-construction futile and triage→lift IS the next
//     useful move. `auth_failed` doesn't trip — relearn won't help,
//     the user needs to re-auth via remote viewer. `unknown` falls
//     through to the rate-based fallback (conservative — caller-arg
//     garbage shouldn't trigger rediscovery on its own).
//
//  2. **Rate-based fallback**: when the diagnosis is `unknown` or absent,
//     a saved strategy is "stale" when its rolling success rate across
//     saved tiers has fallen below `pool.rediscoverThreshold`. Same
//     signal used by the pre-execute ack-gate in `runtime/src/tools/execute.ts`.
//
// Without (1), a fresh strategy with no failure history (rate=1.0) would
// never trip the gate even when the cascade explicitly says
// `needs_rediscovery: true`. The README's "Execute + Relearn" promise
// requires (1).

import type { Session } from '../../drivers/types/session';
import { loadConfig } from '../../config/handler';
import * as skills from '../../strategies/skills';
import { getHealth, successRate } from '../../strategies/health';

export interface ExecuteFailedPayload {
  platform: string;
  capability: string;
  error: string;
  /** The cascade's typed failure classification. Plumbed from
   *  `body.diagnosis.kind` of the execute result. Drives the structural
   *  signal in this gate; absent on synthetic failures (e.g. caller
   *  didn't pass args) where the cascade never ran. */
  diagnosis_kind?: AutoExecDiagnosisKind;
}

/** Mirrors `AutoExecDiagnosis['kind']` in `runtime/src/execution.ts` —
 *  duplicated here to keep this guard module free of an executor import.
 *  When a new diagnosis kind is added there, add it here too and decide
 *  its rediscover semantics in `STALE_SHAPE_KINDS`. */
export type AutoExecDiagnosisKind =
  | 'stale_nonce'
  | 'auth_failed'
  | 'endpoint_stale'
  | 'prereq_returned_undefined'
  | 'needs_rediscovery'
  | 'unknown';

/** Diagnosis kinds where rediscovery is by-construction the right next
 *  move. Each represents "the saved shape no longer fits the wire" —
 *  retrying with the same shape is futile, but a re-plan + re-lift can
 *  produce a working shape from the same session. */
const STALE_SHAPE_KINDS: ReadonlySet<AutoExecDiagnosisKind> = new Set([
  'stale_nonce',
  'endpoint_stale',
  'needs_rediscovery',
  'prereq_returned_undefined',
]);

function worstRecentRate(platform: string, capability: string): number | null {
  const saved = skills.loadStrategies(platform, capability);
  if (saved.length === 0) return null;
  let worst: number | null = null;
  for (const s of saved) {
    const type = (s as { type?: string }).type;
    if (typeof type !== 'string') continue;
    const h = getHealth(platform, capability, type);
    const rate = successRate(h);
    if (rate === null) continue;
    if (worst === null || rate < worst) worst = rate;
  }
  return worst;
}

export function rediscoverFailureGate(_session: Session, payload: unknown): boolean {
  const p = payload as ExecuteFailedPayload | undefined;
  if (!p || typeof p.platform !== 'string' || typeof p.capability !== 'string') return false;

  // 1. Structural signal: typed diagnosis kind from the cascade. Trips
  //    on the first failure for stale-shape kinds — no rate history
  //    needed.
  if (p.diagnosis_kind && STALE_SHAPE_KINDS.has(p.diagnosis_kind)) return true;

  // 2. Rate-based fallback for `unknown` / absent diagnosis: only trip
  //    when the rolling success rate has fallen below threshold.
  const threshold = loadConfig().pool.rediscoverThreshold;
  if (threshold <= 0) return false;
  const worst = worstRecentRate(p.platform, p.capability);
  if (worst === null) return false;
  return worst < threshold;
}
