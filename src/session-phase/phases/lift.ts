// LIFT phase — agent executes the RE playbook against the plan. Active
// reverse-engineering tools (try_generator, debugger, monkey-patch via init
// scripts) are unlocked here.
//
// Re-entry distinguishes two cases via `session.triage.triggeredBy`:
//   - `plan_submitted` (agent re-planned the SAME surface) → preserve the
//     lift counter; the agent kept working on the same surface and the
//     re-plan is just an updated verdict.
//   - `surface_changed` (navigation crossed to a NEW surface) → fresh
//     budget; new surface, new work. Without this distinction the agent
//     re-enters lift on a fresh surface with the prior surface's
//     accumulated counter, which can fire a soft-block the new surface
//     doesn't deserve.

import type { PhaseSpec, AdmissibilityResult, PhaseEvent, GraphConfig } from '../types';
import type { Session } from '../../drivers/types/session';
import type { DaemonConfig } from '../../config/handler';
import {
  DISCOVERY_ARTIFACT,
  READ_ONLY_DIAGNOSTIC,
  TRIAGE_AND_LIFT_WRITE,
  LIFT_RE_ACTIVE,
  unionSets,
} from '../tool-catalog';

const ALLOWED = unionSets(
  READ_ONLY_DIAGNOSTIC,
  TRIAGE_AND_LIFT_WRITE,
  LIFT_RE_ACTIVE,
  DISCOVERY_ARTIFACT,
);

const ALLOWED_WHEN_EXHAUSTED: ReadonlySet<string> = new Set([
  'save_strategy',
  'submit_triage_plan',
]);

/** Default lift budget when the user hasn't set `lift.max_rounds`. `0` =
 *  unlimited; the soft-block check short-circuits when budget is 0. */

export const LIFT_SPEC: PhaseSpec = {
  name: 'lift',
  allowedTools: ALLOWED,
  allowedToolsWhenExhausted: ALLOWED_WHEN_EXHAUSTED,

  onEnter(
    session: Session,
    ctx: { config: DaemonConfig; graphConfig: GraphConfig; event: PhaseEvent | null },
  ): void {
    const budget = ctx.config.lift.max_rounds;
    const triageTrigger = session.triage?.triggeredBy ?? null;
    // Fresh budget on a new-surface re-entry; preserve counter on a
    // re-plan re-entry (the agent kept working on the same surface).
    // First-ever entry is also fresh by definition (no prior lift state).
    const freshBudget = !session.lift || triageTrigger === 'surface_changed';
    if (freshBudget) {
      session.lift = {
        handoffAt: Date.now(),
        roundsSinceHandoff: 0,
        budget,
        softBlockEngaged: false,
      };
    } else if (session.lift) {
      // Re-plan re-entry — refresh the budget from config (the user might
      // have raised the cap between submissions) but leave the counter.
      session.lift.budget = budget;
    }
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
          `tool '${toolName}' is not available in phase 'lift'. ` +
          `In lift, you execute the RE playbook against the bound surface and aim T0 (fetch) → T1 (page-script) → T2 (recorded-path) in order. ` +
          `Save the resulting strategy via \`save_strategy\` (gates on a triage plan for the targeted surface), ` +
          `or revise via \`submit_triage_plan\` if reality contradicts the verdict.`,
      };
    }
    if (session.lift?.softBlockEngaged && !this.allowedToolsWhenExhausted.has(toolName)) {
      return { ok: false, reason: this.exhaustedPrefix(session) };
    }
    return { ok: true };
  },

  exhaustedPrefix(session: Session): string {
    const n = session.lift?.roundsSinceHandoff ?? 0;
    return (
      `[LIFT BUDGET EXHAUSTED] You have spent ${n} rounds in lift. ` +
      `Commit what you have via \`save_strategy\` (auto-closes when last cap resolves), ` +
      `or call \`submit_triage_plan\` to revise the plan. RE-active tools are blocked.`
    );
  },
};
