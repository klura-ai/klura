// Structural match for try_generator / try_generator_in_page.
//
// Byte-perfect match demands an agent reproduce every field (including optional
// ones), every length varint, every key-ordering choice the captured encoder
// happened to make. For complex nested envelopes (outer JSON
// whose `payload` is itself stringified JSON with its own stringified payload
// inside), that's a steep convergence hill — the benchmark took ~30 rounds just
// to figure out which optional field made the frame 8 bytes longer than the
// reference.
//
// Structural match answers a narrower question: "do both sides parse to the
// same SHAPE of data?" — same top-level keys, same value types at every path,
// same nesting structure. Values are compared by type only (two different
// thread_ids of the same type both "match" structurally). Optional-field drift
// and key-ordering become noise.
//
// Limitations intentional: - JSON-only. Binary-only envelopes (protobuf without
// json text, raw MQTT control frames) fall back to byte mode — structural match
// is explicitly opt-in via `match: "structural"`. - Length-varint prefixes in
// MQTT-style envelopes are skipped: we extract the first `{` to last `}`
// substring and parse from there. Agents that need byte-exact framing should
// stay on `match: "bytes"`.
export interface StructuralMatchResult {
  ok: boolean;
  /** When ok=false: path to the first shape divergence, plus `expected`
   *  and `got` type labels at that path. When ok=true: undefined. */
  diff?: {
    path: string;
    expected_type: string;
    got_type: string;
  };
  /** Info block that piggybacks on the generator response so the agent
   *  can decide whether the structural match is good enough to save
   *  (likely yes if the envelope was the whole problem) or whether to
   *  keep iterating on bytes. */
  info?: {
    kind: 'structural_match' | 'structural_mismatch' | 'no_json_found';
    expected_json_bytes?: number;
    got_json_bytes?: number;
    depth_compared?: number;
  };
}

/** Extract the longest parseable JSON substring from an arbitrary bytes
 * buffer. Returns null if nothing parses. Strategy: find the first `{` or `[`,
 * try to parse from there to the end; on failure, narrow the right boundary one
 * byte at a time. Linear-ish in the common case
 *  (the outer `}`/`]` terminates the JSON span). */
function extractJson(buf: Uint8Array): unknown {
  // Decode UTF-8; non-UTF-8 bytes short-circuit. Use TextDecoder in 'fatal'
  // mode to reject silently on binary junk.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } catch {
    return null;
  }
  // Find first `{` or `[`.
  const start = Math.min(
    ...['{', '['].map((c) => {
      const i = text.indexOf(c);
      return i < 0 ? Number.POSITIVE_INFINITY : i;
    }),
  );
  if (!Number.isFinite(start)) return null;
  // Find matching closer by scanning forward with a depth counter. Bails out on
  // the first balanced sequence.
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Unwrap strings that parse as JSON (nested envelopes encode inner payloads as stringified JSON).
 *  Recursive. Idempotent on already-parsed values. */
function unwrapEscapedJson(v: unknown, depth: number = 0): unknown {
  if (depth > 10) return v; // bounded recursion
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return unwrapEscapedJson(parsed, depth + 1);
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) {
    return v.map((x) => unwrapEscapedJson(x, depth + 1));
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = unwrapEscapedJson(val, depth + 1);
    }
    return out;
  }
  return v;
}

function typeLabel(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Structural compare two parsed JSON values. Depth-first; stops at the
 * first mismatch. Arrays compared length-matches + element-type-matches.
 *  Objects compared key-set-matches + value-type-matches per key. */
function compareShape(
  expected: unknown,
  got: unknown,
  path: string = '$',
):
  | { ok: true; depth: number }
  | { ok: false; path: string; expected_type: string; got_type: string } {
  const eType = typeLabel(expected);
  const gType = typeLabel(got);
  if (eType !== gType) {
    return { ok: false, path, expected_type: eType, got_type: gType };
  }
  if (eType === 'array') {
    const ea = expected as unknown[];
    const ga = got as unknown[];
    if (ea.length !== ga.length) {
      return {
        ok: false,
        path: `${path}.length`,
        expected_type: `array[${ea.length}]`,
        got_type: `array[${ga.length}]`,
      };
    }
    let maxDepth = 0;
    for (let i = 0; i < ea.length; i += 1) {
      const r = compareShape(ea[i], ga[i], `${path}[${i}]`);
      if (!r.ok) return r;
      maxDepth = Math.max(maxDepth, r.depth);
    }
    return { ok: true, depth: maxDepth + 1 };
  }
  if (eType === 'object') {
    const eo = expected as Record<string, unknown>;
    const go = got as Record<string, unknown>;
    const eKeys = new Set(Object.keys(eo));
    const gKeys = new Set(Object.keys(go));
    for (const k of eKeys) {
      if (!gKeys.has(k)) {
        return {
          ok: false,
          path: `${path}.${k}`,
          expected_type: typeLabel(eo[k]),
          got_type: 'missing',
        };
      }
    }
    for (const k of gKeys) {
      if (!eKeys.has(k)) {
        return {
          ok: false,
          path: `${path}.${k}`,
          expected_type: 'missing',
          got_type: typeLabel(go[k]),
        };
      }
    }
    let maxDepth = 0;
    for (const k of eKeys) {
      const r = compareShape(eo[k], go[k], `${path}.${k}`);
      if (!r.ok) return r;
      maxDepth = Math.max(maxDepth, r.depth);
    }
    return { ok: true, depth: maxDepth + 1 };
  }
  // Primitives: type already matched — value difference is OK in structural
  // mode.
  return { ok: true, depth: 0 };
}

/**
 * Top-level: does `got` match `expected` structurally? Extracts JSON from each
 * side (handling nested envelopes by searching for the first JSON object/array),
 * unwraps any nested escaped-JSON strings, and compares shapes.
 */
export function structuralMatch(expected: Uint8Array, got: Uint8Array): StructuralMatchResult {
  const eJson = extractJson(expected);
  const gJson = extractJson(got);
  if (eJson === null || gJson === null) {
    return {
      ok: false,
      info: {
        kind: 'no_json_found',
        expected_json_bytes: eJson === null ? 0 : expected.byteLength,
        got_json_bytes: gJson === null ? 0 : got.byteLength,
      },
    };
  }
  const eUnwrapped = unwrapEscapedJson(eJson);
  const gUnwrapped = unwrapEscapedJson(gJson);
  const cmp = compareShape(eUnwrapped, gUnwrapped);
  if (cmp.ok) {
    return {
      ok: true,
      info: {
        kind: 'structural_match',
        expected_json_bytes: expected.byteLength,
        got_json_bytes: got.byteLength,
        depth_compared: cmp.depth,
      },
    };
  }
  return {
    ok: false,
    diff: {
      path: cmp.path,
      expected_type: cmp.expected_type,
      got_type: cmp.got_type,
    },
    info: {
      kind: 'structural_mismatch',
      expected_json_bytes: expected.byteLength,
      got_json_bytes: got.byteLength,
    },
  };
}
