// Pure byte-diff helper for the `try_generator` tool. Given two byte arrays
// (expected = captured ground truth; got = candidate generator output), report
// whether they match, and if not, where the first divergence is plus a small
// hex-window of context on each side.
//
// Kept in `response/` and deliberately dependency-free so unit tests can
// exercise the diff without spinning up a pool, a vm, or an MCP tool.

const DIFF_CONTEXT_BYTES = 16;

export interface GeneratorDiff {
  ok: boolean;
  expected_length: number;
  got_length: number;
  /** Byte index of the first mismatch. Absent when ok:true. For length
   *  mismatches with a common prefix, points at the first byte past the
   *  shorter side. */
  first_diff_offset?: number;
  /** Expected byte value at `first_diff_offset` (0–255). Absent when the
   *  mismatch is purely "one side is longer". */
  expected_byte?: number;
  /** Generator-output byte value at `first_diff_offset` (0–255). Absent
   *  when the mismatch is purely "one side is longer". */
  got_byte?: number;
  /** Small hex window around the first_diff_offset: DIFF_CONTEXT_BYTES
   *  before + the divergent byte itself + DIFF_CONTEXT_BYTES after.
   *  Each side returned as space-separated lowercase hex pairs so the
   *  agent can scan them in the MCP response. */
  diff_context?: {
    expected: string;
    got: string;
  };
}

/**
 * Compare two byte buffers. On match returns `{ok: true, ...lengths}`; on
 * mismatch returns `{ok: false, first_diff_offset, diff_context, ...}` with
 * enough context for an LLM to patch its generator without re- capturing the
 * frame. Treats truncation as a divergence: if the two buffers share a common
 * prefix but differ in length, the diff offset equals the shorter side's
 * length.
 */
export function diffBinary(expected: Uint8Array, got: Uint8Array): GeneratorDiff {
  const minLen = Math.min(expected.length, got.length);
  let firstDiff = -1;
  for (let i = 0; i < minLen; i += 1) {
    if (expected[i] !== got[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1 && expected.length === got.length) {
    return { ok: true, expected_length: expected.length, got_length: got.length };
  }
  const offset = firstDiff === -1 ? minLen : firstDiff;
  const base: GeneratorDiff = {
    ok: false,
    expected_length: expected.length,
    got_length: got.length,
    first_diff_offset: offset,
    diff_context: {
      expected: hexWindow(expected, offset),
      got: hexWindow(got, offset),
    },
  };
  // When the mismatch is "one side is shorter" rather than a bit diff, at least
  // one of the two bytes at the offset is undefined — leave expected_byte /
  // got_byte unset in that case.
  const ex = expected[offset];
  const gt = got[offset];
  if (ex !== undefined) base.expected_byte = ex;
  if (gt !== undefined) base.got_byte = gt;
  return base;
}

function hexWindow(buf: Uint8Array, offset: number): string {
  const start = Math.max(0, offset - DIFF_CONTEXT_BYTES);
  const end = Math.min(buf.length, offset + DIFF_CONTEXT_BYTES + 1);
  const parts: string[] = [];
  for (let i = start; i < end; i += 1) {
    const b = buf[i];
    if (b === undefined) continue;
    parts.push(b.toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}
