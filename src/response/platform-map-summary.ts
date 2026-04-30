// Platform-map summary: condensed teaser of a platform's logbook surface
// (observed_capabilities + url_graph + forms_seen) inlined on
// `start_session` so the agent sees prior cross-session knowledge at turn 0
// without an extra `get_platform_logbook` call.
//
// The full logbook is the source of truth — this summary is a pointer +
// teaser. When the logbook carries more detail than the summary reveals,
// `hint` names `get_platform_logbook` for the agent.

import {
  loadLogbook,
  readObservedCapabilities,
  readUrlGraph,
  readFormsSeen,
} from '../working-dir/logbook';

const OBSERVED_CAP_LIMIT = 5;
const URL_SAMPLE_LIMIT = 5;
const FORM_SAMPLE_LIMIT = 5;
const FORM_FIELD_NAME_LIMIT = 10;

export interface PlatformMapSummary {
  last_scanned: string;
  observed_capabilities: Array<{
    name: string;
    why_not_lifted: string;
    last_observed: string;
  }>;
  url_graph: {
    size: number;
    sample: string[];
  };
  forms: {
    size: number;
    sample: Array<{
      action: string;
      method: string;
      fields: string[];
    }>;
  };
  hint?: string;
}

/**
 * Build a compact platform-map summary from the on-disk logbook. Returns
 * `null` when no logbook exists or the logbook is fully empty (zero observed
 * capabilities, zero URL graph nodes, zero forms). Callers attach the result
 * to the `start_session` response under `platform_map`.
 *
 * Sort order on observed_capabilities: most-recently-observed first. When the
 * logbook carries more than `OBSERVED_CAP_LIMIT` observations, the summary
 * keeps the top N and sets `hint` to point at `get_platform_logbook`.
 */
export function buildPlatformMapSummary(platform: string): PlatformMapSummary | null {
  const observedAll = readObservedCapabilities(platform);
  const urlGraph = readUrlGraph(platform);
  const forms = readFormsSeen(platform);

  const urlNodes = urlGraph.nodes.length;
  const formCount = forms.length;
  if (observedAll.length === 0 && urlNodes === 0 && formCount === 0) {
    return null;
  }

  const sorted = [...observedAll].sort(
    (a, b) => Date.parse(b.last_observed_at) - Date.parse(a.last_observed_at),
  );
  const truncated = sorted.length > OBSERVED_CAP_LIMIT;
  const top = sorted.slice(0, OBSERVED_CAP_LIMIT).map((o) => ({
    name: o.name,
    why_not_lifted: o.why_not_lifted,
    last_observed: o.last_observed_at,
  }));

  // URL sample: most-recently-visited first, drop URLs that are already
  // covered by an observed_capability hypothesis or evidence.url field. The
  // sample's purpose is to surface candidate routes the agent hasn't reasoned
  // about yet.
  const observedUrls = new Set<string>();
  for (const o of sorted) {
    const ev = o.evidence as { url?: unknown; action?: unknown };
    if (typeof ev.url === 'string') observedUrls.add(ev.url);
    if (typeof ev.action === 'string') observedUrls.add(ev.action);
  }
  const urlSample = [...urlGraph.nodes]
    .sort((a, b) => Date.parse(b.last_visited) - Date.parse(a.last_visited))
    .filter((n) => !observedUrls.has(n.url))
    .slice(0, URL_SAMPLE_LIMIT)
    .map((n) => n.url);

  // Form sample: most-recently-seen first. Truncate field names per form so a
  // wide form doesn't blow the budget.
  const formSample = [...forms]
    .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
    .slice(0, FORM_SAMPLE_LIMIT)
    .map((f) => ({
      action: f.action,
      method: f.method,
      fields: f.fields.slice(0, FORM_FIELD_NAME_LIMIT).map((field) => field.name),
    }));

  // last_scanned: max(last_observed_at across observed_capabilities,
  // logbook.updated_at). Picks up url_graph + forms_seen freshness via
  // logbook.updated_at, since those collections don't carry their own
  // top-level timestamp.
  const logbook = loadLogbook(platform);
  let lastScanned = logbook.updated_at;
  for (const o of sorted) {
    if (o.last_observed_at > lastScanned) lastScanned = o.last_observed_at;
  }

  const summary: PlatformMapSummary = {
    last_scanned: lastScanned,
    observed_capabilities: top,
    url_graph: { size: urlNodes, sample: urlSample },
    forms: { size: formCount, sample: formSample },
  };
  const hintParts: string[] = [];
  if (truncated) {
    hintParts.push(
      `${sorted.length} observed_capabilities total; top ${OBSERVED_CAP_LIMIT} shown by recency.`,
    );
  }
  if (urlNodes > urlSample.length || formCount > formSample.length) {
    hintParts.push('Candidate routes and forms above.');
  }
  if (hintParts.length > 0) {
    hintParts.push('Full map: get_platform_logbook.');
    summary.hint = hintParts.join(' ');
  }
  return summary;
}
