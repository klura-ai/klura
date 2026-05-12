// DRIVE phase — agent driving the UI to the goal. Entry phase for the
// `discover` and `map` graphs. Exits via `end_drive` (which dispatches
// `end_drive_unresolved` when capabilities are unresolved) or `save_strategy`
// (which dispatches `resolved_via_save`). Per-graph behavior (consent gates,
// auto-synth skip, re-persistence threshold) lives in `graphConfig`, not in
// this spec.

import type { PhaseSpec, AdmissibilityResult, PhaseEvent, GraphConfig } from './types';
import type { Session } from '../drivers/types/session';
import type { DaemonConfig } from '../config/handler';
import {
  CAPABILITY_DECLARATION,
  DISCOVERY_ARTIFACT,
  DRIVE_ACTIVE,
  ESCAPE_VALVE,
  LOGBOOK_WRITE,
  MAP_LIFT_INITIATOR,
  READ_ONLY_DIAGNOSTIC,
  unionSets,
} from './tool-catalog';

const ALLOWED = unionSets(
  DRIVE_ACTIVE,
  CAPABILITY_DECLARATION,
  READ_ONLY_DIAGNOSTIC,
  DISCOVERY_ARTIFACT,
  LOGBOOK_WRITE,
  MAP_LIFT_INITIATOR,
  ESCAPE_VALVE,
);

/** When the budget is hit, the only accepted next calls are the phase exits.
 *  abort_session is a co-equal exit — when the session shouldn't have started
 *  in the first place, the honest move is to abort, not to push through to
 *  end_drive's audit. */
const ALLOWED_WHEN_EXHAUSTED: ReadonlySet<string> = new Set(['end_drive', 'abort_session']);

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
    graphConfig?: GraphConfig,
  ): AdmissibilityResult {
    if (!this.allowedTools.has(toolName)) {
      // Rejection prose differs by graph shape. Discover/execute exit drive
      // via `end_drive` to triage. Map's drive is for exploration: triage
      // and lift are reachable via `lift_observed_capability` for any slug
      // the agent has already recorded. Branch on `skipAutoSynth` — the
      // canonical signal that the graph is map-shaped (no implicit
      // close-time auto-synth).
      const isMapShaped = graphConfig?.skipAutoSynth === true;
      let reason: string;
      if (isMapShaped && toolName === 'save_strategy') {
        reason =
          `tool 'save_strategy' is not available in phase 'drive'. In map mode, save_strategy ` +
          `runs in lift — which you enter by calling lift_observed_capability({session_id, name, ` +
          `args}) for a slug that's already on platform_logbook.observed_capabilities[]. The flow ` +
          `is: record_observed_capability(name, evidence, why_not_lifted) → lift_observed_capability(` +
          `name, args) → submit_triage_plan → save_strategy. If you haven't observed the capability ` +
          `yet, drive the UI to reach the surface, record_observed_capability, then lift.`;
      } else if (isMapShaped && toolName === 'submit_triage_plan') {
        reason =
          `tool 'submit_triage_plan' is not available in phase 'drive'. In map mode, triage opens ` +
          `when you call lift_observed_capability({session_id, name, args}) for an already-observed ` +
          `slug. Call that first; the FSM transitions to triage and submit_triage_plan becomes ` +
          `available.`;
      } else if (isMapShaped) {
        reason =
          `tool '${toolName}' is not available in phase 'drive' (map mode). ` +
          `Exit via end_drive when done, or call lift_observed_capability({name, args}) to enter ` +
          `triage+lift for a slug you've already recorded via record_observed_capability.`;
      } else {
        reason =
          `tool '${toolName}' is not available in phase 'drive'. ` +
          `In drive, you drive the UI toward the goal. When you have the captures you need, ` +
          `call \`end_drive\` to hand over to triage.`;
      }
      return { ok: false, reason };
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
