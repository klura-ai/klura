// Map graph — drive→terminal{closed}. Platform-mapping mode: agent walks
// the site to enrich the platform_map. Drive phase config tightens
// side-effect handling (mutating actions gate on per-(action, selector)
// consent), skips auto-synth at close, lowers the re-persistence threshold
// so a session that mapped without persisting fires the gate.

import type { Graph } from '../types';

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
    rePersistenceThreshold: { reCalls: 1, actions: 5 },
    obligationStyle: 'flush_reminder',
    // Map has no triage/lift to unlock saves — drive is the only phase, so
    // explicit `save_strategy` calls must be admissible in drive. Without
    // this the documented "call save_strategy for what you want to keep"
    // hint above is unreachable.
    extraDriveTools: new Set(['save_strategy']),
    startSessionHint:
      'Map mode: walk the platform; mutating actions require per-(action, selector) consent. ' +
      'Auto-synth is skipped at close — call `save_strategy` for what you want to keep, then `end_drive`.',
  },
};
