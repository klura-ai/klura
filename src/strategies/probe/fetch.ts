import type { BrowserDriver } from '../../drivers/interface';
import type { Session } from '../../drivers/types/session';

export interface FetchExtractPrereq {
  name: string;
  kind: 'fetch-extract';
  url: string;
  method?: string;
  headers_map?: Record<string, string>;
  fetch_body?: Record<string, unknown>;
  vars: Record<string, string>;
}

export function extractFetchExtractPrereqs(data: Record<string, unknown>): FetchExtractPrereq[] {
  if (data.strategy !== 'fetch' && data.strategy !== 'page-script') return [];
  const prerequisites = data.prerequisites;
  if (!Array.isArray(prerequisites)) return [];
  const out: FetchExtractPrereq[] = [];
  for (const raw of prerequisites) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (p.kind !== 'fetch-extract') continue;
    if (typeof p.url !== 'string' || typeof p.name !== 'string') continue;
    if (!p.vars || typeof p.vars !== 'object') continue;
    const narrowedVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.vars as Record<string, unknown>)) {
      if (typeof v === 'string') narrowedVars[k] = v;
    }
    out.push({
      name: p.name,
      kind: 'fetch-extract',
      url: p.url,
      method: typeof p.method === 'string' ? p.method : undefined,
      headers_map: isPlainStringMap(p.headers_map) ? p.headers_map : undefined,
      fetch_body:
        p.fetch_body && typeof p.fetch_body === 'object'
          ? (p.fetch_body as Record<string, unknown>)
          : undefined,
      vars: narrowedVars,
    });
  }
  return out;
}

export function isPlainStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}

// Fire a fetch-extract prereq against the live API, in a real browser session,
// and verify it returns 2xx + every dot-path resolves. Skips non-GET methods
// entirely — we don't replay POST/PUT/DELETE at save time because they have
// side effects. Uses `credentials: "omit"` for the same reason the executor
// does: cross-origin public APIs return `Access-Control-Allow-Origin: *` which
// CORS rejects with credentials.
function fetchExtractStatusAdvice(status: number, httpMethod: string): string {
  if (status === 404) {
    return (
      `The API returned 404 — if the target resource is private/authenticated, ` +
      `the public REST endpoint will not find it without a token. Use an endpoint ` +
      `that runs same-origin with the main call (where session cookies already work), ` +
      `OR use a page-extract prereq to grab the value from a rendered meta tag/data-attr on the target page, ` +
      `OR fall back to accepting the ID as a user arg with a documented notes.params.example.`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `The API rejected the request as unauthenticated. fetch-extract uses credentials:"omit" by design — ` +
      `if the target needs auth, pass an explicit Authorization header via "headers_map" instead of relying on session cookies.`
    );
  }
  return `Check the URL template and the ${httpMethod} method.`;
}

export async function probeOneFetchPrereq(
  driver: BrowserDriver,
  session: Session,
  prereq: FetchExtractPrereq,
): Promise<void> {
  const httpMethod = (prereq.method ?? 'GET').toUpperCase();
  if (httpMethod !== 'GET') {
    // Non-GET fetch-extract prereqs (rare) aren't probed — we don't want to
    // fire a POST/PUT/DELETE at save time in case it has side effects. The
    // executor will catch any runtime issues at first use.
    return;
  }

  // fetchInBrowser needs a live page. about:blank gives us a valid JS execution
  // context without the restricted-context issue that navigating to a JSON API
  // endpoint would create.
  try {
    await driver.navigate(session, 'about:blank', { waitUntil: 'domcontentloaded' });
  } catch {
    /* best-effort — if navigate to about:blank fails something is very wrong */
  }

  const headers = prereq.headers_map ?? { Accept: 'application/json' };
  const result = await driver.fetchInBrowser(session, prereq.url, {
    method: 'GET',
    headers,
    credentials: 'omit',
  });

  if (!result.ok) {
    throw new Error(
      `invalid_strategy: prerequisite "${prereq.name}" (fetch-extract) failed save-time probe — ` +
        `the fetch to ${prereq.url} failed: ${result.error}. ` +
        `Common cause: the target API blocks cross-origin fetches with "Access-Control-Allow-Origin: *" + credentials, ` +
        `or the URL is unreachable from the browser context.`,
    );
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `invalid_strategy: prerequisite "${prereq.name}" (fetch-extract) failed save-time probe — ` +
        `HTTP ${result.status} from ${prereq.url}. ` +
        fetchExtractStatusAdvice(result.status, httpMethod),
    );
  }

  for (const [varName, rawPath] of Object.entries(prereq.vars)) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) continue;
    const value = extractByPathAt(result.body, rawPath);
    if (value === undefined || value === '') {
      throw new Error(
        `invalid_strategy: prerequisite "${prereq.name}" (fetch-extract) failed save-time probe — ` +
          `var "${varName}" dot-path "${rawPath}" did not resolve in the response body from ${prereq.url}. ` +
          `The response was 2xx but the path you chose points at an empty/missing field. ` +
          `Re-inspect the JSON structure and use a dot-path that actually exists in the response.`,
      );
    }
  }
}

// Local copy of the same dot-path extractor the executor uses. Kept here so the
// probe doesn't import from execution.ts (keeps layering clean — strategy-probe
// is a leaf).
function extractByPathAt(obj: unknown, path: string): string | undefined {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const rawPart of parts) {
    if (cur === null || cur === undefined) return undefined;
    const arrMatch = /^([^[]*)(\[(\d+)\])+$/.exec(rawPart);
    if (arrMatch) {
      const key = arrMatch[1] ?? '';
      if (key.length > 0) {
        if (typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[key];
      }
      const idxMatches = rawPart.matchAll(/\[(\d+)\]/g);
      for (const m of idxMatches) {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[Number(m[1])];
      }
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[rawPart];
  }
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return undefined;
}
