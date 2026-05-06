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

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tool-types';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.getScreenshot,
    description: 'Take a screenshot of the current page. Returns base64-encoded PNG.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
    handler: (args: any) => getScreenshot(args.session_id),
  },

  {
    name: TOOL_NAMES.getAttribute,
    description:
      'Read an attribute off the first element matching a CSS selector — use this to verify that a candidate selector (e.g. a `meta[name=csrf-token]` nonce, a hidden `input[name=authenticity_token]`, a `data-*` attribute) actually exists on the live page before saving it into a strategy. If `attr` is omitted, returns the element\'s text content. Returns `{value: string}` on success; throws if the selector does not resolve (so you can tell "doesn\'t exist" apart from "exists but empty"). Meta tags and other non-a11y elements are not in the accessibility tree — use this tool to read them directly.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        selector: {
          type: 'string',
          description:
            'CSS selector for the element, e.g. "meta[name=csrf-token]", "input[name=authenticity_token]", "[data-token]"',
        },
        attr: {
          type: 'string',
          description:
            'Attribute name to read (e.g. "content", "value"). Omit to read the element\'s text content.',
        },
      },
      required: ['session_id', 'selector'],
    },
    handler: (args: any) => getAttribute(args.session_id, args.selector, args.attr),
  },

  {
    name: TOOL_NAMES.findInPage,
    description:
      "Scan the current page for elements whose text content or any attribute value contains `needle`. Returns up to `limit` matches with a usable CSS selector, the matching attribute (if any), and a truncated value preview. **Use this to trace opaque values you see in captured request bodies back to the DOM that rendered them.** When `get_network_log` shows a POST body with a value you didn't provide (internal IDs, nonces, opaque tokens), call `find_in_page` with that value — you'll usually get back the `<meta>` tag, hidden `<input>`, or `data-*` attribute the web app read it from. Then turn that selector into a `page-extract` prereq. If the exact value isn't found, try progressively: shorter substrings (numeric or alphanumeric fragments from inside the value), then the base64-decoded form, then a decoded substring. Many web apps encode a visible numeric ID into an opaque API ID via a deterministic transform (base64, hex, hash) — when you find the numeric on the page but the opaque form in the body, write a small generator that re-applies the transform.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        needle: {
          type: 'string',
          description:
            'Substring to search for. Try the raw value first; if no match, try shorter substrings or a base64-decoded form.',
        },
        limit: { type: 'number', description: 'Max matches to return. Default 20.' },
      },
      required: ['session_id', 'needle'],
    },
    handler: (args: any) => findInPage(args.session_id, args.needle, args.limit),
  },
];
