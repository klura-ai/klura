// State-machine dispatcher. Looks up the destination for an event in the
// active graph's transition table; runs guards (when present) to pick
// between alternates; on terminal targets, stamps session.status; on phase
// targets, runs the destination's onEnter hook with the per-graph config.
// Throws SessionPhaseTransitionError on illegal events. The **only** writer
// of session.phase, session.status, and the per-phase bookkeeping fields.

import type { Session } from '../drivers/types/session';
import type { PhaseEvent, SessionPhase, TerminalNode, TransitionResult } from './types';
import { SessionPhaseTransitionError, isTerminal } from './types';
import { currentGraph, currentPhase, graphConfig, specFor } from './registry';
import { loadConfig } from '../config/handler';

function resolveDestination(
  session: Session,
  fromPhase: SessionPhase,
  event: PhaseEvent,
): SessionPhase | TerminalNode | undefined {
  const graph = currentGraph(session);
  for (const t of graph.transitions) {
    if (t.from !== fromPhase) continue;
    if (t.on !== event.kind) continue;
    if (t.when && !t.when(session, event.payload)) continue;
    return t.to;
  }
  return undefined;
}

function applyDestination(
  session: Session,
  to: SessionPhase | TerminalNode,
  event: PhaseEvent | null,
): void {
  if (isTerminal(to)) {
    session.status = to.status;
    return;
  }
  session.phase = to;
  specFor(to).onEnter(session, {
    config: loadConfig(),
    graphConfig: graphConfig(session),
    event,
  });
}

export function dispatch(session: Session, event: PhaseEvent): TransitionResult {
  const fromPhase = currentPhase(session);
  const to = resolveDestination(session, fromPhase, event);
  if (!to) throw new SessionPhaseTransitionError(fromPhase, event.kind);
  applyDestination(session, to, event);
  return { from: fromPhase, to, event: event.kind, at: Date.now() };
}

/** Force the destination phase regardless of source — used by callers that
 *  are bypassing event-based transitions for tests or recovery. Prefer
 *  `dispatch` in production code. `event: null` on the result reflects
 *  that no PhaseEvent originated this transition. */
export function forceTransition(
  session: Session,
  to: SessionPhase | TerminalNode,
): TransitionResult {
  const fromPhase = currentPhase(session);
  applyDestination(session, to, null);
  return { from: fromPhase, to, event: null, at: Date.now() };
}
