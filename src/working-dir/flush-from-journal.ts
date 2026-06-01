// flushFromJournal — fold a per-session capture snapshot into the platform
// logbook by reusing the same idempotent `ingestCaptureEvents` end_drive uses.
//
// Called only on the recovery path: a session that produced a journal snapshot
// but never reached end_drive. The clean-close path folds from live memory and
// then deletes the journal, so a journal that survives is by-construction an
// orphan to recover.
//
// Idempotent + crash-safe: the fold is a no-op on re-ingest (archive overwrite,
// url/edge/form/name upserts) and the journal is deleted ONLY after the logbook
// write commits — a crash between commit and delete just re-folds harmlessly
// (the one cost is a `sessions_total` +1 rollup drift per re-fold).

import { deleteJournal, readJournalSnapshot } from './capture-journal';
import { ingestCaptureEvents } from './writer';
import {
  inferObservedCapabilitiesFromGraph,
  type SessionFormObservation,
  type SessionNavigation,
} from './url-graph';
import { readObservedCapabilities, recordObservedCapability } from './logbook';
import type {
  CaptureEvent,
  DomFormObservedPayload,
  DomNavigationPayload,
  SessionMetaPayload,
} from './schema';

export interface FlushFromJournalOptions {
  /** When true, derive observed_capabilities from the snapshot's nav/form
   *  events (the surface-map inference end_drive runs from live arrays). The
   *  clean-close path already infers from memory, so it never recovers. */
  inferCaps: boolean;
}

/**
 * Fold the orphaned snapshot for `sessionId`. Returns true when a snapshot was
 * found and folded (and deleted), false when there was nothing to fold.
 */
export function flushFromJournal(sessionId: string, opts: FlushFromJournalOptions): boolean {
  const snap = readJournalSnapshot(sessionId);
  if (!snap) return false;

  const events = ensureSessionMeta(snap.events, snap);

  // The fold is the same writer end_drive calls; throws are a caller bug, so
  // let the orphan survive (do NOT delete) if it somehow fails — the next
  // recovery pass retries rather than silently dropping the captures.
  ingestCaptureEvents(snap.platform, snap.sessionId, events);

  if (opts.inferCaps) {
    inferObservedCapsFromEvents(snap.platform, events);
  }

  deleteJournal(sessionId);
  return true;
}

/** `ingestCaptureEvents` throws without a session_meta event. buildCaptureEvents
 *  always emits one, so this is belt-and-suspenders for a hand-built / truncated
 *  snapshot — without it a meta-less snapshot would never fold and never delete
 *  (an infinite re-fold loop on every recovery pass). */
function ensureSessionMeta(
  events: CaptureEvent[],
  snap: { sessionId: string; platform: string; startedAt: number },
): CaptureEvent[] {
  if (events.some((e) => e.kind === 'session_meta')) return events;
  const meta: SessionMetaPayload = {
    started_at: snap.startedAt,
    ended_at: Date.now(),
    outcome: 'no_save',
  };
  const metaEvent: CaptureEvent = {
    at: Date.now(),
    session_id: snap.sessionId,
    platform: snap.platform,
    kind: 'session_meta',
    payload: meta,
  };
  return [metaEvent, ...events];
}

/** Mirror of the end_drive surface-map inference (end-drive-orchestrator), run
 *  from the snapshot's nav/form events instead of live session arrays. Manual
 *  logbook entries win — the inference dedups by name. No session_id: these are
 *  runtime-derived breadcrumbs, not agent observations. */
function inferObservedCapsFromEvents(platform: string, events: CaptureEvent[]): void {
  try {
    const navigations: SessionNavigation[] = [];
    const forms: SessionFormObservation[] = [];
    for (const ev of events) {
      if (ev.kind === 'dom_navigation') {
        const p = ev.payload as DomNavigationPayload;
        const nav: SessionNavigation = { url: p.url, at: ev.at };
        if (p.title) nav.title = p.title;
        if (p.via) nav.via = p.via;
        navigations.push(nav);
      } else if (ev.kind === 'dom_form_observed') {
        const p = ev.payload as DomFormObservedPayload;
        forms.push({ url: p.url, action: p.action, method: p.method, fields: p.fields, at: ev.at });
      }
    }
    const existing = readObservedCapabilities(platform);
    const inferred = inferObservedCapabilitiesFromGraph(navigations, forms, existing);
    for (const entry of inferred) {
      try {
        recordObservedCapability(platform, {
          name: entry.name,
          evidence: entry.evidence,
          why_not_lifted: entry.why_not_lifted,
        });
      } catch {
        /* per-entry rejection (e.g. slug shape) shouldn't block the others */
      }
    }
  } catch {
    /* swallow — inference is best-effort */
  }
}
