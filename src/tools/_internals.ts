import { pool } from '../runtime-state';
import * as skills from '../strategies/skills';
import {
  inlineArtifactForResponse as inlineArtifactForResponseBase,
  type DiscoveryArtifact,
  type InlinedArtifact,
} from '../strategies/discovery-artifact';

/** Shared advisory for the networkLog drop. Centralized so both the
 * start_session auto-execute embed and direct execute() tool surface the same
 * wording + follow-up. */
export const NETWORKLOG_TRIM_HINT =
  'networkLog omitted to keep the response under the MCP output budget. Re-fetch via get_network_log({session_id}) on an open session, or call execute({full: true}) to inline it.';

/** Thin wrapper binding `skills.loadStrategies` into the inlining helper so
 * call sites stay 4-arg. Keeps discovery-artifact.ts independent of skills.ts
 * (skills.ts imports from discovery-artifact — the inlining
 *  takes `loadStrategies` as a parameter to avoid the cycle). */
export function inlineArtifactForResponse(
  platform: string,
  capability: string,
  artifact: DiscoveryArtifact,
  budget: number,
): InlinedArtifact {
  return inlineArtifactForResponseBase(
    platform,
    capability,
    artifact,
    budget,
    skills.loadStrategies,
  );
}

/**
 * Snapshot every `<form>` element in the active page and append the result to
 * `session.domFormsObserved`. Called after the initial `start_session` nav
 * and after every `perform_action` so SPA route changes that introduce new
 * forms land in the platform's `forms_seen` inventory at close_session.
 *
 * Best-effort: capture failures (page closed, eval timeout) yield an empty
 * batch and are swallowed — surface mapping is diagnostic, not load-bearing.
 */
export async function captureAndAppendForms(
  session: ReturnType<typeof pool.getSession>,
  driver: ReturnType<typeof pool.driverFor>,
): Promise<void> {
  const forms = await driver.captureFormSummary(session).catch(() => []);
  if (forms.length === 0) return;
  if (!session.domFormsObserved) session.domFormsObserved = [];
  for (const f of forms) {
    session.domFormsObserved.push(f);
  }
}

/**
 * Read the session's live top-level URL, filtered to http(s). Returns
 * undefined on driver error, unreachable session, or non-web scheme — the
 * caller treats absence as "don't stamp `notes.discovered_from_url`".
 */
export async function readCurrentUrl(sessionId: string): Promise<string | undefined> {
  try {
    const session = pool.getSession(sessionId);
    const driver = pool.driverFor(sessionId);
    const url = await driver.getUrl(session);
    if (typeof url !== 'string' || !url || url === 'about:blank') return undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    } catch {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

// Enumerate every string-valued query/body param on a captured request.
// No shape heuristic — runtime records what was observed; the agent
// decides at save time which params are enums via `notes.params.X.kind`.
// Dedupe + per-param caps in session-observations keep memory bounded.
export function* enumerateStringParams(
  request: import('../drivers/types/network').InterceptedRequest,
): Generator<[string, string]> {
  try {
    const u = new URL(request.url);
    for (const [k, v] of u.searchParams) {
      if (typeof v === 'string' && v.length > 0) yield [k, v];
    }
  } catch {
    // non-URL — skip query extraction
  }
  const post = request.postData;
  if (post && typeof post === 'object' && !Array.isArray(post)) {
    for (const [k, v] of Object.entries(post as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) yield [k, v];
    }
  } else if (typeof post === 'string' && post.length > 0) {
    // Try JSON parse for application/json bodies stringified at capture time.
    try {
      const parsed = JSON.parse(post) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length > 0) yield [k, v];
        }
        return;
      }
    } catch {
      // fall through to form-urlencoded parse
    }
    // Try application/x-www-form-urlencoded — legacy HTML forms POST this
    // shape ("name=Alice&email=alice%40example.com&message=Hello+from+...").
    // Detected by content-type when present, otherwise by the body's own shape
    // (key=value pairs separated by &). URLSearchParams handles both
    // percent-decoding and `+` → space.
    const ct = readContentType(request.headers);
    const looksLikeForm =
      /\bapplication\/x-www-form-urlencoded\b/i.test(ct) ||
      /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(post);
    if (looksLikeForm) {
      try {
        const params = new URLSearchParams(post);
        for (const [k, v] of params) {
          if (typeof v === 'string' && v.length > 0) yield [k, v];
        }
      } catch {
        // unparseable — nothing to enumerate
      }
    }
  }
}

function readContentType(headers: Record<string, string> | undefined): string {
  if (!headers) return '';
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return typeof v === 'string' ? v : '';
  }
  return '';
}
