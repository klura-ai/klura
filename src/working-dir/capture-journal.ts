// Capture journal — per-session durable snapshot of the capture stream.
//
// A discovery/map session's capture stream (HTTP, WS, navigations, forms,
// actions, RE tool trace) lives in driver buffers + session arrays that are
// only PULLED into the logbook at end_drive. If the session exits without
// end_drive (max_turns, agent-SDK crash, SIGTERM), that work is lost. The
// journal is the durability buffer: a single snapshot file per session,
// rewritten atomically at capture boundaries, folded into the logbook on
// recovery if the session never closed cleanly.
//
// Snapshot, not append-log: the snapshot is rebuilt from the (by-then enriched)
// buffers via the same reshape end_drive uses, so it has fidelity parity with a
// clean close — and an atomic tmp→rename overwrite means a crash mid-write
// leaves the prior complete snapshot intact (no torn lines, no cursor state).
//
// Pure I/O — zero dependency on runtime Session / pool / driver. Callers build
// the CaptureEvent[] and hand it here.

import fs from 'fs';
import path from 'path';
import { getKluraHome } from '../paths';
import type { CaptureEvent } from './schema';

export interface JournalSnapshot {
  v: 1;
  sessionId: string;
  platform: string;
  startedAt: number;
  events: CaptureEvent[];
}

/** Top-level under workdir, NOT per-platform: recovery enumerates journals
 *  without knowing which platform each belongs to (the platform is carried
 *  inside the snapshot). The `_` prefix sorts it away from platform dirs. */
export function journalsRoot(): string {
  return path.join(getKluraHome(), 'workdir', '_journals');
}

export function journalPath(sessionId: string): string {
  return path.join(journalsRoot(), `${sessionId}.json`);
}

/**
 * Atomically overwrite the session's snapshot. Best-effort: a write failure
 * must never break the tool call that triggered the checkpoint.
 */
export function writeJournalSnapshot(sessionId: string, snap: JournalSnapshot): void {
  try {
    fs.mkdirSync(journalsRoot(), { recursive: true });
    const p = journalPath(sessionId);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, p);
  } catch {
    /* best-effort durability — swallow */
  }
}

/** Read + parse the snapshot, or null when absent/unreadable/malformed. */
export function readJournalSnapshot(sessionId: string): JournalSnapshot | null {
  try {
    const raw = fs.readFileSync(journalPath(sessionId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p.v !== 1 || typeof p.platform !== 'string' || !Array.isArray(p.events)) return null;
    return parsed as JournalSnapshot;
  } catch {
    return null;
  }
}

export function deleteJournal(sessionId: string): void {
  try {
    fs.rmSync(journalPath(sessionId), { force: true });
  } catch {
    /* swallow */
  }
}

/** Session ids with a journal on disk. Empty when the dir doesn't exist yet. */
export function listJournalSessionIds(): string[] {
  try {
    return fs
      .readdirSync(journalsRoot())
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

/** Age of the journal file in ms, or Infinity when it doesn't exist. */
export function journalAgeMs(sessionId: string, now: number): number {
  try {
    return now - fs.statSync(journalPath(sessionId)).mtimeMs;
  } catch {
    return Infinity;
  }
}
