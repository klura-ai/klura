// recoverOrphanedJournals — fold capture snapshots left behind by sessions that
// never reached end_drive (max_turns, agent-SDK crash, SIGTERM, hard kill).
//
// Event-driven, never a timer (principles.md "Listen to updates, don't poll").
// Two callers: the top of `start_session` (so the next session on a platform
// folds the prior dead session's captures before driving) and once at pool
// startup (the module-load hook the daemon requires). Both pass the set of
// live session ids so a still-writing session's journal is never folded
// mid-flight.

import { deleteJournal, journalAgeMs, listJournalSessionIds } from './capture-journal';
import { flushFromJournal } from './flush-from-journal';

/** Orphans this old are swept without folding — a journal whose platform is
 *  never re-mapped would otherwise linger forever. */
export const JOURNAL_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoverOptions {
  /** Session ids that are currently live. Their journals are skipped — they're
   *  still being written and will fold at their own end_drive. */
  activeSessionIds: Set<string>;
  /** When set, journals older than this are deleted without folding. */
  maxAgeMs?: number;
}

export function recoverOrphanedJournals(opts: RecoverOptions): void {
  const now = Date.now();
  for (const sessionId of listJournalSessionIds()) {
    if (opts.activeSessionIds.has(sessionId)) continue;
    if (opts.maxAgeMs !== undefined && journalAgeMs(sessionId, now) > opts.maxAgeMs) {
      deleteJournal(sessionId);
      continue;
    }
    try {
      flushFromJournal(sessionId, { inferCaps: true });
    } catch {
      /* one bad journal must not block the rest */
    }
  }
}
