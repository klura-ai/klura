// Phase registry — indexed table of PhaseSpec instances + helpers.
//
// `currentPhase` and `currentSpec` are the read-only accessors every other
// module uses. `currentGraph` resolves the active graph from the session.
// `graphConfig` returns the per-graph PhaseConfig for the current phase.
// `checkAdmissibility` is the top-level admissibility check that funnels
// through universal-tools-first, then status-check, then phase-specific.

import type { Session } from '../drivers/types/session';
import type { Graph, PhaseSpec, GraphConfig, SessionPhase, AdmissibilityResult } from './types';
import { DRIVE_SPEC } from './drive';
import { TRIAGE_SPEC } from './triage';
import { LIFT_SPEC } from './lift';
import { EXECUTE_SPEC } from './execute';
import { GRAPHS, graphFor } from '../graphs';
import { UNIVERSAL_TOOLS } from './tool-catalog';

const PHASES: Record<SessionPhase, PhaseSpec> = {
  drive: DRIVE_SPEC,
  triage: TRIAGE_SPEC,
  lift: LIFT_SPEC,
  execute: EXECUTE_SPEC,
};

export function specFor(phase: SessionPhase): PhaseSpec {
  return PHASES[phase];
}

export function currentGraph(session: Session): Graph {
  return graphFor(session.graph ?? 'discover');
}

export function graphConfig(session: Session): GraphConfig {
  return currentGraph(session).config;
}

export function currentPhase(session: Session): SessionPhase {
  // `phase === undefined` ≡ fresh, never-dispatched session — resolve to the
  // active graph's entry phase. A half-initialized session (no `phase` but
  // already-set bookkeeping for some non-entry phase) would silently
  // masquerade as fresh and drop into the entry's onEnter on the next
  // dispatch, clobbering state. Loud failure beats silent corruption.
  if (session.phase === undefined) {
    const entry = currentGraph(session).entryPhase;
    const stale = (['drive', 'triage', 'lift', 'execute'] as SessionPhase[]).find((p) => {
      if (p === entry) return false;
      return (session as unknown as Record<SessionPhase, unknown>)[p] !== undefined;
    });
    if (stale) {
      throw new Error(
        `currentPhase: session ${session.id} has phase=undefined but ${stale} bookkeeping is populated — half-initialized session would masquerade as fresh on next dispatch`,
      );
    }
    return entry;
  }
  return session.phase;
}

export function currentSpec(session: Session): PhaseSpec {
  return specFor(currentPhase(session));
}

/** Top-level tool admissibility — universal tools first (always pass),
 *  then the session-status short-circuit for finalized sessions, then the
 *  current phase spec with the active graph's per-phase config. */
export function checkAdmissibility(session: Session, toolName: string): AdmissibilityResult {
  if (UNIVERSAL_TOOLS.has(toolName)) return { ok: true };
  if (session.status === 'closed' || session.status === 'failed') {
    return {
      ok: false,
      reason:
        `tool '${toolName}' cannot run on a session whose status is '${session.status}' — ` +
        `the session has been finalized. Open a new session with \`start_session\` to continue work.`,
    };
  }
  return currentSpec(session).checkAdmissibility(toolName, session, graphConfig(session));
}

export { GRAPHS, UNIVERSAL_TOOLS };
