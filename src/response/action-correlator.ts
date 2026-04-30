// Correlate a captured request with the most recent UI action that preceded
// it. Pure function — deterministic given (request timestamp, action history).
// No DOM access, no runtime state.
//
// Used by the param-observation pipeline: when an XHR fires with a short
// string param value, runtime looks backwards in the session's
// performActionHistory for a click/select within a small window and
// extracts the clicked element's human-visible text as the "label" side of
// the observation. Together the runtime ends up with `{value: "mexican",
// label: "Taco-tuesday? 🌮"}` tuples grounded in captured traffic, which
// the agent can later declare in `notes.params.category.observed_values`
// and the pre-save audit will verify.

import type { PerformActionRecord } from '../drivers/types/session';
import type { InterceptedRequest } from '../drivers/types/network';

export interface UiSource {
  kind: 'click' | 'select' | 'form';
  /** Human-visible label (a11y name, typed value, or selector fallback). */
  element_text: string;
  /** Unix-ms timestamps — useful for debugging / dedup. */
  action_at: number;
  request_at: number;
}

// How far back from the request timestamp we look for a causing action.
// Most sites dispatch the triggered XHR within a few hundred ms of the
// click; 3 s is loose enough for slow SPAs that batch state updates and
// tight enough to not sweep up coincidental prior clicks.
export const CORRELATION_WINDOW_MS = 3000;

function actionCounts(action: string): boolean {
  // Only UI-element interactions carry a human-visible label that makes
  // sense as an enum-value `label`. Navigate / key_press / type are
  // omitted: navigation comes from click resolution, key_press is focus-
  // relative, and type values are free-text caller input (not enums).
  return action === 'click' || action === 'select';
}

function extractElementText(record: PerformActionRecord): string {
  const locators = record.locators;
  if (locators && typeof locators === 'object') {
    const name = locators.name;
    if (typeof name === 'string' && name.trim().length > 0) return name.trim();
    const role = locators.role;
    if (typeof role === 'string' && role.trim().length > 0) {
      // A role alone isn't a great label but it's better than nothing.
      return role.trim();
    }
  }
  if (typeof record.value === 'string' && record.value.trim().length > 0) {
    return record.value.trim();
  }
  if (typeof record.selector === 'string' && record.selector.trim().length > 0) {
    return record.selector.trim();
  }
  return '';
}

function kindFor(action: string): UiSource['kind'] {
  if (action === 'select') return 'select';
  return 'click';
}

/**
 * Given a captured request + the session's action history, return the most
 * recent UI interaction that preceded the request within the correlation
 * window. Returns null when no correlation is possible (no request
 * timestamp, no preceding action in window, action has no extractable
 * text).
 */
export function correlateUiAction(
  request: InterceptedRequest,
  actionHistory: readonly PerformActionRecord[],
): UiSource | null {
  const requestAt = request.timestamp;
  if (typeof requestAt !== 'number') return null;
  if (actionHistory.length === 0) return null;

  let best: PerformActionRecord | null = null;
  for (const record of actionHistory) {
    if (!actionCounts(record.action)) continue;
    if (record.at >= requestAt) continue;
    if (requestAt - record.at > CORRELATION_WINDOW_MS) continue;
    if (best === null || record.at > best.at) best = record;
  }

  if (!best) return null;
  const elementText = extractElementText(best);
  if (elementText.length === 0) return null;

  return {
    kind: kindFor(best.action),
    element_text: elementText,
    action_at: best.at,
    request_at: requestAt,
  };
}
