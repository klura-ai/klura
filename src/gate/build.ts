// Token-gated two-phase commit factory (Level 3): `buildTokenGate`. Runtime
// mints a token bound to a payload hash on the first call, rejects. Agent
// echoes token + answers on the second; framework validates hash + delegates
// structural check to the consumer's `validateAnswers`.
//
// Level-2 (acked-warning) save-time concerns are now consumed by the
// `Audit` class (runtime/src/audit/index.ts) — Detector specs with
// `ackReason: 'required'` give the same Level-2 semantics under one
// rejection envelope. Reach for `Audit` for save-time gates; reach for
// `buildTokenGate` directly for lifecycle gates outside that envelope
// (e.g. `trigger_reference_send` consent, `checkpoint_ack`).

import { hashGatePayload } from './hash';
import { issueToken, lookupToken, consumeToken } from './store';
import type { GateChecklist, GateRejection, GateResult } from './types';

export interface TokenGateSpec<TPayload, TAnswers> {
  // Stable id, used as the store namespace and in telemetry.
  kind: string;
  // First-call: build the checklist the agent sees in the rejection.
  buildChecklist: (payload: TPayload) => GateChecklist;
  // Second-call: validate the structural consistency of the agent's answers
  // against the payload. Return [] on success, a list of issue bullets on
  // failure.
  validateAnswers: (payload: TPayload, answers: TAnswers) => string[];
  // Optional: project the payload to just the fields whose change should
  // invalidate the token. Defaults to hashing the entire payload. When the
  // payload is a superset (e.g. full Strategy object) of what the gate
  // actually audits, supply this to scope the hash to the relevant subset
  // — otherwise sibling gates that mutate unrelated fields cascade-invalidate
  // this gate's token, forcing the agent to re-answer audits whose answers
  // are still valid.
  hashFields?: (payload: TPayload) => unknown;
}

export interface TokenGate<TPayload, TAnswers> {
  kind: string;
  process: (payload: TPayload, input: { token?: string; answers?: TAnswers }) => GateResult;
}

export function buildTokenGate<TPayload, TAnswers>(
  spec: TokenGateSpec<TPayload, TAnswers>,
): TokenGate<TPayload, TAnswers> {
  const computeHash = (payload: TPayload): string =>
    hashGatePayload(spec.hashFields ? spec.hashFields(payload) : payload);

  const issueForPayload = (payload: TPayload): GateRejection => {
    const checklist = spec.buildChecklist(payload);
    const payloadHash = computeHash(payload);
    const token = issueToken({ kind: spec.kind, payloadHash });
    return { reason: 'pending_audit', token, checklist };
  };

  return {
    kind: spec.kind,
    process(payload, input) {
      // First call — no token yet.
      if (!input.token) {
        return { status: 'pending', rejection: issueForPayload(payload) };
      }

      const stored = lookupToken(input.token);
      if (!stored || stored.kind !== spec.kind) {
        // Unknown or expired — re-issue against the current payload.
        const fresh = issueForPayload(payload);
        return {
          status: 'rejected',
          rejection: { ...fresh, reason: 'token_unknown_or_expired' },
        };
      }

      const currentHash = computeHash(payload);
      if (currentHash !== stored.payloadHash) {
        // Agent changed the payload between audit and commit. Invalidate
        // the old token and force re-classification against the new shape.
        consumeToken(input.token);
        const fresh = issueForPayload(payload);
        return {
          status: 'rejected',
          rejection: { ...fresh, reason: 'payload_changed_since_audit' },
        };
      }

      if (!input.answers) {
        // Token valid, hash matches, but no answers supplied — treat as
        // inconsistent (the agent must submit the classification).
        return {
          status: 'rejected',
          rejection: {
            reason: 'answers_inconsistent',
            token: input.token,
            checklist: spec.buildChecklist(payload),
            issues: ['audit answers missing — include them in the same call as the audit token'],
          },
        };
      }

      const issues = spec.validateAnswers(payload, input.answers);
      if (issues.length > 0) {
        return {
          status: 'rejected',
          rejection: {
            reason: 'answers_inconsistent',
            token: input.token,
            checklist: spec.buildChecklist(payload),
            issues,
          },
        };
      }

      consumeToken(input.token);
      return { status: 'committed' };
    },
  };
}
