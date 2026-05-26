// Triage → observed_capabilities inference: for each triaged surface that
// no saved strategy covers, yield a `record_observed_capability`-shaped
// input. Called from end_drive after the audit passes. Extracted from
// end-drive-orchestrator.ts to keep that file under the line-count budget.

import * as skills from '../../strategies/skills';
import { loadLogbook } from '../../working-dir/logbook';
import type { ObservedCapabilityInput } from '../../working-dir/logbook';

/** For each capability on the platform, find triaged surfaces whose URLs
 *  aren't covered by the saved strategy's endpoint or prereq URLs, and
 *  yield observed_capability inputs naming them. Best-effort: any
 *  malformed plan or load failure yields zero entries for that capability
 *  rather than blocking close. */
export function inferObservedCapabilitiesFromTriage(
  platform: string,
  sessionId: string,
): ObservedCapabilityInput[] {
  let logbook: ReturnType<typeof loadLogbook>;
  try {
    logbook = loadLogbook(platform);
  } catch {
    return [];
  }
  const out: ObservedCapabilityInput[] = [];
  const taken = new Set<string>();
  for (const cap of logbook.observed_capabilities) {
    if (typeof cap.name === 'string') taken.add(cap.name);
  }
  for (const [capabilityName, entry] of Object.entries(logbook.per_capability)) {
    const plansBySurface = entry.triage_plans_by_surface;
    if (!plansBySurface || typeof plansBySurface !== 'object') continue;
    let savedStrategyUrls: Set<string>;
    try {
      const strategies = skills.loadStrategies(platform, capabilityName);
      savedStrategyUrls = collectStrategyUrls(strategies);
    } catch {
      continue;
    }
    for (const [surfaceLabel, plan] of Object.entries(plansBySurface)) {
      if (typeof plan !== 'object') continue;
      const surfaceUrls: string[] = [];
      const obs = (plan as { observed_at_urls?: unknown }).observed_at_urls;
      if (Array.isArray(obs)) for (const u of obs) if (typeof u === 'string') surfaceUrls.push(u);
      const ds = (plan as { defense_surface?: unknown }).defense_surface;
      if (ds && typeof ds === 'object') {
        const reqs = (ds as { request_patterns?: unknown }).request_patterns;
        if (Array.isArray(reqs)) {
          for (const r of reqs) {
            if (typeof r !== 'string') continue;
            const tokens = r.trim().split(/\s+/);
            for (const t of tokens) {
              if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('/')) {
                surfaceUrls.push(t);
              }
            }
          }
        }
      }
      if (surfaceUrls.length === 0) continue;
      const covered = surfaceUrls.some((u) => urlMatchesAny(u, savedStrategyUrls));
      if (covered) continue;
      const name = surfaceLabel
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_');
      if (!name || taken.has(name)) continue;
      taken.add(name);
      out.push({
        name,
        evidence: { source: 'triage_inference', observed_at_urls: surfaceUrls },
        why_not_lifted: 'other',
        session_id: sessionId,
      });
    }
  }
  return out;
}

/** Collect every URL the strategies for a capability touch — main endpoint
 *  plus any prereq URL. */
function collectStrategyUrls(strategies: Array<Record<string, unknown>>): Set<string> {
  const urls = new Set<string>();
  for (const strat of strategies) {
    const baseUrl = strat.baseUrl;
    const endpoint = strat.endpoint;
    if (typeof baseUrl === 'string' && typeof endpoint === 'string') {
      try {
        urls.add(new URL(endpoint, baseUrl).toString());
      } catch {
        urls.add(`${baseUrl}${endpoint}`);
      }
    } else if (typeof endpoint === 'string') {
      urls.add(endpoint);
    }
    const prereqs = strat.prerequisites;
    if (Array.isArray(prereqs)) {
      for (const p of prereqs) {
        if (!p || typeof p !== 'object') continue;
        const u = (p as { url?: unknown }).url;
        if (typeof u === 'string') urls.add(u);
      }
    }
  }
  return urls;
}

function urlMatchesAny(candidate: string, coveredUrls: Set<string>): boolean {
  const candidatePath = pathnameOf(candidate);
  if (!candidatePath) return false;
  for (const url of coveredUrls) {
    const coveredPath = pathnameOf(url);
    if (!coveredPath) continue;
    if (candidatePath === coveredPath) return true;
  }
  return false;
}

function pathnameOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    let p = u.pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  } catch {
    if (!rawUrl.startsWith('/')) return null;
    const q = rawUrl.indexOf('?');
    let p = q === -1 ? rawUrl : rawUrl.slice(0, q);
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }
}
