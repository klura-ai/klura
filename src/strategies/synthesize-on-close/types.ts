// Shared types for the synthesize-on-close passes.

export interface AutoSynthResult {
  capability: string;
  tier: 'page-script' | 'fetch' | 'recorded-path';
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
