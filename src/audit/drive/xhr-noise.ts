// Helpers for the end_drive `unsaved_xhr_endpoints` Detector: structural
// tracking-shape filter + per-session "what 2xx XHR URLs aren't covered by
// any saved strategy" computation. Extracted from end-drive.ts to keep that
// file under the line-count budget. Tracking patterns are documented as
// allowed runtime heuristic #8 in runtime/docs/principles.md.

import { loadStrategy } from '../../strategies/skills';
import { escapeRegExp } from '../../utils/regex';
import { readPlatformSkillInfo } from '../../strategies/skills-list-helpers';

interface InterceptedLike {
  status?: number | null;
  method?: string;
  url?: string;
  isNavigation?: boolean;
}

interface SavedCapLike {
  capability?: string;
}

/** Structural tracking/telemetry path patterns. Anchored on path segments
 *  (industry-standard conventions: `/collect`, `/beacon`, `/track`,
 *  `/metrics`, `/rum`, etc.) — not brand-specific hostnames. False positives
 *  are tolerable here: the rejection envelope lists the surviving paths and
 *  the agent acks-with-reason if any are real capabilities the filter missed.
 *  Documented as allowed runtime heuristic #8 in
 *  runtime/docs/principles.md §"Delegate to the LLM, but allow narrowly-scoped
 *  runtime heuristics." */
const TRACKING_PATH_PATTERNS = [
  /\/analytics?\//i,
  /\/telemetry\//i,
  /\/collect\b/i,
  /\/beacon\b/i,
  /\/pixel\b/i,
  /\/track\b/i,
  /\/metrics?\b/i,
  /\/events?\b/i,
  /\/rum\b/i,
  /\/heartbeat\b/i,
];

function looksLikeTracking(urlPath: string): boolean {
  return TRACKING_PATH_PATTERNS.some((re) => re.test(urlPath));
}

/** Turn an endpoint template like `/api/v2/items/{{id}}/photos` into a regex
 *  that matches concrete URL paths. Strips any query string from the template
 *  before compiling — `/api/items?content=true&id={{id}}` is keyed against
 *  `URL.pathname` (no query), so leaving the query in the regex makes it
 *  unmatchable. The agent's "covered by saved strategy" check is path-level. */
function endpointTemplateToRegex(template: string): RegExp {
  const pathOnly = template.split('?')[0] ?? template;
  const escaped = escapeRegExp(pathOnly);
  // After escape, `\{\{[^}]+\}\}` is the literal placeholder. Restore as
  // wildcard segments (any chars except `/` to keep the path-segment shape).
  const wildcarded = escaped.replace(/\\\{\\\{[^}]+\\\}\\\}/g, '[^/?#]+');
  return new RegExp(`^${wildcarded}$`);
}

/** Walk a strategy and harvest every URL-template a captured XHR could match
 *  against. Covers: top-level `endpoint`, every `prerequisites[*].url`, and
 *  any quoted URL inside js-eval / page-script `expression` text. The last
 *  catches page-script strategies that fire `fetch("/api/items/{{id}}")`
 *  from inside an iframe — the saved strategy reaches that path even though
 *  its top-level `endpoint` field is absent. */
function harvestStrategyTemplates(strategy: unknown): string[] {
  if (!strategy || typeof strategy !== 'object') return [];
  const s = strategy as Record<string, unknown>;
  const out: string[] = [];
  if (typeof s.endpoint === 'string' && s.endpoint.length > 0) out.push(s.endpoint);
  const prereqs = Array.isArray(s.prerequisites) ? s.prerequisites : [];
  for (const p of prereqs) {
    if (p && typeof p === 'object' && typeof (p as { url?: unknown }).url === 'string') {
      const u = (p as { url: string }).url;
      if (u.length > 0) out.push(u);
    }
  }
  // Scan js-eval / page-script expression bodies for quoted URLs. Common
  // shapes: fetch('/api/x'), fetch(`/api/x`), navigate('/foo'). The regex
  // walks for `('` / `("` / `(\`` URL openers and grabs the path until the
  // matching closer or interpolation. Conservative: only matches paths that
  // start with `/`, skipping data: / blob: / absolute https:// URLs.
  const expression = (() => {
    const fromPage = s.frameFromPage as { expression?: unknown } | undefined;
    if (fromPage && typeof fromPage.expression === 'string') return fromPage.expression;
    const body = s.body as { expression?: unknown } | undefined;
    if (body && typeof body.expression === 'string') return body.expression;
    return null;
  })();
  if (typeof expression === 'string') {
    const urlRe = /['"`](\/[^'"`?#]{0,200})['"`?#]/g;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(expression)) !== null) {
      if (m[1] && m[1].length > 1) out.push(m[1]);
    }
  }
  return out;
}

/** Build the list of unsaved hot XHR endpoints for the audit detector.
 *  Iterates platform-wide saved strategies (this-session AND prior-session
 *  saves on disk), strips query strings before regex compile, and inspects
 *  prerequisites[*].url + URLs inside page-script expressions so
 *  prior-session and cross-tier coverage subtracts cleanly. Pure modulo
 *  `loadStrategy` disk reads (cached by skills.ts). */
export function collectUnsavedHotXhrEndpoints(
  intercepted: ReadonlyArray<InterceptedLike> | undefined,
  sessionSavedCapabilities: ReadonlyArray<SavedCapLike> | undefined,
  platform: string,
): Array<{ method: string; urlPath: string; sampleUrl: string }> {
  const savedPatterns: RegExp[] = [];
  if (platform) {
    // Capability names to subtract: every non-archived cap on disk (prior
    // sessions are equally "covered") PLUS this session's in-flight saves. The
    // latter matters because a capability saved during THIS end_drive flow may
    // not yet be reflected in readPlatformSkillInfo's cache — without it the
    // gate flags an endpoint the agent just saved in the same call.
    const capNames = new Set<string>();
    let platformInfo: { capabilities?: Array<{ name?: string }> };
    try {
      platformInfo = readPlatformSkillInfo(platform) as never;
    } catch {
      platformInfo = { capabilities: [] };
    }
    for (const cap of platformInfo.capabilities ?? []) {
      if (typeof cap.name === 'string' && cap.name.length > 0) capNames.add(cap.name);
    }
    for (const cap of sessionSavedCapabilities ?? []) {
      if (typeof cap.capability === 'string' && cap.capability.length > 0) {
        capNames.add(cap.capability);
      }
    }
    for (const name of capNames) {
      const strat = loadStrategy(platform, name);
      if (!strat) continue;
      const templates = harvestStrategyTemplates(strat);
      for (const tmpl of templates) {
        try {
          savedPatterns.push(endpointTemplateToRegex(tmpl));
        } catch {
          /* skip malformed template */
        }
      }
    }
  }
  const out: Array<{ method: string; urlPath: string; sampleUrl: string }> = [];
  const seen = new Set<string>();
  const MAX = 20;
  for (const req of intercepted ?? []) {
    if (out.length >= MAX) break;
    const status = req.status;
    if (typeof status !== 'number' || status < 200 || status >= 300) continue;
    if (req.isNavigation === true) continue;
    if (typeof req.url !== 'string') continue;
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      continue;
    }
    const urlPath = parsed.pathname;
    if (looksLikeTracking(urlPath)) continue;
    if (savedPatterns.some((re) => re.test(urlPath))) continue;
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
    const key = `${method} ${urlPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method, urlPath, sampleUrl: req.url });
  }
  return out;
}
