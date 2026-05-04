// URL normalization + graph/form accretion helpers for the platform logbook.
//
// The normalization rule strips session-ish query parameters (tokens, uuids,
// hex ids, etc.) and reorders the remaining keys so different visits to
// structurally-identical URLs fold onto the same graph node. Filter heuristics
// mirror the opaque-id shapes enumerated in
// runtime/src/strategies/validate/constants.ts — same failure class (values
// produced by the app, not typed by the caller), different consumer (graph
// dedup vs. strategy param validation).

import type { ObservedPlatformCapability, PlatformLogbook } from './schema';

/**
 * Parameter names that almost always carry session / auth / csrf / nonce
 * context — stripped regardless of value.
 */
const SESSION_ISH_PARAM_NAMES = new Set<string>([
  'token',
  'sid',
  'sess',
  'session',
  'auth',
  'csrf',
  'nonce',
  'state',
  't',
  'ts',
  'timestamp',
]);

/**
 * Value-shape patterns that look like opaque server-produced IDs. Any param
 * whose value matches one of these is stripped. Kept local (and narrower than
 * OPAQUE_EXAMPLE_PATTERNS) so url-graph doesn't import validator internals.
 */
const SESSION_ISH_VALUE_PATTERNS: RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{12,}$/i, // long hex id (≥12)
  /^[A-Za-z0-9_-]{24,}$/, // url-safe token / jwt chunk (≥24)
  /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
];

function looksSessionIsh(name: string, value: string): boolean {
  if (SESSION_ISH_PARAM_NAMES.has(name.toLowerCase())) return true;
  for (const re of SESSION_ISH_VALUE_PATTERNS) {
    if (re.test(value)) return true;
  }
  return false;
}

/**
 * Normalize a URL for graph / form dedup.
 *
 * - Lowercase scheme + host; path case preserved.
 * - Strip trailing `/` except at the root.
 * - Drop session-ish query params (by name or value shape).
 * - Order remaining params alphabetically.
 *
 * Invalid inputs are returned verbatim — the graph stores whatever string the
 * capture emitted; callers shouldn't crash because of a malformed URL.
 */
export function normalizeUrlForGraph(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.host.toLowerCase();

  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  const kept: Array<[string, string]> = [];
  for (const [k, v] of parsed.searchParams) {
    if (looksSessionIsh(k, v)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]));

  const search = kept.length
    ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  return `${scheme}//${host}${pathname}${search}`;
}

// ---------------------------------------------------------------------------
// Graph accretion helpers.
// ---------------------------------------------------------------------------

export interface SessionNavigation {
  url: string;
  title?: string;
  at: number;
  /** Transition tag for the edge leading into this URL. */
  via?: 'nav' | 'click' | 'submit' | 'pushState' | 'replaceState' | 'popstate' | 'hashchange';
}

export interface SessionFormObservation {
  url: string;
  action: string;
  method: string;
  fields: Array<{ name: string; type: string; required?: boolean }>;
  at: number;
}

/**
 * Fold one session's navigation stream into the logbook's url_graph. Mutates
 * the logbook. `session_count` bumps once per (url, session) pair.
 */
export function foldNavigationsIntoUrlGraph(
  logbook: PlatformLogbook,
  _sessionId: string,
  navigations: SessionNavigation[],
): void {
  const graph = logbook.url_graph;

  const seenInSession = new Set<string>();
  let prevNormalized: string | null = null;
  let prevVia: SessionNavigation['via'] | undefined;

  for (const nav of navigations) {
    const normalized = normalizeUrlForGraph(nav.url);
    const iso = new Date(nav.at).toISOString();

    let node = graph.nodes.find((n) => n.url === normalized);
    if (!node) {
      node = {
        url: normalized,
        first_visited: iso,
        last_visited: iso,
        session_count: 0,
      };
      if (nav.title) node.title = nav.title;
      graph.nodes.push(node);
    } else {
      if (iso > node.last_visited) node.last_visited = iso;
      if (iso < node.first_visited) node.first_visited = iso;
      if (nav.title && !node.title) node.title = nav.title;
    }
    if (!seenInSession.has(normalized)) {
      node.session_count += 1;
      seenInSession.add(normalized);
    }

    if (prevNormalized && prevNormalized !== normalized) {
      const via = nav.via ?? prevVia;
      const existing = graph.edges.find(
        (e) => e.from === prevNormalized && e.to === normalized && e.via === via,
      );
      if (!existing) {
        const edge: PlatformLogbook['url_graph']['edges'][number] = {
          from: prevNormalized,
          to: normalized,
        };
        if (via) edge.via = via;
        graph.edges.push(edge);
      }
    }
    prevNormalized = normalized;
    prevVia = nav.via;
  }
}

/**
 * Fold one session's form observations into the logbook's forms_seen slot.
 * Mutates the logbook. Dedup key: {url, action, method}. Fields merge by name
 * (last-seen type wins on conflict).
 */
export function foldFormsIntoLogbook(
  logbook: PlatformLogbook,
  forms: SessionFormObservation[],
): void {
  if (!Array.isArray(logbook.forms_seen)) {
    logbook.forms_seen = [];
  }

  for (const form of forms) {
    const url = normalizeUrlForGraph(form.url);
    const action = normalizeUrlForGraph(form.action);
    const method = form.method.toUpperCase();
    const iso = new Date(form.at).toISOString();

    let entry = logbook.forms_seen.find(
      (f) => f.url === url && f.action === action && f.method === method,
    );
    if (!entry) {
      entry = {
        url,
        action,
        method,
        fields: form.fields.map((f) => ({ ...f })),
        first_seen: iso,
        last_seen: iso,
      };
      logbook.forms_seen.push(entry);
      continue;
    }

    if (iso > entry.last_seen) entry.last_seen = iso;
    if (iso < entry.first_seen) entry.first_seen = iso;

    for (const incoming of form.fields) {
      const existingField = entry.fields.find((f) => f.name === incoming.name);
      if (!existingField) {
        entry.fields.push({ ...incoming });
      } else {
        existingField.type = incoming.type;
        if (incoming.required !== undefined) {
          existingField.required = incoming.required;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Map-mode inference: derive observed_capabilities from navigations + forms.
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Last meaningful path segment from a URL (or path-only string). Strips
 *  trailing slash, ignores numeric / opaque-id tail segments by walking back
 *  one when the tail looks like an id. */
function lastMeaningfulSegment(urlOrPath: string): string {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath.split('?')[0] ?? urlOrPath;
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return 'root';
  // Walk back past id-shaped segments (numeric, hex, uuid, single short token
  // like "r1" or "u_42"). The "view_restaurant" case: /restaurants/r1 → use
  // "restaurants". Pure numeric or matched against opaque-id patterns.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i] ?? '';
    const looksLikeId =
      /^\d+$/.test(seg) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
      /^[0-9a-f]{12,}$/i.test(seg) ||
      /^[a-z]{1,3}\d+$/i.test(seg) || // r1, u42, p123
      /^[a-z]+_\d+$/i.test(seg); // user_42
    if (!looksLikeId) return seg;
  }
  return segments[0] ?? 'root';
}

function snakeCase(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/^_+/, '')
      // eslint-disable-next-line sonarjs/slow-regex
      .replace(/_+$/, '')
      .replace(/_+/g, '_')
  );
}

/**
 * Derive a capability name for a write-shaped form.
 *
 * Heuristics (ordered):
 * - `/cart/add`, `/items/add` → `add_to_<container>`
 * - `/cart/remove`, `/items/delete` → `remove_from_<container>` / `delete_<container>`
 * - `/checkout`, `/login`, `/signup` → bare action name
 * - generic POST → `submit_<slug>` or `<slug>` if it already starts with a verb.
 */
function nameForFormAction(action: string, method: string): string {
  let path: string;
  try {
    path = new URL(action).pathname;
  } catch {
    path = action.split('?')[0] ?? action;
  }
  const segs = path.split('/').filter((s) => s.length > 0);
  // Strip a leading 'api' segment so /api/cart/add → cart/add.
  if (segs[0]?.toLowerCase() === 'api') segs.shift();
  const tail = segs[segs.length - 1] ?? '';
  const parent = segs[segs.length - 2] ?? '';
  const tailLow = tail.toLowerCase();
  if (tailLow === 'add' && parent) return snakeCase(`add_to_${parent}`);
  if ((tailLow === 'remove' || tailLow === 'delete') && parent) {
    return snakeCase(`${tailLow === 'delete' ? 'delete' : 'remove_from'}_${parent}`);
  }
  if (tailLow === 'update' && parent) return snakeCase(`update_${parent}`);
  // Single bare action: /checkout, /login, /signup, /logout
  if (segs.length === 1 && tail) return snakeCase(tail);
  // Generic verbs already in the path.
  if (/^(create|update|delete|remove|add|search|send|submit)/i.test(tailLow)) {
    return snakeCase(tail);
  }
  if (method === 'DELETE' && tail) return snakeCase(`delete_${tail}`);
  if (method === 'PUT' || method === 'PATCH') {
    if (tail) return snakeCase(`update_${tail}`);
  }
  if (tail) return snakeCase(`submit_${tail}`);
  return 'submit_form';
}

/** Read-shape capability name for a navigation. `/orders` → `view_orders`. */
function nameForNavigation(urlOrPath: string): string {
  const seg = lastMeaningfulSegment(urlOrPath);
  if (seg === 'root' || seg === '' || seg === '/') return 'view_home';
  // `/search` → `search` (verb already), otherwise prepend `view_`.
  if (/^(search|browse|list|find)/i.test(seg)) return snakeCase(seg);
  return snakeCase(`view_${seg}`);
}

/**
 * Infer observed_capabilities from a session's runtime-collected navigations +
 * form observations. Used by end_drive for `intent === 'map'` sessions so
 * the agent doesn't have to manually call `record_observed_capability` for
 * every page they walked.
 *
 * Rules:
 * - Each form with a write-shaped method (POST/PUT/PATCH/DELETE) infers a
 *   write capability. Form evidence is stronger than page-visit evidence:
 *   when a navigation URL overlaps a form action's URL, the form wins.
 * - Each navigation that doesn't already have a form binding infers a read
 *   capability.
 * - Skips any name that already exists in `existingCaps` — manual entries
 *   from `record_observed_capability` win.
 * - Marks every inferred entry with `evidence.source = 'auto_inferred_graph_map'`
 *   so audits / filters can distinguish.
 */
export function inferObservedCapabilitiesFromGraph(
  navigations: SessionNavigation[],
  formsObserved: SessionFormObservation[],
  existingCaps: ObservedPlatformCapability[],
): Array<{
  name: string;
  evidence: { source: string; [k: string]: unknown };
  why_not_lifted: string;
}> {
  const out: Array<{
    name: string;
    evidence: { source: string; [k: string]: unknown };
    why_not_lifted: string;
  }> = [];
  const taken = new Set<string>(existingCaps.map((e) => e.name));
  // URL-graph nodes covered by a form action (so we don't double-infer a
  // read capability for the same URL the form lives on).
  const formCoveredUrls = new Set<string>();

  for (const form of formsObserved) {
    const method = form.method.toUpperCase();
    if (!WRITE_METHODS.has(method)) continue;
    const name = nameForFormAction(form.action, method);
    if (!name || taken.has(name)) continue;
    out.push({
      name,
      evidence: {
        source: 'auto_inferred_graph_map',
        kind: 'form_post',
        url: form.url,
        action: form.action,
        method,
        fields: form.fields.map((f) => f.name),
      },
      why_not_lifted: 'separate_capability',
    });
    taken.add(name);
    formCoveredUrls.add(normalizeUrlForGraph(form.url));
    formCoveredUrls.add(normalizeUrlForGraph(form.action));
  }

  // Dedup navigations by normalized URL so multiple visits to the same page
  // don't produce duplicate inferences.
  const seenNavUrls = new Set<string>();
  for (const nav of navigations) {
    const norm = normalizeUrlForGraph(nav.url);
    if (seenNavUrls.has(norm)) continue;
    seenNavUrls.add(norm);
    if (formCoveredUrls.has(norm)) continue;
    const name = nameForNavigation(nav.url);
    if (!name || taken.has(name)) continue;
    out.push({
      name,
      evidence: {
        source: 'auto_inferred_graph_map',
        kind: 'page_visit',
        url: nav.url,
      },
      why_not_lifted: 'separate_capability',
    });
    taken.add(name);
  }

  return out;
}
