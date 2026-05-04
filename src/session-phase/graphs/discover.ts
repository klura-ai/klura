// Discover graph — drive→triage→lift→terminal{closed}. The default flow
// for goal-directed sessions: agent drives the UI, hands off to triage to
// read the defense surface, the user approves a per-surface plan, and lift
// runs the RE playbook to land a saved strategy.

import type { Graph } from '../types';

export const DISCOVER_GRAPH: Graph = {
  name: 'discover',
  entryPhase: 'drive',
  nodes: new Set(['drive', 'triage', 'lift']),
  transitions: [
    { from: 'drive', on: 'end_drive_unresolved', to: 'triage' },
    { from: 'drive', on: 'resolved_via_save', to: { kind: 'terminal', status: 'closed' } },
    { from: 'drive', on: 'surface_changed', to: 'triage' },
    { from: 'triage', on: 'plan_submitted', to: 'triage' },
    { from: 'triage', on: 'plan_handoff', to: 'lift' },
    { from: 'triage', on: 'surface_changed', to: 'triage' },
    { from: 'triage', on: 'resolved_via_save', to: { kind: 'terminal', status: 'closed' } },
    { from: 'lift', on: 'plan_submitted', to: 'triage' },
    { from: 'lift', on: 'surface_changed', to: 'triage' },
    { from: 'lift', on: 'resolved_via_save', to: { kind: 'terminal', status: 'closed' } },
  ],
  config: {
    obligationStyle: 'lift_required',
    // Fire the end_drive re_persistence classifier when the agent did real
    // RE work (jsEval / breakpoint / source-read / inline-script-via-full-network-log)
    // but persisted nothing. Action-only threshold is 0 because normal
    // discover sessions do many drives en route to save_strategy without ever
    // needing artifact persistence — that's not the cross-session handoff
    // pattern this gate guards.
    rePersistenceThreshold: { reCalls: 1, actions: 0 },
  },
};
