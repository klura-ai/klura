// Cross-session bundle history — tracks URL → SHA mapping over time. When the
// same bundle URL shows up with a different SHA across sessions, emit a drift
// event (the site shipped a new minified bundle; existing signer-source-line
// pointers may no longer resolve).

import fs from 'fs';
import path from 'path';
import { isSessionArchive, type SessionArchive } from '../schema';
import { derivedPath, listSessions, sessionArchivePath } from '../layout';
export interface BundleHistoryReport {
  schema_version: 1;
  platform: string;
  computed_at: string;
  /** url → ordered history of SHAs seen, with first/last timestamps. */
  per_url: Record<
    string,
    Array<{
      sha256: string;
      first_seen_session: string;
      last_seen_session: string;
      n_sessions: number;
    }>
  >;
  /** Events flagged when a url's SHA changed (index > 0 in per_url[url]). */
  drift_events: Array<{
    at: string;
    url: string;
    prior_sha: string;
    new_sha: string;
  }>;
}

export function recomputeBundleHistory(platform: string): BundleHistoryReport {
  const archives = loadArchives(platform);
  const urlShaOrder = new Map<
    string,
    Array<{ sha256: string; first_seen: string; last_seen: string; sessions: Set<string> }>
  >();

  // Walk archives in chronological order (by ended_at).
  archives.sort((a, b) => a.meta.ended_at - b.meta.ended_at);
  for (const arch of archives) {
    const when = new Date(arch.meta.ended_at).toISOString();
    for (const b of arch.bundle_shas) {
      let list = urlShaOrder.get(b.url);
      if (!list) {
        list = [];
        urlShaOrder.set(b.url, list);
      }
      const last = list[list.length - 1];
      if (last && last.sha256 === b.sha256) {
        last.last_seen = when;
        last.sessions.add(arch.session_id);
      } else {
        list.push({
          sha256: b.sha256,
          first_seen: when,
          last_seen: when,
          sessions: new Set([arch.session_id]),
        });
      }
    }
  }

  const per_url: BundleHistoryReport['per_url'] = {};
  const drift_events: BundleHistoryReport['drift_events'] = [];
  for (const [url, list] of urlShaOrder) {
    per_url[url] = list.map((e) => ({
      sha256: e.sha256,
      first_seen_session: e.first_seen,
      last_seen_session: e.last_seen,
      n_sessions: e.sessions.size,
    }));
    for (let i = 1; i < list.length; i++) {
      const cur = list[i];
      const prev = list[i - 1];
      if (!cur || !prev) continue;
      drift_events.push({
        at: cur.first_seen,
        url,
        prior_sha: prev.sha256,
        new_sha: cur.sha256,
      });
    }
  }

  const report: BundleHistoryReport = {
    schema_version: 1,
    platform,
    computed_at: new Date().toISOString(),
    per_url,
    drift_events,
  };
  const p = derivedPath(platform, 'bundle-history');
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
