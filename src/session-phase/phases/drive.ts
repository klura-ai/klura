// DRIVE phase — agent driving the UI to the goal. Entry phase for the
// `discover` and `map` graphs. Exits via `end_drive` (which dispatches
// `end_drive_unresolved` when capabilities are unresolved) or `save_strategy`
// (which dispatches `resolved_via_save`). Per-graph behavior (consent gates,
// auto-synth skip, re-persistence threshold) lives in `graphConfig`, not in
// this spec.

import type { PhaseSpec, AdmissibilityResult, PhaseEvent, GraphConfig } from '../types';
import type { Session } from '../../drivers/types/session';
import type { DaemonConfig } from '../../config/handler';
import { DISCOVERY_ARTIFACT, DRIVE_ACTIVE, READ_ONLY_DIAGNOSTIC, unionSets } from '../tool-catalog';

const ALLOWED = unionSets(DRIVE_ACTIVE, READ_ONLY_DIAGNOSTIC, DISCOVERY_ARTIFACT);

/** When the budget is hit, the only accepted next call is the phase exit. */
const ALLOWED_WHEN_EXHAUSTED: ReadonlySet<string> = new Set(['end_drive']);

export const DRIVE_SPEC: PhaseSpec = {
  name: 'drive',
  allowedTools: ALLOWED,
  allowedToolsWhenExhausted: ALLOWED_WHEN_EXHAUSTED,

  onEnter(
    session: Session,
    ctx: { config: DaemonConfig; graphConfig: GraphConfig; event: PhaseEvent | null },
  ): void {
    session.drive = {
      enteredAt: Date.now(),
      roundsSinceEntry: 0,
      budget: ctx.config.drive.max_rounds,
      softBlockEngaged: false,
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
          `tool '${toolName}' is not available in phase 'drive'. ` +
          `In drive, you drive the UI toward the goal. ` +
          `When you have the captures you need, call \`end_drive\` to hand over to triage.`,
      };
    }
    if (session.drive?.softBlockEngaged && !this.allowedToolsWhenExhausted.has(toolName)) {
      return { ok: false, reason: this.exhaustedPrefix(session) };
    }
    return { ok: true };
  },

  exhaustedPrefix(session: Session): string {
    const n = session.drive?.roundsSinceEntry ?? 0;
    return (
      `[DRIVE BUDGET EXHAUSTED] You have spent ${n} rounds in drive. ` +
      `Call \`end_drive\` to hand over to triage. Other tools are blocked.`
    );
  },
};
