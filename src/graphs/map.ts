// Map graph — drive ⇄ triage ⇄ lift, closing via terminal{closed} on
// end_drive_unresolved from any phase. Platform-mapping mode: agent walks
// the site to enrich the platform_map, and may opt into a lift cycle for
// individual observed capabilities mid-flow. Drive config tightens
// side-effect handling (mutating actions gate on per-(action, selector)
// consent), skips end-drive auto-synth so closing the session doesn't
// guess which capability was the primary goal, and lowers the
// re-persistence threshold so a session that touched many pages without
// persisting anything fires the gate.
//
// Lift cycles are opt-in: the agent calls `lift_observed_capability` with
// a slug that already lives on platform_logbook.observed_capabilities[],
// the FSM transitions drive → triage (or lift → triage on a subsequent
// capability), and the agent runs normal triage/lift to land a strategy.
// After save the agent stays in lift and can either declare another
// capability (re-entering triage) or call `end_drive` to close.

import type { Graph } from '../phases/types';

export const MAP_GRAPH: Graph = {
  name: 'map',
  entryPhase: 'drive',
  nodes: new Set(['drive', 'triage', 'lift']),
  transitions: [
    { from: 'drive', on: 'lift_observed_capability_invoked', to: 'triage' },
    { from: 'drive', on: 'end_drive_unresolved', to: { kind: 'terminal', status: 'closed' } },
    { from: 'drive', on: 'resolved_via_save', to: { kind: 'terminal', status: 'closed' } },
    { from: 'triage', on: 'plan_submitted', to: 'triage' },
    { from: 'triage', on: 'plan_handoff', to: 'lift' },
    { from: 'triage', on: 'surface_changed', to: 'triage' },
    { from: 'triage', on: 'end_drive_unresolved', to: { kind: 'terminal', status: 'closed' } },
    { from: 'lift', on: 'plan_submitted', to: 'triage' },
    { from: 'lift', on: 'surface_changed', to: 'triage' },
    { from: 'lift', on: 'lift_observed_capability_invoked', to: 'triage' },
    { from: 'lift', on: 'end_drive_unresolved', to: { kind: 'terminal', status: 'closed' } },
    { from: 'lift', on: 'resolved_via_save', to: { kind: 'terminal', status: 'closed' } },
  ],
  config: {
    gateMutatingActions: true,
    skipAutoSynth: true,
    inferObservedCapabilitiesAtClose: true,
    skipDeclarationGuard: true,
    // actions=5: a mapping session that touched 5+ pages without persisting any
    // findings fires the gate. reCalls=1 covers the rarer "did heavy RE while
    // mapping but left no breadcrumb" case (js_eval alone doesn't count).
    rePersistenceThreshold: { reCalls: 1, actions: 5 },
    obligationStyle: 'flush_reminder',
    startSessionHint:
      'Map mode: explore freely. mutating actions gate on consent (one ack per session). ' +
      'record_observed_capability flags candidates; when one is ready to save, ' +
      'lift_observed_capability({name, args}) opens triage + lift for that slug. ' +
      'Repeat for as many as you find; end_drive when done.',
  },
};
