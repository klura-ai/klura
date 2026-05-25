// Save-warning acker hook. Hijacks `notes.save_warnings_acked` reading
// when a harness registers an acker — same `runtime calls harness
// directly, LLM never sees the consent decision` pattern as
// `SaveConfirmationDecider` on the user_confirmation classifier.
//
// The cheating attack vector: LLM writes
// `notes.save_warnings_acked: [{kind, reason: "this is fine"}]` without
// ever consulting the user; the audit's `extractAcksFromNotes` reads it
// verbatim and lets the save through. Canned reasons compound because
// the LLM learns the field shape across runs.
//
// When a harness (e.g. `klura chat` CLI) registers an acker, the runtime:
//   1. After detectors emit ackable warnings, walks the warning list
//   2. Calls `acker.ack(warning, ctx)` for each — harness prompts the
//      user (via TTY, GUI, whatever) and returns the verdict
//   3. Uses the harness-attested verdict, IGNORING any agent-supplied
//      `notes.save_warnings_acked` for that kind
//   4. If acker returned `decision: 'reject'`, save fails with a
//      `user_rejected_save_warning:<kind>` error — the user said no
//
// LLM has no surface to fabricate consent on: the runtime never reads
// LLM-authored ack strings when the acker is registered. Symmetric with
// how `SaveConfirmationDecider` makes `userConfirmationClassifier.
// buildItems` return null when present (LLM never sees the classifier).

import type { Issue } from '../index';

export interface SaveWarningAckCtx {
  platform: string;
  capability: string;
  /** Strategy tier (`fetch` | `page-script` | `recorded-path`) — useful
   *  context for the user prompt the harness composes. */
  tier?: string;
}

export interface SaveWarningAck {
  /** `'approve'` lands the save with the warning acked; `'reject'`
   *  blocks the save with a `user_rejected_save_warning:<kind>` error. */
  decision: 'approve' | 'reject';
  /** Verbatim user reply (one sentence justification). Persisted on
   *  the saved strategy's `notes.save_warnings_acked[]` so future
   *  sessions / reviewers see what the user said. Required non-empty
   *  on approve; allowed empty on reject. */
  reason: string;
}

export interface SaveWarningAcker {
  /** Stable id — re-registering with the same name replaces the prior
   *  registration (idempotent). */
  name: string;
  /** Called once per emitted ackable warning. The harness composes a
   *  user-facing prompt (warning kind + message + hint), captures the
   *  user's reply, returns the verdict. Async so TTY / network /
   *  remote-viewer flows are natural. */
  ack(warning: Issue, ctx: SaveWarningAckCtx): Promise<SaveWarningAck>;
}

let _acker: SaveWarningAcker | null = null;

export function registerSaveWarningAcker(acker: SaveWarningAcker): void {
  _acker = acker;
}

export function unregisterSaveWarningAcker(name: string): void {
  if (_acker && _acker.name === name) _acker = null;
}

export function getRegisteredSaveWarningAcker(): SaveWarningAcker | null {
  return _acker;
}
