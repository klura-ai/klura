// EXECUTE phase — entry phase for graph: 'execute'. The runtime invokes the
// saved strategy and dispatches `execute_succeeded` (→ terminal{closed}) or
// `execute_failed` (→ triage if the rediscover gate fires; → terminal{failed}
// otherwise). The agent's tool surface here is intentionally narrow: the
// strategy runs without per-call agent prompting.

import type { PhaseSpec, AdmissibilityResult, PhaseEvent, GraphConfig } from '../types';
import type { Session } from '../../drivers/types/session';
import type { DaemonConfig } from '../../config/handler';

const ALLOWED: ReadonlySet<string> = new Set([
  // Strategy invocation lifecycle the agent can drive while inside execute.
  'end_drive',
  'get_screenshot',
  // Auth recovery via the human-in-the-loop primitive.
  'start_remote_session',
  'stop_remote_session',
  'wait_for_remote',
  'get_secret',
]);

const ALLOWED_WHEN_EXHAUSTED: ReadonlySet<string> = new Set(['end_drive']);

export const EXECUTE_SPEC: PhaseSpec = {
  name: 'execute',
  allowedTools: ALLOWED,
  allowedToolsWhenExhausted: ALLOWED_WHEN_EXHAUSTED,

  onEnter(
    session: Session,
    _ctx: { config: DaemonConfig; graphConfig: GraphConfig; event: PhaseEvent | null },
  ): void {
    session.execute = {
      enteredAt: Date.now(),
      roundsSinceEntry: 0,
      // Execute phase has no rounds budget — the saved strategy runs as one
      // logical operation, and any agent rounds are scaffolding around it
      // (auth recovery, etc.). 0 short-circuits the soft-block check.
      budget: 0,
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
          `tool '${toolName}' is not available in phase 'execute'. ` +
          `In execute, the runtime is invoking a saved strategy. ` +
          `Auth-recovery + screenshot are available; everything else is blocked until the strategy completes.`,
      };
    }
    if (session.execute?.softBlockEngaged && !this.allowedToolsWhenExhausted.has(toolName)) {
      return { ok: false, reason: this.exhaustedPrefix(session) };
    }
    return { ok: true };
  },

  exhaustedPrefix(session: Session): string {
    const n = session.execute?.roundsSinceEntry ?? 0;
    return (
      `[EXECUTE BUDGET EXHAUSTED] You have spent ${n} rounds in execute. ` +
      `The strategy invocation is taking longer than expected; call \`end_drive\` to abort.`
    );
  },
};
