// Save-time enum observation snapshot: merges the session's observed enum
// values (click→XHR pairs, URL-variance visits) into a strategy's
// `notes.params.<param>.observed_values` so the saved file carries the
// grounding evidence the discovery session actually captured.

import type { Strategy } from './skills';
import { escapeRegExp } from '../utils/regex';

/** Cap on how many observed values to snapshot per enum param at save
 *  time. Listing surfaces stay compact under the MCP budget; values
 *  beyond this count are still resolvable dynamically via
 *  `source: capability:list_<entity>`. */
const ENUM_SNAPSHOT_BUDGET = 24;

/** Walk the strategy's `notes.params`, find any enum-shaped param, and
 *  merge values observed by the session (click→XHR pairs, URL-variance
 *  visits) into `observed_values`. Idempotent: doesn't duplicate values
 *  the agent already declared. Skips when there are no session
 *  observations for the param's URL-key. */
export function snapshotEnumObservationsIntoSave(data: Strategy, sessionId: string): void {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return;
  let allObs: Record<string, unknown[]> | null = null;
  for (const [placeholder, info] of Object.entries(params)) {
    if (!info || typeof info !== 'object') continue;
    const i = info as { kind?: unknown; observed_values?: unknown };
    if (i.kind !== 'enum') continue;

    // The session observation index is keyed by URL-param name. Map the
    // strategy's placeholder to its URL-param via the endpoint:
    // `?<urlParam>={{<placeholder>}}`. Fall back to the placeholder name
    // when no mapping is found (the common case where placeholder ===
    // url-param).
    const urlParam = findUrlParamForPlaceholder(data, placeholder) ?? placeholder;
    if (allObs === null) {
      try {
        // Lazy import to avoid a top-level circular dep.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../response/session-observations') as {
          getAllParamObservations: (id: string) => Record<string, unknown[]>;
        };
        allObs = mod.getAllParamObservations(sessionId);
      } catch {
        allObs = {};
      }
    }
    const obs = allObs[urlParam];
    if (!Array.isArray(obs) || obs.length === 0) continue;

    const existing = Array.isArray(i.observed_values)
      ? (i.observed_values as Array<{ value?: unknown; label?: unknown }>)
      : [];
    const seen = new Set<string>();
    const merged: Array<{ value: string; label?: string }> = [];
    for (const entry of existing) {
      if (typeof entry !== 'object') continue;
      const value = entry.value;
      if (typeof value !== 'string' || seen.has(value)) continue;
      seen.add(value);
      const label = entry.label;
      merged.push(typeof label === 'string' ? { value, label } : { value });
    }
    for (const o of obs) {
      if (!o || typeof o !== 'object') continue;
      const v = (o as { value?: unknown }).value;
      if (typeof v !== 'string' || seen.has(v)) continue;
      seen.add(v);
      const labelRaw = (o as { source?: { label?: unknown } }).source?.label;
      const label = typeof labelRaw === 'string' ? labelRaw : undefined;
      merged.push(label ? { value: v, label } : { value: v });
      if (merged.length >= ENUM_SNAPSHOT_BUDGET) break;
    }
    if (merged.length === 0) continue;
    (info as { observed_values?: unknown }).observed_values = merged;
  }
}

/** Given a strategy's endpoint, find the URL-param key bound to a given
 *  `{{placeholder}}`. e.g. `/api/restaurants?category={{cuisine}}` →
 *  placeholder "cuisine" maps to url-param "category". Returns null when
 *  the placeholder isn't templated into a URL-param slot (e.g. body
 *  template, header). */
function findUrlParamForPlaceholder(data: Strategy, placeholder: string): string | null {
  const baseUrl = (data as { baseUrl?: unknown }).baseUrl;
  const endpoint = (data as { endpoint?: unknown }).endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return null;
  let urlString = endpoint;
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    try {
      urlString = new URL(endpoint, baseUrl).toString();
    } catch {
      // Fall through with raw endpoint
    }
  }
  // Match `?<key>={{placeholder}}` or `&<key>={{placeholder}}`.
  const re = new RegExp(`[?&]([^=&]+)=\\{\\{${escapeRegExp(placeholder)}\\}\\}`);
  const m = re.exec(urlString);
  return m ? (m[1] ?? null) : null;
}
