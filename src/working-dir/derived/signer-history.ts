// Cross-session signer history — reads tool_trace from archives and tracks
// which JS source files + line anchors the agent has searched / read during
// signer-discovery across sessions. Surfaces "we've found a signer at
// <file:line> in 3 of 5 sessions" kind of signal.
//
// Generic: we don't know what names are "signer-like" in runtime
// (platform-agnostic); we just surface read/search anchors that recur. The
// triage step can reason over these as "stable pointers" when the same anchor
// appears across N sessions.

import fs from 'fs';
import path from 'path';
import { isSessionArchive, type SessionArchive } from '../schema';
import { derivedPath, listSessions, sessionArchivePath } from '../layout';

interface SignerAnchor {
  url: string;
  line?: number;
  /** Number of sessions that searched / read this anchor. */
  sessions: number;
  first_seen: string;
  last_seen: string;
}
export interface SignerHistoryReport {
  schema_version: 1;
  platform: string;
  computed_at: string;
  /** Anchors sorted by session count desc; top entries are the most-
   *  revisited signer candidates across the platform's history. */
  anchors: SignerAnchor[];
}

export function recomputeSignerHistory(platform: string): SignerHistoryReport {
  const archives = loadArchives(platform);
  archives.sort((a, b) => a.meta.ended_at - b.meta.ended_at);
  const anchors = new Map<
    string,
    { url: string; line?: number; sessions: Set<string>; first_seen: string; last_seen: string }
  >();
  for (const arch of archives) {
    const when = new Date(arch.meta.ended_at).toISOString();
    for (const t of arch.tool_trace) {
      if (
        t.tool !== 'read_js_function' &&
        t.tool !== 'search_js_source' &&
        t.tool !== 'get_js_source'
      ) {
        continue;
      }
      const detail = t.detail as { url?: unknown; line?: unknown } | undefined;
      if (!detail || typeof detail.url !== 'string') continue;
      const line = typeof detail.line === 'number' ? detail.line : undefined;
      const key = `${detail.url}#${line ?? 'na'}`;
      let a = anchors.get(key);
      if (!a) {
        a = {
          url: detail.url,
          line,
          sessions: new Set(),
          first_seen: when,
          last_seen: when,
        };
        anchors.set(key, a);
      }
      a.sessions.add(arch.session_id);
      a.last_seen = when;
    }
  }

  const report: SignerHistoryReport = {
    schema_version: 1,
    platform,
    computed_at: new Date().toISOString(),
    anchors: [...anchors.values()]
      .map((a) => ({
        url: a.url,
        line: a.line,
        sessions: a.sessions.size,
        first_seen: a.first_seen,
        last_seen: a.last_seen,
      }))
      .sort((x, y) => y.sessions - x.sessions),
  };
  const p = derivedPath(platform, 'signer-history');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, p);
  return report;
}

function loadArchives(platform: string): SessionArchive[] {
  const ids = listSessions(platform);
  const out: SessionArchive[] = [];
  for (const id of ids) {
    try {
      const raw = fs.readFileSync(sessionArchivePath(platform, id, 'archive'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isSessionArchive(parsed)) out.push(parsed);
    } catch {
      /* skip */
    }
  }
  return out;
}
