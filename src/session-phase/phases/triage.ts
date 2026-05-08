// TRIAGE phase — agent inspects the page's defense surface (third-party
// origins, scripts, cookies, request patterns) and submits a per-surface
// plan via `submit_triage_plan` with a tier suggestion + cited
// justification. The `triage_plan` checkpoint resolves either approve
// (→ lift) or reject (→ stay in triage with a fresh budget). Tier
// suggestion is informational; the agent still aims T0 → T1 → T2 in lift.
// Every `save_strategy` flows through the per-surface triage gate — no
// escape hatch.

import type { PhaseSpec, AdmissibilityResult, PhaseEvent, GraphConfig } from '../types';
import type { Session } from '../../drivers/types/session';
import type { DaemonConfig } from '../../config/handler';
import {
  DISCOVERY_ARTIFACT,
  ESCAPE_VALVE,
  LOGBOOK_WRITE,
  READ_ONLY_DIAGNOSTIC,
  TRIAGE_AND_LIFT_WRITE,
  unionSets,
} from '../tool-catalog';

const ALLOWED = unionSets(
  READ_ONLY_DIAGNOSTIC,
  TRIAGE_AND_LIFT_WRITE,
  DISCOVERY_ARTIFACT,
  LOGBOOK_WRITE,
  ESCAPE_VALVE,
);

const ALLOWED_WHEN_EXHAUSTED: ReadonlySet<string> = new Set([
  'submit_triage_plan',
  'abort_session',
]);

/** Default triage round budget when the user hasn't set
 *  `triage.max_rounds`. Tight by design — deliberation is short, lift is
 *  where rounds get spent. */
export const DEFAULT_TRIAGE_MAX_ROUNDS = 10;

export const TRIAGE_SPEC: PhaseSpec = {
  name: 'triage',
  allowedTools: ALLOWED,
  allowedToolsWhenExhausted: ALLOWED_WHEN_EXHAUSTED,

  onEnter(
    session: Session,
    ctx: { config: DaemonConfig; graphConfig: GraphConfig; event: PhaseEvent | null },
  ): void {
    // Stash the live `lift.max_rounds` so `exhaustedPrefix` (a pure prose
    // builder) can describe the next phase's budget without reaching back
    // into the config module. Inverts the "this system rations rounds"
    // prior described in arxiv 2604.01664 and arxiv 2604.19780 (per-phase
    // explicit budget declaration).
    //
    // Stash `triggeredBy` so lift's onEnter can distinguish re-plan
    // re-entry (preserve counter) from surface-change re-entry (fresh
    // budget for the new surface). Without this lift can't tell whether
    // the round counter should reset.
    session.triage = {
      enteredAt: Date.now(),
      roundsSinceEntry: 0,
      budget: ctx.config.triage.max_rounds,
      softBlockEngaged: false,
      liftBudgetSnapshot: ctx.config.lift.max_rounds,
      triggeredBy: ctx.event?.kind ?? null,
    };
  },

  checkAdmissibility(
    toolName: string,
    session: Session,
    _graphConfig: GraphConfig,
  ): AdmissibilityResult {
    if (!this.allowedTools.has(toolName)) {
      return {
        ok: false,
        reason:
          `tool '${toolName}' is not available in phase 'triage'. ` +
          `In triage, you read the page's defense surface (third-party origins, ` +
          `scripts, cookies, request patterns) and submit a per-surface plan via ` +
          `\`submit_triage_plan\`.`,
      };
    }
    if (session.triage?.softBlockEngaged && !this.allowedToolsWhenExhausted.has(toolName)) {
      return { ok: false, reason: this.exhaustedPrefix(session) };
    }
    return { ok: true };
  },

  exhaustedPrefix(session: Session): string {
    const n = session.triage?.roundsSinceEntry ?? 0;
    const liftMax = session.triage?.liftBudgetSnapshot ?? 0;
    const liftLine =
      liftMax === 0
        ? `**LIFT (the next phase) has no round limit.**`
        : `LIFT (the next phase) has a budget of ${liftMax} rounds.`;
    return (
      `[TRIAGE BUDGET EXHAUSTED] You have spent ${n} rounds in triage. ` +
      `This budget is specific to triage (deliberation is short by design). ` +
      `${liftLine} ` +
      `Submit your best defense-surface plan with whatever signals you've gathered via ` +
      `\`submit_triage_plan\`. Diagnostic tools are blocked.`
    );
  },
};
