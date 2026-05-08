// Pre-commit gate framework. Public surface; consumers should import from
// here, not from the sibling modules directly (except tests that need
// __resetStore).
//
// Save-time concerns compose into the `Audit` class
// (runtime/src/audit/index.ts) under one rejection envelope. Reach for
// `buildTokenGate` directly only for lifecycle gates outside that envelope
// (e.g. `trigger_reference_send` consent, `checkpoint_ack`,
// `interruption_ack`). See runtime/docs/gates.md.

export { hashGatePayload } from './hash';
export { buildTokenGate } from './build';
export type { TokenGate, TokenGateSpec } from './build';
export type { GateChecklist, GateRejection, GateResult } from './types';

// Save-warning detector functions live here for the audit to consume; the
// audit (runtime/src/audit/lift/save-strategy.ts) wraps each as a Detector spec.
export type { AuditAnswers, SaveAuditContext } from './save-audit';
export {
  detectSessionScopedIdExtraction,
  detectNameIdMismatch,
  detectEntityPinnedPrereqUrls,
  detectInlineMultiFetchPrereqs,
  detectPrereqBindKeyMismatch,
  detectLookupEmbeddedInPrereq,
  type SaveWarning,
} from './save-warnings';
