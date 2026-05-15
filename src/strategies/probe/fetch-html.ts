import type { BrowserDriver } from '../../drivers/interface';
import type { Session } from '../../drivers/types/session';
import { extractFromHtml } from '../../response/html-extract';
import { isLoginWallUrl, tryGetUrl } from '../../response/auth-wall';
import { joinBaseAndPath } from '../../execution';
import { resolveTemplate } from '../probe-helpers';

export interface FetchHtmlExtract {
  baseUrl: string;
  endpointPath: string;
  extract: Record<string, { selector: string; attr?: string; multiple?: boolean }>;
}

export interface ResolvedFetchHtmlExtract {
  url: string;
  extract: Record<string, { selector: string; attr?: string; multiple?: boolean }>;
}

// Return the fetch-tier HTML extract spec if this is a GET fetch with
// response.format = 'html'. Otherwise []. Validation guarantees the shape is
// correct (non-empty extract, method = GET) by the time we get here.
export function extractFetchHtmlExtracts(data: Record<string, unknown>): FetchHtmlExtract[] {
  if (data.strategy !== 'fetch') return [];
  const response = data.response;
  if (!response || typeof response !== 'object') return [];
  const r = response as Record<string, unknown>;
  if (r.format !== 'html') return [];
  if (!r.extract || typeof r.extract !== 'object') return [];

  const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl : '';
  const endpointRaw = typeof data.endpoint === 'string' ? data.endpoint : '';
  if (baseUrl.length === 0 || endpointRaw.length === 0) return [];

  // endpoint may be "GET /foo" or "/foo"; strip the method prefix.
  const endpointPath = endpointRaw.includes(' ')
    ? endpointRaw.split(' ').slice(1).join(' ')
    : endpointRaw;

  const narrowedExtract: Record<string, { selector: string; attr?: string; multiple?: boolean }> =
    {};
  for (const [k, v] of Object.entries(r.extract as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const spec = v as Record<string, unknown>;
    if (typeof spec.selector !== 'string') continue;
    narrowedExtract[k] = {
      selector: spec.selector,
      ...(typeof spec.attr === 'string' ? { attr: spec.attr } : {}),
      ...(typeof spec.multiple === 'boolean' ? { multiple: spec.multiple } : {}),
    };
  }

  // baseUrl + endpointPath stay separate so the caller can resolveTemplate the
  // path before joining. WHATWG URL resolution percent-encodes `{` and `}`, so
  // joining first turns `/users/{{userId}}/orders` into
  // `/users/%7B%7BuserId%7D%7D/orders` and the {{...}} regex no longer matches.
  return [{ baseUrl, endpointPath, extract: narrowedExtract }];
}

export function resolveFetchHtmlExtracts(
  extracts: FetchHtmlExtract[],
  examples: Record<string, string>,
): ResolvedFetchHtmlExtract[] {
  return extracts.map((d) => {
    // Resolve the path's {{...}} placeholders BEFORE joining with baseUrl —
    // joining via WHATWG URL would percent-encode the braces and the regex
    // would no longer match.
    const resolvedPath = resolveTemplate(d.endpointPath, examples, `fetch response probe url`);
    return {
      url: joinBaseAndPath(d.baseUrl, resolvedPath),
      extract: d.extract,
    };
  });
}

function htmlResponseStatusAdvice(status: number): string {
  if (status === 401 || status === 403) {
    return (
      `The page rejected the request as unauthenticated. The agent typically logs in via the remote ` +
      `viewer earlier in discovery; if this is the first save, make sure the platform's storage-state has ` +
      `a live session before saving.`
    );
  }
  if (status === 404) {
    return `The URL does not exist — check the baseUrl + endpoint combination and any {{template}} params.`;
  }
  return `Check the URL template, the origin, and the notes.params examples.`;
}

// Probe a fetch strategy that declares response.format = 'html'. Fires the real
// GET inside a real browser session, runs every selector, and rejects the save
// if the page didn't parse or the selectors don't resolve. Read-only — HTML
// extraction is GET-only (enforced at validate time), so there are no side
// effects. Uses credentials: 'include' because these strategies target
// authenticated pages, so we navigate to the baseUrl first to get a non-opaque
// origin (same pattern executeDirect uses before firing).
export async function probeOneFetchHtml(
  driver: BrowserDriver,
  session: Session,
  spec: ResolvedFetchHtmlExtract,
  warnings: string[],
): Promise<void> {
  const parsedTargetUrl = (() => {
    try {
      return new URL(spec.url);
    } catch {
      return null;
    }
  })();
  if (!parsedTargetUrl) {
    throw new Error(
      `invalid_strategy: fetch response probe — could not parse url ${JSON.stringify(spec.url)}. See klura://reference#fetch-schema.`,
    );
  }
  const originUrl = `${parsedTargetUrl.protocol}//${parsedTargetUrl.host}`;

  try {
    await driver.navigate(session, originUrl, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    throw new Error(
      `invalid_strategy: fetch response probe — could not navigate to ${originUrl} before fetch: ${
        err instanceof Error ? err.message : String(err)
      }. See klura://reference#fetch-schema.`,
      { cause: err },
    );
  }

  // Login-wall soft-warn — same rationale as page-extract: skip the fetch probe
  // and warn rather than hard-rejecting on stale storage-state.
  const finalUrl = await tryGetUrl(driver, session);
  if (isLoginWallUrl(finalUrl)) {
    warnings.push(
      `fetch response probe navigated to ${originUrl} before fetching ${spec.url} but landed on a ` +
        `login wall at ${finalUrl}. Storage-state may be stale or missing — re-login via ` +
        `start_remote_session and save again. Strategy saved without response-extract verification.`,
    );
    return;
  }

  const result = await driver.fetchInBrowser(session, spec.url, {
    method: 'GET',
    headers: { Accept: 'text/html' },
    credentials: 'include',
  });

  if (!result.ok) {
    throw new Error(
      `invalid_strategy: fetch response probe — the GET to ${spec.url} failed: ${result.error}. ` +
        `Common cause: the target URL is unreachable or the browser context rejected the fetch. See klura://reference#fetch-schema.`,
    );
  }

  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `invalid_strategy: fetch response probe — HTTP ${result.status} from ${spec.url}. ` +
        htmlResponseStatusAdvice(result.status) +
        ` See klura://reference#fetch-schema.`,
    );
  }

  if (typeof result.body !== 'string') {
    throw new Error(
      `invalid_strategy: fetch response probe — ${spec.url} returned a body of type ${typeof result.body}, ` +
        `expected a string. response.format = "html" requires a text response. If the endpoint actually returns ` +
        `JSON, remove response.format and let fetch default to JSON passthrough. See klura://reference#fetch-schema.`,
    );
  }

  let extracted: Record<string, unknown>;
  try {
    extracted = extractFromHtml(result.body, spec.extract);
  } catch (err) {
    throw new Error(
      `invalid_strategy: fetch response probe — cheerio failed to parse response from ${spec.url}: ${
        err instanceof Error ? err.message : String(err)
      }. See klura://reference#fetch-schema.`,
      { cause: err },
    );
  }

  // Each extract entry's value is one of:
  //  - string (leaf, single)
  //  - string[] (leaf, multiple)
  //  - Record<string,string> (row group, multiple:false)
  //  - Array<Record<string,string>> (row group, multiple:true)
  //
  // "Empty" for a row group means zero rows extracted OR every row has all
  // empty fields. Per-row partial emptiness is the strategy author's
  // intentional tolerance for missing optional fields (e.g. some search
  // results lack a price) — we don't reject on per-row partials, only on
  // "the selector matched nothing usable anywhere."
  const isExtractedEmpty = (v: unknown): boolean => {
    if (typeof v === 'string') return v.length === 0;
    if (Array.isArray(v)) {
      if (v.length === 0) return true;
      return v.every((entry) => isExtractedEmpty(entry));
    }
    if (v !== null && typeof v === 'object') {
      const vals = Object.values(v as Record<string, unknown>);
      if (vals.length === 0) return true;
      return vals.every((entry) => isExtractedEmpty(entry));
    }
    return true;
  };

  // All-empty = auth wall or wildly-wrong selectors. Reject loudly — a
  // successful 200 on a login interstitial will otherwise pass silently.
  const allEmpty = Object.values(extracted).every(isExtractedEmpty);
  if (allEmpty) {
    throw new Error(
      `invalid_strategy: fetch response probe — every extract selector resolved to empty on ${spec.url}. ` +
        `The page may have returned an auth wall or interstitial instead of the expected content, or the ` +
        `selectors don't match the actual DOM. Re-discover the selectors by reading the real page (a11y ` +
        `tree or the saved fetch_in_browser body) and verify they exist before saving. See klura://reference#fetch-schema.`,
    );
  }

  // Some-empty + some-populated = likely a single wrong selector. Name it.
  for (const [varName, value] of Object.entries(extracted)) {
    if (isExtractedEmpty(value)) {
      const spec1 = spec.extract[varName];
      throw new Error(
        `invalid_strategy: fetch response.extract.${varName} failed save-time probe — ` +
          `selector ${JSON.stringify(spec1?.selector)} resolved on ${spec.url} to an empty value. ` +
          `Either the element exists but is empty, the ${
            spec1?.attr ? `attribute "${spec1.attr}"` : 'text content'
          } is missing, or the selector picks the wrong element. ` +
          `Verify it against the real HTML and save again. See klura://reference#fetch-schema.`,
      );
    }
  }
}
