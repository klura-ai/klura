// ingestCaptureEvents — the only entry point into the working dir.
//
// Accepts a CaptureEvent[] stream (kind-discriminated). Partitions into session
// archive files + bundle archive + logbook update. Idempotent on re-ingest of
// the same events (content-addressable bundle writes dedupe; session archive
// overwrites are fine — same session, same data).
//
// Zero dependency on runtime Session / pool / MCP. The callable surface for the
// agent-driven bridge lives in runtime/src/index.ts: flushSessionToWorkingDir;
// that adapter does the reshape and hands a CaptureEvent[] here.

import fs from 'fs';
import {
  type BundleSeenPayload,
  type CaptureEvent,
  type DomFormObservedPayload,
  type DomNavigationPayload,
  type HttpRequestPayload,
  type LiftAttemptPayload,
  type PerformActionPayload,
  type SessionArchive,
  type SessionMetaPayload,
  type StorageStatePayload,
  type ToolCallPayload,
  type WsFramePayload,
} from './schema';
import { ensurePlatformDirs, ensureSessionDir, sessionArchivePath } from './layout';
import { ensureCapabilityEntry, loadLogbook, refreshRecencyStats, writeLogbook } from './logbook';
import { archiveBundle } from './bundle-archive';
import {
  foldFormsIntoLogbook,
  foldNavigationsIntoUrlGraph,
  type SessionFormObservation,
  type SessionNavigation,
} from './url-graph';

/**
 * Ingest a batch of capture events for one session on one platform. Writes the
 * session archive + bundle archive + updates the platform logbook. Events for
 * multiple sessions / platforms must be grouped before calling (one ingest per
 * session).
 *
 * Throws on any event whose payload shape doesn't match its kind — that's a
 * caller bug, not a data-drift case.
 */
export function ingestCaptureEvents(
  platform: string,
  sessionId: string,
  events: CaptureEvent[],
): void {
  ensurePlatformDirs(platform);
  ensureSessionDir(platform, sessionId);

  // Partition the stream by kind. Each bucket becomes a slice of the session
  // archive or drives a side-effect (bundle write, logbook bump).
  let meta: SessionMetaPayload | null = null;
  let storageState: unknown = null;
  const http: HttpRequestPayload[] = [];
  const ws: WsFramePayload[] = [];
  const actions: PerformActionPayload[] = [];
  const toolTrace: ToolCallPayload[] = [];
  const bundleShas: Array<{ url: string; sha256: string; size?: number }> = [];
  const liftAttempts: Array<{ capability: string; payload: LiftAttemptPayload; at: number }> = [];
  const navigations: SessionNavigation[] = [];
  const formObservations: SessionFormObservation[] = [];

  for (const ev of events) {
    if (ev.session_id !== sessionId || ev.platform !== platform) {
      throw new Error(
        `ingestCaptureEvents: event session_id/platform mismatch (got ${ev.session_id}/${ev.platform}, expected ${sessionId}/${platform})`,
      );
    }
    switch (ev.kind) {
      case 'session_meta':
        meta = ev.payload as SessionMetaPayload;
        break;
      case 'http_request':
        http.push(ev.payload as HttpRequestPayload);
        break;
      case 'ws_frame':
        ws.push(ev.payload as WsFramePayload);
        break;
      case 'perform_action':
        actions.push(ev.payload as PerformActionPayload);
        break;
      case 'tool_call':
        toolTrace.push(ev.payload as ToolCallPayload);
        break;
      case 'bundle_seen': {
        const p = ev.payload as BundleSeenPayload;
        bundleShas.push({ url: p.url, sha256: p.sha256, size: p.size });
        if (p.bytes) archiveBundle(platform, p.sha256, p.bytes);
        break;
      }
      case 'storage_state':
        storageState = (ev.payload as StorageStatePayload).storage_state;
        break;
      case 'dom_navigation': {
        const p = ev.payload as DomNavigationPayload;
        const entry: SessionNavigation = { url: p.url, at: ev.at };
        if (p.title) entry.title = p.title;
        if (p.via) entry.via = p.via;
        navigations.push(entry);
        break;
      }
      case 'dom_form_observed': {
        const p = ev.payload as DomFormObservedPayload;
        formObservations.push({
          url: p.url,
          action: p.action,
          method: p.method,
          fields: p.fields,
          at: ev.at,
        });
        break;
      }
      case 'lift_attempt':
        if (!ev.capability) {
          throw new Error('ingestCaptureEvents: lift_attempt event requires a capability');
        }
        liftAttempts.push({
          capability: ev.capability,
          payload: ev.payload as LiftAttemptPayload,
          at: ev.at,
        });
        break;
      default:
        /* Unknown kind: skip. */
        break;
    }
  }

  if (!meta) {
    throw new Error(
      `ingestCaptureEvents: stream must include one session_meta event (session ${sessionId})`,
    );
  }

  // Write storage-state as its own file (keeps it out of the main archive for
  // trivial grepping + a predictable path for downstream consumers).
  let storageFile: string | null = null;
  if (storageState) {
    const p = sessionArchivePath(platform, sessionId, 'storage_state');
    fs.writeFileSync(p, JSON.stringify(storageState, null, 2));
    storageFile = 'storage-state.json';
  }

  const archive: SessionArchive = {
    schema_version: 1,
    session_id: sessionId,
    platform,
    meta,
    http,
    ws,
    actions,
    tool_trace: toolTrace,
    bundle_shas: bundleShas,
    storage_state_file: storageFile,
  };

  const archivePath = sessionArchivePath(platform, sessionId, 'archive');
  const tmp = `${archivePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(archive, null, 2));
  fs.renameSync(tmp, archivePath);

  // Update logbook.
  const logbook = loadLogbook(platform);
  logbook.sessions_total += 1;
  if (meta.capability) {
    const entry = ensureCapabilityEntry(logbook, meta.capability);
    entry.sessions_contributed += 1;
    entry.last_session_at = new Date(meta.ended_at).toISOString();
    entry.last_session_id = sessionId;
    refreshRecencyStats(entry, logbook.sessions_total);
  }
  // Lift attempts append in order they were emitted.
  for (const la of liftAttempts) {
    const entry = ensureCapabilityEntry(logbook, la.capability);
    entry.lift_attempts.push({
      session_id: sessionId,
      attempted_at: new Date(la.at).toISOString(),
      outcome: la.payload.outcome,
      rounds_spent: la.payload.rounds_spent,
      notes: la.payload.notes,
    });
    refreshRecencyStats(entry, logbook.sessions_total);
  }
  // Fold navigation + form observations into the platform-level surface map.
  // Both are idempotent on re-ingest of the same events.
  foldNavigationsIntoUrlGraph(logbook, sessionId, navigations);
  foldFormsIntoLogbook(logbook, formObservations);
  writeLogbook(logbook);
}
