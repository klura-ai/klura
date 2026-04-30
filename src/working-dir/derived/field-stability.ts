// Cross-session field stability — walks session archives for a platform, groups
// captured HTTP requests by endpoint-key, runs the sufficiency classifier on
// each group, returns the per-endpoint verdict.
//
// Pure: reads session-archive JSON from disk, no side effects beyond writing
// the derived-signal file at derivedPath('field-stability').

import fs from 'fs';
import { dirname } from 'path';
import { isSessionArchive, type SessionArchive } from '../schema';
import { derivedPath, listSessions, sessionArchivePath } from '../layout';
import {
  type CaptureSample,
  classifyFieldStability,
  type EndpointFieldStability,
} from '../sufficiency';
export interface FieldStabilityReport {
  schema_version: 1;
  platform: string;
  computed_at: string;
  /** One entry per (capability, endpoint) pair seen in archives. */
  per_capability: Record<string, EndpointFieldStability[]>;
}

/**
 * Compute field stability across all session archives for a platform. Writes
 * the result to derived/field-stability.json. Returns the report.
 */
export function recomputeFieldStability(platform: string): FieldStabilityReport {
  const archives = loadAllSessionArchives(platform);
  const per_capability: Record<string, EndpointFieldStability[]> = {};

  // Group captured HTTP requests by capability + endpoint-key. Endpoint key =
  // host+path (no query). Same-capability fires across sessions are the sample
  // population.
  const buckets = new Map<string, Map<string, CaptureSample[]>>(); // capability → endpoint → samples
  for (const arch of archives) {
    const capability = arch.meta.capability;
    if (!capability) continue;
    const capMap = buckets.get(capability) ?? new Map<string, CaptureSample[]>();
    buckets.set(capability, capMap);
    for (const req of arch.http) {
      const endpointKey = endpointKeyFromUrl(req.url);
      if (!endpointKey) continue;
      const list = capMap.get(endpointKey) ?? [];
      capMap.set(endpointKey, list);
      list.push({ url: req.url, caller_args: arch.meta.args });
    }
  }

  for (const [capability, capMap] of buckets) {
    const entries: EndpointFieldStability[] = [];
    for (const [, samples] of capMap) {
      const classified = classifyFieldStability(samples);
      if (classified) entries.push(classified);
    }
    per_capability[capability] = entries;
  }

  const report: FieldStabilityReport = {
    schema_version: 1,
    platform,
    computed_at: new Date().toISOString(),
    per_capability,
  };
  const p = derivedPath(platform, 'field-stability');
  fs.mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, p);
  return report;
}

function loadAllSessionArchives(platform: string): SessionArchive[] {
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

function endpointKeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}
