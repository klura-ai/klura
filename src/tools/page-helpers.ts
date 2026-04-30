import { pool } from '../runtime-state';
import { ensureAccumulator, ringPush, digestSelector } from '../strategies/discovery-artifact';
import { truncateString, ATTRIBUTE_VALUE_BUDGET } from '../response/response-size';
import { recordObservations } from '../observation-trace';

export async function getScreenshot(sessionId: string): Promise<string> {
  const session = pool.getSession(sessionId);
  return await pool.driverFor(sessionId).screenshot(session);
}

/**
 * Read an attribute off the first element matching `selector`. If `attr` is
 * omitted, returns the element's text content. Used at discovery time to verify
 * candidate selectors (e.g. a `meta[name='csrf-token']` nonce) without having
 * to guess-and-save and rely on the save-time probe to reject. Throws if the
 * selector doesn't resolve so the agent can tell "doesn't exist" apart from
 * "exists but empty".
 */
export async function getAttribute(
  sessionId: string,
  selector: string,
  attr?: string,
): Promise<{ value: string; truncated?: true; total_chars?: number }> {
  const session = pool.getSession(sessionId);
  const driver = pool.driverFor(sessionId);
  const raw = attr
    ? await driver.getAttribute(session, selector, attr)
    : await driver.getText(session, selector);
  ringPush(ensureAccumulator(session).getAttributeCalls, {
    selector_digest: digestSelector(selector),
    attr: attr ?? '',
    at: new Date().toISOString(),
  });
  if (raw.length <= ATTRIBUTE_VALUE_BUDGET) {
    return { value: raw };
  }
  return {
    value: truncateString(raw, ATTRIBUTE_VALUE_BUDGET),
    truncated: true,
    total_chars: raw.length,
  };
}

// find_in_page size caps. Default 50 matches per call keeps the response under
// the MCP budget even on form-heavy pages where a short needle can match every
// hidden input on the page; per-value truncation at 500 chars catches long
// base64-encoded CSRF blobs or data-config JSON attributes. Agent can raise
// `limit` up to the hard ceiling; values remain capped per-item regardless.
const FIND_IN_PAGE_DEFAULT_LIMIT = 50;
const FIND_IN_PAGE_HARD_MAX = 200;
const FIND_IN_PAGE_VALUE_CAP = 500;

/**
 * Scan the current page for elements whose text content or any attribute value
 * contains `needle`. Returns up to `limit` matches with a selector the caller
 * can plug into a page-extract prereq. Used during discovery to trace opaque
 * values seen in captured request bodies back to their DOM source — the agent
 * sees a value in a POST body it didn't provide, calls `findInPage(session,
 * value)`, and gets back the meta tag / hidden input / data-* attribute that
 * rendered it. The agent is expected to try progressively: the raw value, then
 * shorter substrings (numeric or alphanumeric fragments), then base64-decoded
 * forms.
 */
export async function findInPage(
  sessionId: string,
  needle: string,
  limit?: number,
): Promise<{
  matches: Array<{
    selector: string;
    attr?: string;
    value: string;
    value_truncated?: true;
    value_total_chars?: number;
  }>;
  total_returned: number;
  limit_applied: number;
  matches_truncated?: true;
}> {
  const session = pool.getSession(sessionId);
  const driver = pool.driverFor(sessionId);
  const effectiveLimit = Math.max(
    1,
    Math.min(
      typeof limit === 'number' ? Math.floor(limit) : FIND_IN_PAGE_DEFAULT_LIMIT,
      FIND_IN_PAGE_HARD_MAX,
    ),
  );
  // Ask the driver for one extra so we can tell "hit the cap" apart from "found
  // exactly this many." Driver will return at most limit+1 matches.
  const raw = await driver.findInPage(session, needle, effectiveLimit + 1);
  const matchesTruncated = raw.length > effectiveLimit;
  const capped = matchesTruncated ? raw.slice(0, effectiveLimit) : raw;
  const matches = capped.map((m) => {
    if (typeof m.value === 'string' && m.value.length > FIND_IN_PAGE_VALUE_CAP) {
      return {
        ...m,
        value: truncateString(m.value, FIND_IN_PAGE_VALUE_CAP),
        value_truncated: true as const,
        value_total_chars: m.value.length,
      };
    }
    return m;
  });
  // Record match values + selector strings into the session's observation
  // trace. The agent is searching for a known string and getting back
  // where it lives; both the needle's surrounding context and the matched
  // selector are observation, not contract. See
  // runtime/src/observation-trace.ts.
  recordObservations(session, matches);
  ringPush(ensureAccumulator(session).findInPageCalls, {
    needle_slug: needle.slice(0, 60),
    matches_count: matches.length,
    at: new Date().toISOString(),
  });
  return {
    matches,
    total_returned: matches.length,
    limit_applied: effectiveLimit,
    ...(matchesTruncated ? { matches_truncated: true as const } : {}),
  };
}
