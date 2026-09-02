import type { BrowserDriver } from '../../drivers/interface';
import type { Session } from '../../drivers/types/session';
import { extractFromHtml } from '../../response/html-extract';
import { parseJsonAllowingHijackingPrefix } from '../../response/json-hijacking-prefix';
import { isLoginWallUrl, tryGetUrl } from '../../response/auth-wall';
import { joinBaseAndPath } from '../../execution';
import { resolveTemplate } from '../probe-helpers';
import { WARNING_KINDS, REF_LINKS, refUrl } from '../../vocab';

/** The subset of a response.extract leaf the probe replays. `json` is carried
 *  through rather than dropped so the probe validates the same extraction warm
 *  execute performs — without it the probe would test a raw-text read of the
 *  element and pass while the real path walks a JSON dot-path. */
export interface HtmlExtractLeafSpec {
  selector: string;
  attr?: string;
  multiple?: boolean;
  json?: string;
}

export interface FetchHtmlExtract {
  baseUrl: string;
  endpointPath: string;
  extract: Record<string, HtmlExtractLeafSpec>;
}

export interface ResolvedFetchHtmlExtract {
  url: string;
  extract: Record<string, HtmlExtractLeafSpec>;
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

  const narrowedExtract: Record<string, HtmlExtractLeafSpec> = {};
  for (const [k, v] of Object.entries(r.extract as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const spec = v as Record<string, unknown>;
    if (typeof spec.selector !== 'string') continue;
    narrowedExtract[k] = {
      selector: spec.selector,
      ...(typeof spec.attr === 'string' ? { attr: spec.attr } : {}),
      ...(typeof spec.multiple === 'boolean' ? { multiple: spec.multiple } : {}),
      ...(typeof spec.json === 'string' ? { json: spec.json } : {}),
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
  ackedKinds: ReadonlySet<string> = new Set(),
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
  //  - any JSON value (leaf with `json`, single or multiple)
  //
  // "Empty" for a row group means zero rows extracted OR every row has all
  // empty fields. Per-row partial emptiness is the strategy author's
  // intentional tolerance for missing optional fields (e.g. some search
  // results lack a price) — we don't reject on per-row partials, only on
  // "the selector matched nothing usable anywhere."
  const isExtractedEmpty = (v: unknown): boolean => {
    if (typeof v === 'string') return v.length === 0;
    // A `json` extract resolves to raw JSON, so a scalar is real evidence the
    // path hit — 0 and false are values, not misses.
    if (typeof v === 'number' || typeof v === 'boolean') return false;
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

  assertNoUnpathedJsonBlobs(spec, extracted, ackedKinds);
}

/** Longest prefix of a dot-path whose value is still an object — the deepest
 *  container worth naming in the hint, so the agent sees where to descend. */
function firstObjectKeys(value: unknown, limit: number): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).slice(0, limit);
}

/**
 * A leaf that returned a string which parses as a JSON object or array is a
 * serialized payload handed to the caller whole — the site rendered its data
 * into a `<script>` tag and the extract read the tag's text instead of a value
 * inside it. Callers get one opaque blob to re-parse (and it counts against the
 * response budget), when `json` would return the field itself.
 *
 * Decided on the probe's own bytes rather than on how the selector is spelled:
 * `#__DATA__` targets a script tag without the word "script" appearing
 * anywhere, so a shape-only check would miss it.
 *
 * Ackable, not fatal — returning the whole document verbatim is occasionally
 * the point.
 */
export function assertNoUnpathedJsonBlobs(
  spec: ResolvedFetchHtmlExtract,
  extracted: Record<string, unknown>,
  ackedKinds: ReadonlySet<string>,
): void {
  if (ackedKinds.has(WARNING_KINDS.htmlExtractReturnsJsonBlob)) return;

  const flagged: string[] = [];
  const hints: string[] = [];
  for (const [varName, value] of Object.entries(extracted)) {
    if (spec.extract[varName]?.json !== undefined) continue;
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    flagged.push(varName);
    const keys = firstObjectKeys(parsed, 6);
    hints.push(
      `response.extract.${varName} returned ${text.length} chars of JSON` +
        (keys.length > 0 ? ` with top-level keys: ${keys.join(', ')}` : ''),
    );
  }
  if (flagged.length === 0) return;

  const plural = flagged.length > 1;
  throw new Error(
    `invalid_strategy: ${WARNING_KINDS.htmlExtractReturnsJsonBlob} — ` +
      `${flagged.length} extract entr${plural ? 'ies' : 'y'} on ${spec.url} returned a serialized ` +
      `JSON document rather than a value from inside it: ${hints.join('; ')}. ` +
      `The caller receives one opaque string to re-parse, and a document that large can exhaust ` +
      `the response budget on its own.\n` +
      `Add a \`json\` dot-path to each so the extract returns the field itself — ` +
      `{selector: "<same selector>", json: "a.b.c"} — which yields raw JSON (numbers stay ` +
      `numbers). Bracket-quote any key containing a dot: json: '__DEFAULT_SCOPE__["a.b"].c'. ` +
      `Values read this way are the server's exact ones, where the rendered markup is often ` +
      `rounded or locale-formatted.\n` +
      `If handing back the whole document is deliberate, ack it: ` +
      `notes.save_warnings_acked: [{kind: "${WARNING_KINDS.htmlExtractReturnsJsonBlob}", ` +
      `reason: "<why the caller wants the raw document>"}]. ` +
      `See ${refUrl(REF_LINKS.fetchSchema)}.`,
  );
}

// ---------------------------------------------------------------------------
// Declared-JSON fetch probe
// ---------------------------------------------------------------------------

export interface FetchJsonTarget {
  baseUrl: string;
  endpointPath: string;
}

export interface ResolvedFetchJsonTarget {
  url: string;
}

/**
 * A GET fetch that explicitly declares `response.format: "json"`.
 *
 * Scoped to an EXPLICIT declaration on purpose. Saying `format: "json"` is a
 * claim about what the endpoint returns, and this probe verifies that claim; a
 * strategy that declares nothing has made no claim to check, and firing a
 * request for every fetch at save time would be a much broader change than the
 * defect warrants.
 *
 * GET only, and never when `response.from` is set — that shape returns a
 * prereq's value and fires no HTTP of its own.
 */
export function extractFetchJsonTargets(data: Record<string, unknown>): FetchJsonTarget[] {
  if (data.strategy !== 'fetch') return [];
  const response = data.response;
  if (!response || typeof response !== 'object') return [];
  const r = response as Record<string, unknown>;
  if (r.format !== 'json') return [];
  if (typeof r.from === 'string' && r.from.length > 0) return [];

  const method = typeof data.method === 'string' ? data.method.toUpperCase() : 'GET';
  if (method !== 'GET') return [];

  const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl : '';
  const endpointRaw = typeof data.endpoint === 'string' ? data.endpoint : '';
  if (baseUrl.length === 0 || endpointRaw.length === 0) return [];
  const endpointPath = endpointRaw.includes(' ')
    ? endpointRaw.split(' ').slice(1).join(' ')
    : endpointRaw;
  return [{ baseUrl, endpointPath }];
}

export function resolveFetchJsonTargets(
  targets: FetchJsonTarget[],
  examples: Record<string, string>,
): ResolvedFetchJsonTarget[] {
  return targets.map((t) => ({
    url: joinBaseAndPath(
      t.baseUrl,
      resolveTemplate(t.endpointPath, examples, 'fetch json probe url'),
    ),
  }));
}

/**
 * Fire a declared-JSON GET and confirm the body actually parses as JSON.
 *
 * The failure this exists for returns a perfectly healthy-looking 200 whose
 * body the runtime hands back as raw text, so the capability saves clean and
 * every caller receives a string where rows were promised. Nothing downstream
 * notices: there is no extract to come up empty and no status to inspect.
 */
export async function probeOneFetchJson(
  driver: BrowserDriver,
  session: Session,
  spec: ResolvedFetchJsonTarget,
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
      `invalid_strategy: fetch json probe — could not parse url ${JSON.stringify(spec.url)}. See ${refUrl(REF_LINKS.fetchSchema)}.`,
    );
  }
  const originUrl = `${parsedTargetUrl.protocol}//${parsedTargetUrl.host}`;
  try {
    await driver.navigate(session, originUrl, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    throw new Error(
      `invalid_strategy: fetch json probe — could not navigate to ${originUrl} before fetching: ${
        err instanceof Error ? err.message : String(err)
      }. See ${refUrl(REF_LINKS.fetchSchema)}.`,
      { cause: err },
    );
  }

  const finalUrl = await tryGetUrl(driver, session);
  if (isLoginWallUrl(finalUrl)) {
    warnings.push(
      `fetch json probe navigated to ${originUrl} before fetching ${spec.url} but landed on a ` +
        `login wall at ${finalUrl}. Storage-state may be stale — strategy saved without response ` +
        `verification.`,
    );
    return;
  }

  const result = await driver.fetchInBrowser(session, spec.url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });

  if (!result.ok) {
    throw new Error(
      `invalid_strategy: fetch json probe — the GET to ${spec.url} failed: ${result.error}. See ${refUrl(REF_LINKS.fetchSchema)}.`,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `invalid_strategy: fetch json probe — HTTP ${result.status} from ${spec.url}. ` +
        htmlResponseStatusAdvice(result.status) +
        ` See ${refUrl(REF_LINKS.fetchSchema)}.`,
    );
  }

  // An object body means the driver already parsed it — nothing to check.
  if (typeof result.body !== 'string') return;
  const text = result.body;
  if (text.trim().length === 0) {
    throw new Error(
      `invalid_strategy: fetch json probe — ${spec.url} answered ${result.status} with an empty ` +
        `body while the strategy declares response.format "json". An empty 200 is a common ` +
        `"request rejected" shape; a caller would receive nothing and see success. Confirm the ` +
        `request carries whatever the endpoint requires, or drop the json declaration. See ${refUrl(REF_LINKS.fetchSchema)}.`,
    );
  }
  if (parseJsonAllowingHijackingPrefix(text) !== undefined) return;

  throw new Error(
    `invalid_strategy: fetch json probe — the body from ${spec.url} does not parse as JSON, but ` +
      `the strategy declares response.format "json". The runtime hands an unparseable body back ` +
      `as raw text, so this saves clean and then returns a string where rows were promised. ` +
      `First ${Math.min(80, text.length)} chars: ${JSON.stringify(text.slice(0, 80))}. ` +
      `If the endpoint returns HTML, use response.format "html" with an extract; if it returns ` +
      `something else, read it in a page-script instead. See ${refUrl(REF_LINKS.fetchSchema)}.`,
  );
}
