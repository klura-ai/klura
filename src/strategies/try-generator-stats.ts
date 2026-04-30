// Per-session call counter for `try_generator`. Drives two related runtime
// behaviours:
//
// 1. `_advisory` on `get_network_log` shows the agent how many times they've
// already iterated this session, so they can self-pace ("you've called
// try_generator(verify_against) 3 times — keep going" vs "0 times — start
// now").
//
// 2. The recent-diffs ring buffer feeds the `convergence` signal the runtime
// stamps on every `try_generator` response — so the agent sees iteration N's
// diff in the context of iterations N-1 / N-2 ("converging", "stuck",
// "oscillating") instead of as a raw byte offset with no gradient.
//
// The counter is per-session and cleared on close_session.

export interface TryGeneratorStats {
  /** Every try_generator call against this session, regardless of args. */
  total: number;
  /** Calls that supplied verify_against (ws_i or base64). */
  with_verify_against: number;
  /** Calls that returned ok: true (with or without verify_against). */
  ok_true: number;
  /** Calls that returned ok: true AND had verify_against — the only count
   *  that actually proves bytes match the captured frame. */
  verified_ok: number;
}

export function emptyStats(): TryGeneratorStats {
  return { total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 };
}

/** A snapshot of one try_generator(verify_against) result for the recent-
 * diffs ring buffer. Stored only when verify_against was supplied AND the call
 * returned ok:false (ok:true clears the agent's iteration; we
 *  only track in-flight iteration progress). */
export interface RecentDiffEntry {
  /** Iteration ordinal in this session — 1-indexed; matches
   *  `attempt_in_session` stamped on the try_generator response. */
  attempt: number;
  /** First byte offset where output and expected diverge. */
  first_diff_offset: number;
  /** Total bytes in the captured (expected) payload. */
  expected_length: number;
  /** Total bytes the generator produced. */
  output_length: number;
}

export const RECENT_DIFFS_RING_SIZE = 5;
