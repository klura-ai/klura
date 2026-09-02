// Dot-path walking over parsed JSON. Dependency-free so both the HTML
// extractor (`response/html-extract.ts`) and the request-side variable
// resolver (`execution/vars.ts`) can share one path grammar.
//
// Grammar — three segment forms, freely mixed:
//   bare key      `data`, `node_id`          up to the next `.` or `[`
//   array index   `[0]`, `items[2][1]`       digits in brackets
//   quoted key    `["webapp.user-detail"]`   for keys that contain `.` or `[`
//
// So `data.items[0].node_id` and `__DEFAULT_SCOPE__["webapp.user-detail"].user`
// both parse. Quoted keys are what make rehydration blobs addressable — sites
// routinely namespace scope keys with dots, and a bare split would shred them
// into segments that resolve to nothing. Single or double quotes; `\"` escapes.
// An empty path means "the value itself".

interface PathSegment {
  key: string;
  /** True for `[0]`-style numeric indices, which only apply to arrays. */
  index: boolean;
}

/**
 * Split a path into segments. Returns null when the path is malformed (an
 * unterminated bracket or quote), which callers surface as "did not resolve"
 * rather than guessing at the author's intent.
 */
function parsePath(path: string): PathSegment[] | null {
  const segments: PathSegment[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') {
      i += 1;
      continue;
    }
    if (path[i] === '[') {
      const quote = path[i + 1];
      if (quote === '"' || quote === "'") {
        let key = '';
        let j = i + 2;
        while (j < path.length && path[j] !== quote) {
          if (path[j] === '\\' && j + 1 < path.length) {
            key += path.charAt(j + 1);
            j += 2;
            continue;
          }
          key += path.charAt(j);
          j += 1;
        }
        if (j >= path.length || path[j + 1] !== ']') return null;
        segments.push({ key, index: false });
        i = j + 2;
        continue;
      }
      const close = path.indexOf(']', i);
      if (close === -1) return null;
      const digits = path.slice(i + 1, close);
      if (!/^\d+$/.test(digits)) return null;
      segments.push({ key: digits, index: true });
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j += 1;
    segments.push({ key: path.slice(i, j), index: false });
    i = j;
  }
  return segments;
}

/**
 * Walk a path into a parsed JSON value and return the raw value found there,
 * or `undefined` when any segment fails to resolve. An empty path returns
 * `value` unchanged.
 *
 * Returns the value AS-IS — objects, arrays, numbers, booleans, and `null`
 * all pass through. Callers that need a string should use `extractByPath`
 * in `execution/vars.ts`, which coerces scalars and drops everything else.
 */
export function extractRawByPath(value: unknown, path: string): unknown {
  if (path.length === 0) return value;
  const segments = parsePath(path);
  if (segments === null) return undefined;
  let cur: unknown = value;
  for (const segment of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (segment.index) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(segment.key)];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment.key];
  }
  return cur;
}
