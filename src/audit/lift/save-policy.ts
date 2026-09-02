// Save policy — the single entry every strategy producer routes through
// before a strategy lands on disk. Composes the existing `saveStrategyAudit`
// (one detector/classifier bank, one rejection vocabulary); the `origin`
// selects HOW the audit applies to the producer, never WHETHER it runs.
//
//   - `agent_explicit` — the full attended pipeline: Stage 0 shape checks,
//     Stage 1 detectors with ack semantics, Stage 2 token-gated classifiers.
//     Delegates to `saveStrategyAudit.process()` unchanged.
//   - unattended origins (`auto_synth_fetch`, `auto_synth_recorded`,
//     `graduation`, `programmatic`) — Stage 0 shape checks, then
//     `Audit.runUnattended`: detectors split issues into blocking (throw
//     `SavePolicyBlockedError`) and warnings per their `unattendedPolicy`;
//     no token is minted or consumed.
//
// A new save-time invariant therefore lands ONCE as a Detector row on
// `saveStrategyAudit` and protects every producer by construction — no
// producer carries hand-rolled detector copies.

import { SAVE_ORIGINS, type SaveOrigin } from '../../vocab';
import type { AuditInput, AuditRejection, AuditResult, Issue } from '../index';
import type { Strategy } from '../../strategies/skills';
import type { Session } from '../../drivers/types/session';
import type { ObservedSiblingItem } from '../../gate/save-audit';
import type { ParamObservation } from '../../response/session-observations';
import {
  saveStrategyAudit,
  persistWarningsOnRuntimeMeta,
  type SaveStrategyCtx,
} from './save-strategy';
import { trackRejectionAndMaybeBounce } from './save-rejection-bounce';

/** Session-derived facts a producer supplies so the audit's comparative
 *  detectors have ground truth to check against. Every field is optional —
 *  a producer passes what it has; detectors that need absent evidence
 *  no-op (e.g. `unobserved_url` skips when `observedUrls` is undefined,
 *  but treats an explicit empty list as "the session captured nothing"). */
export interface SaveEvidence {
  sessionId?: string;
  session?: Session | null;
  observedSiblings?: ObservedSiblingItem[];
  observedParamValues?: Record<string, ParamObservation[]>;
  capturedEndpointPaths?: Set<string>;
  observedUrls?: readonly string[];
  previousStrategy?: Strategy;
}

export interface SavePolicyInput {
  origin: SaveOrigin;
  platform: string;
  capability: string;
  strategy: Strategy;
  evidence?: SaveEvidence;
  /** `agent_explicit` only: token / answers / acks / dryRun passthrough to
   *  `saveStrategyAudit.process`. Ignored on unattended origins (no agent
   *  to hold a token or supply answers). */
  auditInput?: AuditInput;
}

/** Thrown when an unattended save trips a blocking detector. Producers map
 *  `issues[*].kind` to their own diagnostics (e.g. auto-synth's
 *  `sensitive_action_shape` outcome). */
export class SavePolicyBlockedError extends Error {
  readonly origin: SaveOrigin;
  readonly issues: readonly Issue[];
  constructor(origin: SaveOrigin, issues: readonly Issue[]) {
    const kinds = [...new Set(issues.map((i) => i.kind))].join(', ');
    super(
      `save_policy_blocked: ${issues.length} blocking issue${issues.length === 1 ? '' : 's'} ` +
        `[${kinds}] refused the ${origin} save:\n` +
        issues.map((i) => `  - [${i.kind}] ${i.message}`).join('\n'),
    );
    this.name = 'SavePolicyBlockedError';
    this.origin = origin;
    this.issues = issues;
  }
}

/** Per-origin application rules. Attended saves take the token flow; the
 *  unattended split below controls two axes:
 *
 *  `persistWarnings` — whether warn-tier issues decorate the saved
 *  artifact (`runtime_meta.save_warnings`). Auto-synth artifacts are read
 *  by the next attended session off `list_platform_skills`, so they carry
 *  advisories; graduation / programmatic saves have no advisory reader
 *  and stay undecorated.
 *
 *  `demoteBlockingToWarnings` — `programmatic` saves are the embedder's
 *  own code (CLI, host application, test harnesses) persisting a
 *  hand-constructed strategy, not LLM-emitted content; the audit's
 *  blocking invariants exist to validate what the LLM emits, so here they
 *  demote to warnings in the returned AuditResult instead of refusing the
 *  caller's deliberate write. Every LLM-authored save rides
 *  agent_explicit / auto_synth_* / graduation, where blocking applies. */
const UNATTENDED_RULES: Record<
  Exclude<SaveOrigin, typeof SAVE_ORIGINS.agentExplicit>,
  { persistWarnings: boolean; demoteBlockingToWarnings: boolean }
> = {
  [SAVE_ORIGINS.autoSynthFetch]: { persistWarnings: true, demoteBlockingToWarnings: false },
  [SAVE_ORIGINS.autoSynthRecorded]: { persistWarnings: true, demoteBlockingToWarnings: false },
  [SAVE_ORIGINS.graduation]: { persistWarnings: false, demoteBlockingToWarnings: false },
  [SAVE_ORIGINS.programmatic]: { persistWarnings: false, demoteBlockingToWarnings: true },
};

function ctxFromEvidence(
  platform: string,
  capability: string,
  evidence: SaveEvidence | undefined,
): SaveStrategyCtx {
  const ctx: SaveStrategyCtx = {
    platform,
    capability,
    session: evidence?.session ?? null,
    observedSiblings: evidence?.observedSiblings ?? [],
    observedParamValues: evidence?.observedParamValues ?? {},
    capturedEndpointPaths: evidence?.capturedEndpointPaths ?? new Set<string>(),
  };
  if (evidence?.sessionId !== undefined) ctx.sessionId = evidence.sessionId;
  // `observedUrls: undefined` and `observedUrls: []` mean different things
  // to the unobserved_url detector (absent evidence vs "captured nothing")
  // — forward exactly what the producer supplied.
  if (evidence?.observedUrls !== undefined) ctx.observedUrls = evidence.observedUrls;
  if (evidence?.previousStrategy !== undefined) ctx.previousStrategy = evidence.previousStrategy;
  return ctx;
}

/**
 * Evaluate the save policy for one strategy.
 *
 * `agent_explicit`: returns the `AuditResult` from
 * `saveStrategyAudit.process` — the caller renders rejections through
 * `rejectionToErrorMessage` exactly as before.
 *
 * Unattended origins: throws `invalid_strategy: ...` on shape issues,
 * throws `SavePolicyBlockedError` when a blocking detector fires, otherwise
 * persists warn-tier issues per the origin's rules and returns
 * `{status: 'committed', warnings}`.
 */
export function evaluateSavePolicy(input: SavePolicyInput): AuditResult {
  const { origin, platform, capability, strategy, evidence } = input;
  const ctx = ctxFromEvidence(platform, capability, evidence);

  if (origin === SAVE_ORIGINS.agentExplicit) {
    return saveStrategyAudit.process(strategy, ctx, input.auditInput ?? {});
  }

  saveStrategyAudit.runShapeChecks(strategy, ctx);
  const rules = UNATTENDED_RULES[origin];
  const { blocking, warnings } = saveStrategyAudit.runUnattended(strategy, ctx);
  if (blocking.length > 0 && !rules.demoteBlockingToWarnings) {
    throw new SavePolicyBlockedError(origin, blocking);
  }
  const allWarnings = blocking.length > 0 ? [...blocking, ...warnings] : warnings;
  if (allWarnings.length > 0 && rules.persistWarnings) {
    persistWarningsOnRuntimeMeta(strategy, allWarnings);
  }
  return { status: 'committed', warnings: allWarnings };
}

/** Input to the rejection-bounce policy. `renderedMessage` is the normal
 *  rejection envelope (`rejectionToErrorMessage` output) the caller was
 *  about to throw. */
export interface SaveRejectionBounceInput {
  origin: SaveOrigin;
  capability: string;
  strategy: Strategy;
  session: Session | null | undefined;
  rejection: AuditRejection;
  renderedMessage: string;
}

/**
 * Structural-dead-end bounce policy for SURFACED save rejections. Callers
 * that throw an audit rejection to an agent route the rendered message
 * through here; after the 3rd same-family rejection for one capability the
 * returned message is the `save_strategy_structural_dead_end` envelope
 * instead of the same audit prose again (see `./save-rejection-bounce.ts`).
 *
 * Interactive-origin-only by construction: the bounce is a loop guard on an
 * agent iterating rejections, so `agent_explicit` saves with a live session
 * are the only counted population. Unattended origins (auto-synth,
 * graduation, programmatic) and session-less saves pass through untouched.
 *
 * Deliberately NOT part of `evaluateSavePolicy`: one attempt may run several
 * policy evaluations (acker discovery, pre-probe check, post-probe canonical
 * pass), and internal rejections the agent never sees must not spend the
 * dead-end budget. Only the funnel that throws to the agent calls this — one
 * surfaced rejection, one count.
 */
export function applySaveRejectionBounce(input: SaveRejectionBounceInput): string {
  if (input.origin !== SAVE_ORIGINS.agentExplicit) return input.renderedMessage;
  const bounce = trackRejectionAndMaybeBounce(
    input.session ?? null,
    input.capability,
    input.strategy,
    input.rejection,
    input.renderedMessage,
  );
  return bounce ?? input.renderedMessage;
}
