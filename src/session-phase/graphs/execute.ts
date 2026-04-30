// Execute graph — execute→triage→lift→terminal{closed|failed}. Runs a saved
// strategy. On success, terminates clean. On failure, the rediscover-gate
// classifier routes: stale-strategy failures fall into triage with the
// failure as defense-surface input (agent re-plans, then lifts to fix);
// arg/auth/structural failures terminate with status: 'failed' (agent gets
// a structured error back).

import type { Graph, GraphTransition } from '../types';
import { rediscoverFailureGate } from '../guards/rediscover';

const transitions: GraphTransition[] = [
  { from: 'execute', on: 'execute_succeeded', to: { kind: 'terminal', status: 'closed' } },
  // Order matters: the guarded transition must precede the fallback.
  { from: 'execute', on: 'execute_failed', to: 'triage', when: rediscoverFailureGate },
  { from: 'execute', on: 'execute_failed', to: { kind: 'terminal', status: 'failed' } },
  { from: 'triage', on: 'plan_submitted', to: 'triage' },
  { from: 'triage', on: 'plan_handoff', to: 'lift' },
  { from: 'triage', on: 'surface_changed', to: 'triage' },
  { from: 'triage', on: 'resolved_via_save', to: { kind: 'terminal', status: 'closed' } },
  { from: 'lift', on: 'plan_submitted', to: 'triage' },
  { from: 'lift', on: 'surface_changed', to: 'triage' },
  { from: 'lift', on: 'resolved_via_save', to: { kind: 'terminal', status: 'closed' } },
];

export const EXECUTE_GRAPH: Graph = {
  name: 'execute',
  entryPhase: 'execute',
  nodes: new Set(['execute', 'triage', 'lift']),
  transitions,
  config: {},
};
