// Provider wiring for validate.* helpers. Kept isolated so the runtime's
// index.ts can wire implementations at startup without importing the whole
// validate module (avoids cycles).
import type { TryGeneratorStats } from '../try-generator-stats';

// Try-generator stats provider
export type TryGeneratorStatsProvider = (sessionId: string) => TryGeneratorStats | null;
let tryGeneratorStatsProvider: TryGeneratorStatsProvider | null = null;
export function setTryGeneratorStatsProvider(p: TryGeneratorStatsProvider | null): void {
  tryGeneratorStatsProvider = p;
}
export function getTryGeneratorStatsForSession(sessionId: string): TryGeneratorStats | null {
  if (!tryGeneratorStatsProvider) return null;
  return tryGeneratorStatsProvider(sessionId);
}

// Declared args provider
export type DeclaredArgsProvider = (sessionId: string) => Record<string, string> | null;
let declaredArgsProvider: DeclaredArgsProvider | null = null;
export function setDeclaredArgsProvider(p: DeclaredArgsProvider | null): void {
  declaredArgsProvider = p;
}
export function getDeclaredArgsProvider(): DeclaredArgsProvider | null {
  return declaredArgsProvider;
}

// Captured-requests provider — feeds the save-time detectors that cross-check
// a strategy's template shape against what the browser actually observed on
// the wire. Shape-kept `unknown` here to avoid pulling the driver-interface
// type into the validate module; consumers cast to
// `InterceptedRequest[]` at their boundary.
export type CapturedRequestsProvider = (sessionId: string) => unknown[] | null;
let capturedRequestsProvider: CapturedRequestsProvider | null = null;
export function setCapturedRequestsProvider(p: CapturedRequestsProvider | null): void {
  capturedRequestsProvider = p;
}
export function getCapturedRequestsProvider(): CapturedRequestsProvider | null {
  return capturedRequestsProvider;
}
