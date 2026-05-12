// Enumerate every string-valued query/body param on a captured request.
// No shape heuristic — runtime records what was observed; the agent
// decides at save time which params are enums via `notes.params.X.kind`.
// Dedupe + per-param caps in session-observations keep memory bounded.
//
// Lives at the response layer (not `tools/`) because both the
// observation-recording pipeline (`session-observations.ts`) and the
// `perform_action` tool consume it; keeping it dependency-free avoids the
// circular import that pulls pool/skills into the observation layer.

import type { InterceptedRequest } from '../drivers/types/network';

export function* enumerateStringParams(request: InterceptedRequest): Generator<[string, string]> {
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
