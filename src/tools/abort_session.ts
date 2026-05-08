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
import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tool-types';

const REASON_MIN_LENGTH = 20;

export interface AbortSessionArgs {
  session_id: string;
  reason: string;
}

export interface AbortSessionResult {
  ok: true;
  aborted: true;
  session_id: string;
  reason: string;
  phase_at_abort: string;
  captured_actions_count: number;
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

  const session = pool.getSession(args.session_id);
  const platform = session.platform;
  const reason = args.reason.trim();
  const phaseAtAbort = session.phase ?? 'drive';
  const capturedActionsCount = (session.performActionHistory ?? []).length;

  // Persist storage state if the session is bound to a platform. Abort doesn't
  // mean "burn the auth context" — keep cookies so the next session can warm-
  // start against an existing capability without re-logging-in.
  if (platform) {
    try {
      const statePath = skills.storageStatePath(platform, session.identity);
      await pool.driverFor(args.session_id).saveStorageState(session, statePath);
    } catch {
      /* non-fatal — abort still proceeds */
    }
  }

  // Log to the platform-wide abort_events ledger for cross-session visibility.
  if (platform) {
    try {
      appendAbortEvent(platform, {
        session_id: args.session_id,
        reason,
        captured_actions_count: capturedActionsCount,
        phase_at_abort: phaseAtAbort,
      });
    } catch {
      /* non-fatal — abort still proceeds */
    }
  }

  // Tear down. Mirrors end_drive's terminal cleanup — same pool teardown,
  // same per-session map clears.
  await pool.endDrive(args.session_id);
  clearStartersForSession(args.session_id);
  clearSessionObservations(args.session_id);
  clearObservedSessionTracking(args.session_id);

  return {
    ok: true,
    aborted: true,
    session_id: args.session_id,
    reason,
    phase_at_abort: phaseAtAbort,
    captured_actions_count: capturedActionsCount,
  };
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
    },
    required: ['session_id', 'reason'],
  },
  handler: (args: any) => abortSession({ session_id: args.session_id, reason: args.reason }),
};
