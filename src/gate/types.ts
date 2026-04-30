// Shared types for the pre-commit gate framework. See runtime/docs/principles.md
// §pre-commit gates for the taxonomy (Level 1 self-attest boolean, Level 2
// acked warning with reason, Level 3 token-gated two-phase).
//
// Consumers should prefer the factory-returned `process()` surface over
// touching the store / hash directly — the factories bundle all of the
// token mechanics behind a single call.

export interface GateChecklist {
  // Human-readable prose the agent reads on the first rejection. Framework
  // wraps it with the token + how-to-respond boilerplate.
  prompt: string;
  // Structured questions. Consumers shape these per-gate (literals, tiers,
  // name segments, observed siblings, etc.) — the framework never inspects
  // the contents, only passes them through to the rejection envelope.
  items: Record<string, unknown>;
}

export interface GateRejection {
  // Stable machine-readable kind, e.g. "pre_save_audit_required" or
  // "pre_consent_required". Agents use this to decide which audit shape to
  // fill in.
  reason:
    | 'pending_audit'
    | 'token_unknown_or_expired'
    | 'payload_changed_since_audit'
    | 'answers_inconsistent';
  token: string;
  checklist: GateChecklist;
  // Issues is populated only when reason === 'answers_inconsistent'. One
  // bullet per structural mismatch between the agent's answer and the
  // payload.
  issues?: string[];
}

export type GateResult =
  | { status: 'pending'; rejection: GateRejection }
  | { status: 'rejected'; rejection: GateRejection }
  | { status: 'committed' };
