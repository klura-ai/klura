// abort_session — honest exit when a klura session shouldn't have started OR
// the user has explicitly said stop.
//
// Reason guidance is in the tool description, not enforced. Legitimate
// reasons: existing capability covers the task (use `execute()`), user
// explicitly said abort, site dead/blocked. NOT legitimate: "this is a
// one-off task" — that judgment isn't the agent's to make. klura is
// always-save-by-default; the LLM does not get to unilaterally classify work
// as "one-off, no save needed".
//
// Behavior: skips the close-time audit entirely (no
// capability_declaration_required, no re_persistence, no auto-synth, no
// LIFT handoff). Persists storage state so cookies survive — abort doesn't
// mean "burn the auth context"; it means "this session is the wrong vehicle".
// Logs an entry to platform_wide.abort_events for cross-session visibility.

import { pool } from '../runtime-state';
import * as skills from '../strategies/skills';
import { appendAbortEvent } from '../working-dir/logbook';
import { clearStartersForSession } from '../response/starter-cache';
import { clearForSession as clearSessionObservations } from '../response/session-observations';
import { clearObservedSessionTracking } from '../working-dir/logbook';
import { invokeCheckpointAndGate, type CheckpointEnvelope } from '../checkpoints';
import { TOOL_NAMES } from '../vocab';
import { didYouMeanSuffix } from '../utils/string-distance';
import type { ToolDef } from '../tools/types';

const REASON_MIN_LENGTH = 20;

/** Machine-actionable abort kinds. Cross-session readers (start_session's
 *  recent_aborts replay, autonomous loops) discriminate on this rather than
 *  parsing free-text `reason`. Backwards-compatible: optional, defaults to
 *  `'other'` on the wire so older callers and historical ledger entries
 *  without the field don't crash readers. */
export type AbortKind =
  | 'origin_blocked'
  | 'existing_capability_covers'
  | 'user_stop'
  | 'site_dead'
  | 'other';

export const ABORT_KIND_VALUES: readonly AbortKind[] = [
  'origin_blocked',
  'existing_capability_covers',
  'user_stop',
  'site_dead',
  'other',
];

/** Abort kinds that represent a genuine persistent block worth escalating to
 *  the human operator when they repeat. Only these count toward
 *  `must_escalate` (see computeAbortEscalation in start-session). The others
 *  are benign exits — `existing_capability_covers` is a successful "use the
 *  saved strategy" read, `user_stop` is intentional, `site_dead`/`other` are
 *  not "try the same approach harder" situations the escalation advisory
 *  addresses. */
export const ESCALATION_ABORT_KINDS: ReadonlySet<AbortKind> = new Set(['origin_blocked']);

export interface AbortSessionArgs {
  session_id: string;
  reason: string;
  /** Optional machine-actionable classification. Defaults to `'other'` when
   *  omitted. Future sessions on the same platform read this off
   *  `recent_aborts` to short-circuit known-blocked starts without
   *  re-parsing English. */
  kind?: AbortKind;
}

export interface AbortSessionResult {
  ok: true;
  /** False when the abort_session_consent checkpoint handed over to the
   *  user and the runtime is awaiting their ack. True when the abort
   *  actually landed (browser torn down, ledger entry written). */
  aborted: boolean;
  session_id: string;
  reason: string;
  kind: AbortKind;
  phase_at_abort: string;
  captured_actions_count: number;
  /** Present when the consent checkpoint handed over to the user — the
   *  agent must ack this checkpoint via `ack_checkpoint` for the abort
   *  to proceed. When the user replies no, the abort is cancelled and
   *  the agent should keep trying. */
  _checkpoint?: CheckpointEnvelope;
}

export async function abortSession(args: AbortSessionArgs): Promise<AbortSessionResult> {
  if (typeof args.session_id !== 'string' || args.session_id.length === 0) {
    throw new Error('invalid_args: abort_session requires session_id (non-empty string).');
  }
  if (typeof args.reason !== 'string' || args.reason.trim().length < REASON_MIN_LENGTH) {
    throw new Error(
      `invalid_args: abort_session requires \`reason\` (string, ≥${REASON_MIN_LENGTH} chars). ` +
        `Reason guidance: legitimate reasons are "existing capability <slug> covers this — using ` +
        `execute() instead", "user explicitly said stop", "site is blocked / dead end". NOT ` +
        `legitimate: "this is a one-off task" — that judgment isn't the agent's to make. klura is ` +
        `always for saving; if you'd reach for that reason, you're using klura wrong.`,
    );
  }
  let kind: AbortKind = 'other';
  if (args.kind !== undefined) {
    if (!ABORT_KIND_VALUES.includes(args.kind)) {
      const allowed = ABORT_KIND_VALUES.map((k) => '"' + k + '"').join(' | ');
      const suggestion = didYouMeanSuffix(args.kind, ABORT_KIND_VALUES as readonly string[]);
      throw new Error(
        `invalid_args: abort_session \`kind\` must be one of ${allowed} (got ${JSON.stringify(args.kind)})${suggestion}.`,
      );
    }
    kind = args.kind;
  }

  const session = pool.getSession(args.session_id);
  const reason = args.reason.trim();
  const phaseAtAbort = session.phase ?? 'drive';
  const capturedActionsCount = (session.performActionHistory ?? []).length;

  // Consent checkpoint: abort is a significant decision (klura's mission
  // is RE; bailing on first friction is the opposite). Surface to the
  // user / orchestrator for confirmation. Unattended runs that register
  // a `continue`-returning handler (test harnesses, autonomous loops
  // where the oracle has decided) get pre-consent + abort proceeds. The
  // user-facing prompt explicitly invites "no, keep trying" replies.
  const { envelope } = await invokeCheckpointAndGate('abort_session_consent', {
    session_id: args.session_id,
    capability: session.declaredCapabilities?.[0]?.capability,
    context: {
      kind: 'abort_session_consent',
      reason,
      abort_kind: kind,
      capturedActionsCount,
      phase_at_abort: phaseAtAbort,
    },
  });
  if (envelope) {
    // Handed over to user — stage the args on the session and return early
    // WITHOUT tearing down. `ack_checkpoint` reads `session.pendingAbort`
    // when the user replies yes and runs the teardown inline (mirror of
    // `pendingPostSaveValidation`). The agent must NOT re-call
    // `abort_session` after the ack — doing so would re-emit a fresh
    // consent token and loop forever. If the user replies no
    // (`{cancelled: true, reason}`), `ack_checkpoint` clears the staged
    // entry and tells the agent to keep RE-ing.
    session.pendingAbort = {
      reason,
      kind,
      phase_at_abort: phaseAtAbort,
      captured_actions_count: capturedActionsCount,
    };
    return {
      ok: true,
      aborted: false,
      session_id: args.session_id,
      reason,
      kind,
      phase_at_abort: phaseAtAbort,
      captured_actions_count: capturedActionsCount,
      _checkpoint: envelope,
    };
  }
  // resolution.status === 'continue' OR 'resolved' (auto-approved) — proceed inline.
  await performAbortTeardown(args.session_id, {
    reason,
    kind,
    phase_at_abort: phaseAtAbort,
    captured_actions_count: capturedActionsCount,
  });
  return {
    ok: true,
    aborted: true,
    session_id: args.session_id,
    reason,
    kind,
    phase_at_abort: phaseAtAbort,
    captured_actions_count: capturedActionsCount,
  };
}

/** Carry-payload for the deferred abort teardown. Matches the staging
 *  shape on `session.pendingAbort` — when consent is granted via
 *  `ack_checkpoint`, the handler reads the pending entry and feeds it
 *  back into this function. */
export interface PerformAbortTeardownArgs {
  reason: string;
  kind: AbortKind;
  phase_at_abort: string;
  captured_actions_count: number;
}

/** Run the actual abort teardown: persist storage state, log to the
 *  platform's abort_events ledger, tear down the browser, clear per-
 *  session maps. Called inline when consent is pre-granted, and from
 *  `ack_checkpoint` when consent is granted by ack. Idempotent enough —
 *  ledger appends are unconditional and not deduped (the same call shape
 *  twice in a row would write two ledger entries), so callers must not
 *  invoke this more than once per intended abort. */
export async function performAbortTeardown(
  sessionId: string,
  payload: PerformAbortTeardownArgs,
): Promise<void> {
  let session;
  try {
    session = pool.getSession(sessionId);
  } catch {
    // Session already torn down — nothing to do. Common when the agent's
    // prior tool call already closed the session (e.g. a parallel
    // end_drive landed first). Safe no-op.
    return;
  }
  const platform = session.platform;

  if (platform) {
    try {
      const statePath = skills.storageStatePath(platform, session.identity);
      await pool.driverFor(sessionId).saveStorageState(session, statePath);
    } catch {
      /* non-fatal — abort still proceeds */
    }
  }

  if (platform) {
    try {
      const hostFromCaptures = readFirstNavHost(session);
      appendAbortEvent(platform, {
        session_id: sessionId,
        reason: payload.reason,
        kind: payload.kind,
        ...(hostFromCaptures !== null ? { host: hostFromCaptures } : {}),
        captured_actions_count: payload.captured_actions_count,
        phase_at_abort: payload.phase_at_abort,
      });
    } catch {
      /* non-fatal — abort still proceeds */
    }
  }

  await pool.endDrive(sessionId);
  clearStartersForSession(sessionId);
  clearSessionObservations(sessionId);
  clearObservedSessionTracking(sessionId);
}

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.abortSession,
  description:
    `Honest exit when this session shouldn't have started OR the user has explicitly said stop. ` +
    `Skips the close-time audit (no capability_declaration_required, no re_persistence, no ` +
    `auto-synth, no LIFT handoff). Tears down the browser, clears the sticky obligation, persists ` +
    `storage state (cookies survive), logs to the platform's abort_events ledger for cross-session ` +
    `visibility. Admissible in any non-closed phase (drive/triage/lift).\n\n` +
    `\`reason\` is free-text, ≥${REASON_MIN_LENGTH} chars. Legitimate reasons:\n` +
    `  - "existing capability <slug> covers this — using execute() instead"\n` +
    `  - "user explicitly said stop"\n` +
    `  - "site is blocked / dead end"\n\n` +
    `NOT a legitimate reason: "this is a one-off task" — that judgment isn't yours to make. klura ` +
    `is always for saving; if you'd reach for that reason, you're using klura wrong. Either save ` +
    `the work or hand back to the user. The only LLM-side non-save exit is when the user said no ` +
    `(after triage); in every other case the work belongs on disk.`,
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      reason: {
        type: 'string',
        description:
          `Free-text reason (≥${REASON_MIN_LENGTH} chars). Logged to the platform's abort_events ` +
          `for cross-session visibility. NOT "this is a one-off task".`,
      },
      kind: {
        type: 'string',
        enum: [...ABORT_KIND_VALUES],
        description:
          `Machine-actionable classification (optional; defaults to "other"). Future sessions ` +
          `read this off recent_aborts to short-circuit known-blocked starts without re-parsing ` +
          `English. Pick the one that matches:\n` +
          `  - "origin_blocked": anti-bot wall / captcha / region gate refused the session\n` +
          `  - "existing_capability_covers": klura already has a strategy for this task\n` +
          `  - "user_stop": user explicitly said stop\n` +
          `  - "site_dead": site is permanently down or doesn't expose the surface anymore\n` +
          `  - "other": none of the above`,
      },
    },
    required: ['session_id', 'reason'],
  },
  handler: (args: any) =>
    abortSession({
      session_id: args.session_id,
      reason: args.reason,
      kind: args.kind,
    }),
};

/** Pull the host of the first captured navigation off the session.
 *  Used by abort_session to stamp `host` on the abort_event ledger so
 *  future start_session pre-nav checks match by host without parsing
 *  `reason`. Returns null on a session with no captures. */
function readFirstNavHost(session: {
  intercepted?: ReadonlyArray<{ url?: string; isNavigation?: boolean }>;
}): string | null {
  const intercepted = session.intercepted;
  if (!Array.isArray(intercepted) || intercepted.length === 0) return null;
  for (const req of intercepted) {
    if (req.isNavigation !== true) continue;
    if (typeof req.url !== 'string') continue;
    try {
      return new URL(req.url).host.toLowerCase();
    } catch {
      continue;
    }
  }
  // Fallback: any captured URL.
  for (const req of intercepted) {
    if (typeof req.url !== 'string') continue;
    try {
      return new URL(req.url).host.toLowerCase();
    } catch {
      continue;
    }
  }
  return null;
}
