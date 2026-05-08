// DRIVE phase — agent driving the UI to the goal. Entry phase for the
// `discover` and `map` graphs. Exits via `end_drive` (which dispatches
// `end_drive_unresolved` when capabilities are unresolved) or `save_strategy`
// (which dispatches `resolved_via_save`). Per-graph behavior (consent gates,
// auto-synth skip, re-persistence threshold) lives in `graphConfig`, not in
// this spec.

import type { PhaseSpec, AdmissibilityResult, PhaseEvent, GraphConfig } from '../types';
import type { Session } from '../../drivers/types/session';
import type { DaemonConfig } from '../../config/handler';
import {
  DISCOVERY_ARTIFACT,
  DRIVE_ACTIVE,
  ESCAPE_VALVE,
  LOGBOOK_WRITE,
  READ_ONLY_DIAGNOSTIC,
  unionSets,
} from '../tool-catalog';

const ALLOWED = unionSets(
  DRIVE_ACTIVE,
  READ_ONLY_DIAGNOSTIC,
  DISCOVERY_ARTIFACT,
  LOGBOOK_WRITE,
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
      // via `end_drive` to triage. Map has no triage / lift / save path —
      // map is observation-only by design; strategies are committed in
      // `discover` graph (which has the triage + lift phases that classify
      // the surface and audit the save). Map's exit teaches the warm-start
      // handoff so the agent knows where their findings actually live and
      // how the next session lifts them. Branch on `skipAutoSynth` — the
      // canonical signal that the graph has no auto-save path.
      const isMapShaped = graphConfig?.skipAutoSynth === true;
      let reason: string;
      if (isMapShaped && toolName === 'save_strategy') {
        reason =
          `tool 'save_strategy' is not available in map mode. Map is observation-only; ` +
          `strategies are committed in 'discover' graph (which has triage + lift phases that ` +
          `classify the surface and audit the save). Persist your findings here via:\n` +
          `  - record_observed_capability(name, evidence, why_not_lifted) — flags a capability ` +
          `for next-session lift; lands in the platform_logbook\n` +
          `  - save_verified_expression(capability, expression, returns) — captures an executable ` +
          `JS snippet on the discovery_artifact\n` +
          `  - add_discovery_note(capability, kind, body) — captures structural prose findings\n` +
          `  - add_resume_pointer(capability, kind, ref) — drops a typed pointer (file:line, ` +
          `frame index, page URL) for the next session\n\n` +
          `Then follow up with start_session({graph: 'discover', platform: '<X>', ` +
          `capability: '<Y>'}) — it inlines your priors at turn 0 (under artifacts.<capability>) ` +
          `so the next agent warm-starts from your verified_expressions / notes / resume_pointers.`;
      } else if (isMapShaped) {
        reason =
          `tool '${toolName}' is not available in phase 'drive'. Map mode is observation-only ` +
          `with a single drive phase — exit via end_drive when done walking the surface.`;
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
