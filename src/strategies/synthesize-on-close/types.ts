// Shared types for the synthesize-on-close passes.

import type { StrategyTier } from '../../vocab';

export interface AutoSynthResult {
  capability: string;
  tier: StrategyTier;
  path: string;
  reason: string;
}

export interface SynthDiagnosticEntry {
  pass: 'synth_fetch' | 'synth_recorded' | 'synth_dispatch';
  capability?: string;
  phase: 'start' | 'skip' | 'save';
  outcome: string;
  detail?: Record<string, unknown>;
}

export type SaveMarker = {
  capability: string;
  at: number;
  tier: string;
  args?: Record<string, string>;
};
