// Map graph — drive→terminal{closed}. Platform-mapping mode: agent walks
// the site to enrich the platform_map. Drive phase config tightens
// side-effect handling (mutating actions gate on per-(action, selector)
// consent), skips auto-synth at close, lowers the re-persistence threshold
// so a session that mapped without persisting fires the gate.

import type { Graph } from '../phases/types';

export const MAP_GRAPH: Graph = {
  name: 'map',
  entryPhase: 'drive',
  nodes: new Set(['drive']),
  transitions: [
    { from: 'drive', on: 'resolved_via_save', to: { kind: 'terminal', status: 'closed' } },
    { from: 'drive', on: 'end_drive_unresolved', to: { kind: 'terminal', status: 'closed' } },
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
      'Map mode: observation-only. mutating actions need one ack per session. Persist findings via ' +
      'record_observed_capability / save_verified_expression / add_discovery_note / add_resume_pointer; ' +
      'follow up with discover({capability}) to lift via warm-start.',
  },
};
