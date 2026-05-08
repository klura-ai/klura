// MCP-tool middleware. The MCP wrapper in `mcp/index.js` calls
// `assertToolAdmissibleBySessionId(sessionId, toolName)` before every
// tool dispatch. Inadmissible calls throw `ToolNotAdmissibleError` with a
// structured message explaining the rejection — the wrapper catches and
// returns the message as the tool result.
//
// Admitted calls also tick the per-phase round counter and flip
// `softBlockEngaged` when the budget is hit.

import type { Session } from '../drivers/types/session';
import { ToolNotAdmissibleError } from './types';
import { checkAdmissibility, currentPhase, UNIVERSAL_TOOLS } from './registry';
import { pool } from '../runtime-state';

/** Look up the per-phase counter / softBlockEngaged for the session's
 *  current phase. Returns undefined if the session has no phase state for
 *  that phase (e.g. fresh session with no drive bookkeeping yet — caller
 *  inits via the state machine before incrementing). */
function phaseState(session: Session): {
  roundsField: 'roundsSinceEntry' | 'roundsSinceHandoff';
  state: { [k: string]: unknown; budget: number; softBlockEngaged: boolean } | undefined;
} {
  const phase = currentPhase(session);
  switch (phase) {
    case 'drive':
      return { roundsField: 'roundsSinceEntry', state: session.drive };
    case 'triage':
      return { roundsField: 'roundsSinceEntry', state: session.triage };
    case 'lift':
      return { roundsField: 'roundsSinceHandoff', state: session.lift };
    case 'execute':
      return { roundsField: 'roundsSinceEntry', state: session.execute };
  }
}

/** Throws ToolNotAdmissibleError if the tool is not allowed in the
 *  session's current phase. Universal tools (memory reads, control plane,
 *  start_session, etc.) always pass. */
export function assertToolAdmissible(session: Session, toolName: string): void {
  const result = checkAdmissibility(session, toolName);
  if (!result.ok) {
    throw new ToolNotAdmissibleError(toolName, currentPhase(session), result.reason);
  }
}

/** Increment the current phase's round counter on an admitted call.
 *  Updates `softBlockEngaged` when the counter crosses the budget.
 *  Universal tools don't burn budget — they're administrative / read-only.
 *
 *  Concurrency: counter mutation is not synchronized. The MCP transport
 *  serializes tool calls per-session (one in-flight call at a time), so
 *  read-modify-write here is safe. If a future surface admits parallel
 *  per-session tool calls, this needs an atomic increment. */
export function tickPhaseCounter(session: Session, toolName: string): void {
  if (UNIVERSAL_TOOLS.has(toolName)) return;
  const { roundsField, state } = phaseState(session);
  if (!state) return;
  const stateAny = state as Record<string, number | boolean | undefined>;
  const prev = stateAny[roundsField];
  stateAny[roundsField] = (typeof prev === 'number' ? prev : 0) + 1;
  if (typeof state.budget === 'number' && state.budget > 0) {
    const next = stateAny[roundsField];
    if (typeof next === 'number' && next >= state.budget) {
      state.softBlockEngaged = true;
    }
  }
}

export { ToolNotAdmissibleError };

/** MCP-side entry point. Looks up the session by id, runs admissibility,
 *  and ticks the counter on admitted calls. Universal tools (control
 *  plane, memory reads, escape valve) bypass entirely — they're valid
 *  even when the targeted session is closed or never existed. For
 *  non-universal tools, an unknown / closed session surfaces a clean
 *  ToolNotAdmissibleError rather than the silent no-op that masked
 *  references to deleted sessions. */
export function assertToolAdmissibleBySessionId(sessionId: string, toolName: string): void {
  if (UNIVERSAL_TOOLS.has(toolName)) return;
  let session: Session;
  try {
    session = pool.getSession(sessionId);
  } catch {
    throw new ToolNotAdmissibleError(
      toolName,
      'terminal',
      `tool '${toolName}' references session id '${sessionId}' which is unknown or already closed. ` +
        `Open a new session with \`start_session\`.`,
    );
  }
  assertToolAdmissible(session, toolName);
  tickPhaseCounter(session, toolName);
}
