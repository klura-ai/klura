// Convergence signal stamped on every ok:false try_generator(verify_against)
// response. The raw diff already names first_diff_offset + expected_byte +
// got_byte + a hex window — but the agent looking at "1676 vs 1255 bytes,
// first_diff_offset 386" has no felt sense of "am I 1 round from done or 50?"
//
// This module turns the current diff + the per-session ring buffer of recent
// diffs into a normalized progress signal:
//
//   - length_match_pct: how close output length is to expected (1.0 = match)
//   - diff_offset_pct:  how far into the expected payload the divergence is
//                       (1.0 = matches all the way through, but lengths differ)
//   - shape:            envelope_correct (length within 5%, divergence past
//                       the header) | envelope_wrong (large length mismatch
//                       OR header diverges) | partial
//   - progress:         first_iteration | converging | stuck | diverging |
//                       oscillating (computed from recent ring buffer)
//   - iteration:        1-indexed position in this session
//   - hint:             optional one-sentence structural suggestion
//                       (≤200 chars),
//                       rule-based; omitted when no rule matches
//
// The agent reading "iteration 3, length_match_pct: 0.99, shape:
// envelope_correct, progress: converging, hint: 'one byte off in body — check
// epoch_id derivation'" knows they're one fix away. The fold-vs-iterate
// decision flips because the gradient is visible.

import type { RecentDiffEntry } from '../strategies/try-generator-stats';
export interface ConvergenceSignal {
  /** 0..1; 1.0 = exact length match. Computed as
   *  `1 - |output - expected| / max(output, expected)`. */
  length_match_pct: number;
  /** 0..1; first_diff_offset / expected_length. 1.0 = matches all the way
   *  through the expected bytes (length-only mismatch). */
  diff_offset_pct: number;
  /** Structural classification of where the diff sits. */
  shape: 'envelope_correct' | 'envelope_wrong' | 'partial';
  /** Trajectory across recent iterations. */
  progress: 'first_iteration' | 'converging' | 'stuck' | 'diverging' | 'oscillating';
  /** 1-indexed position in this session's verify_against iterations. */
  iteration: number;
  /** Optional structural suggestion, ≤200 chars. Omitted when no rule
   *  matches — a missing hint is better than a noisy one. */
  hint?: string;
}

const HEADER_BYTES = 4;
const ENVELOPE_LENGTH_TOLERANCE_PCT = 0.05;

export function computeConvergence(
  current: { first_diff_offset: number; expected_length: number; output_length: number },
  recent: RecentDiffEntry[],
  iteration: number,
): ConvergenceSignal {
  const lenMax = Math.max(current.expected_length, current.output_length, 1);
  const lengthMatchPct = 1 - Math.abs(current.output_length - current.expected_length) / lenMax;
  const diffOffsetPct =
    current.expected_length > 0
      ? Math.min(1, current.first_diff_offset / current.expected_length)
      : 0;

  // Shape classification — focus on whether the envelope structure is right vs
  // wrong. "Envelope correct, body diverges" is the case where the agent is
  // close to ok:true. "Envelope wrong" means the splice math or framing is off,
  // and the agent should re-read inspect_ws_frame before chasing byte fixes.
  let shape: ConvergenceSignal['shape'];
  if (
    lengthMatchPct < 0.5 ||
    (current.first_diff_offset >= 0 && current.first_diff_offset <= HEADER_BYTES)
  ) {
    shape = 'envelope_wrong';
  } else if (
    lengthMatchPct >= 1 - ENVELOPE_LENGTH_TOLERANCE_PCT &&
    current.first_diff_offset > HEADER_BYTES
  ) {
    shape = 'envelope_correct';
  } else {
    shape = 'partial';
  }

  const progress = classifyProgress(current, recent);

  const signal: ConvergenceSignal = {
    length_match_pct: round2(lengthMatchPct),
    diff_offset_pct: round2(diffOffsetPct),
    shape,
    progress,
    iteration,
  };

  const hint = buildHint(signal, current);
  if (hint) signal.hint = hint;

  return signal;
}

function classifyProgress(
  current: { first_diff_offset: number; expected_length: number; output_length: number },
  recent: RecentDiffEntry[],
): ConvergenceSignal['progress'] {
  const last = recent.length > 0 ? recent[recent.length - 1] : undefined;
  if (!last) return 'first_iteration';

  // Same first_diff_offset as the prior iteration → the change didn't move the
  // needle on byte agreement. Common when the agent toggles a field that
  // doesn't affect the diverging position.
  if (last.first_diff_offset === current.first_diff_offset) return 'stuck';

  // Oscillation: A → B → A pattern over the last 3 iterations. Indicates the
  // agent is bouncing between two competing hypotheses without resolving the
  // underlying structural issue.
  const prev = recent.length >= 2 ? recent[recent.length - 2] : undefined;
  if (
    prev &&
    prev.first_diff_offset === current.first_diff_offset &&
    last.first_diff_offset !== current.first_diff_offset
  ) {
    return 'oscillating';
  }

  // Convergence: divergence offset moved further in (more bytes match before
  // the diff) OR length got closer to the target.
  const offsetMovedRight = current.first_diff_offset > last.first_diff_offset;
  const lengthGotCloser =
    Math.abs(current.output_length - current.expected_length) <
    Math.abs(last.output_length - current.expected_length);
  if (offsetMovedRight || lengthGotCloser) return 'converging';

  // Otherwise the offset moved backwards — diverging.
  return 'diverging';
}

function buildHint(
  signal: ConvergenceSignal,
  current: { first_diff_offset: number; expected_length: number; output_length: number },
): string | undefined {
  if (signal.shape === 'envelope_correct' && signal.length_match_pct >= 0.99) {
    return 'envelope shape correct, divergence past the header — likely a single rotating field (timestamp / sequence id / nonce) not derived correctly';
  }
  if (signal.shape === 'envelope_correct') {
    return 'envelope shape correct (length within 5%); divergence sits in the body — check the bytes around first_diff_offset, usually a length-prefix or field-order issue';
  }
  if (signal.shape === 'envelope_wrong' && current.first_diff_offset <= HEADER_BYTES) {
    return 'header diverges within the first few bytes — your generator is reproducing the wrong envelope shape; re-read inspect_ws_frame for the leading-byte layout before iterating further';
  }
  if (signal.shape === 'envelope_wrong' && signal.length_match_pct < 0.5) {
    const lenDelta = current.output_length - current.expected_length;
    const sign = lenDelta > 0 ? 'over' : 'under';
    return `length is ${sign} by ${Math.abs(lenDelta)} bytes (${Math.round(signal.length_match_pct * 100)}% match) — the structural decoder is wrong, not a byte-level tweak; suspect a missing or duplicated body section`;
  }
  if (signal.progress === 'oscillating') {
    return 'oscillating between two diff offsets — step back and re-read inspect_ws_frame; you may be patching symptoms while a structural issue rotates between two surface positions';
  }
  if (signal.progress === 'stuck') {
    return 'same first_diff_offset as last iteration — the change you made did not affect the diverging byte; check that args.text reaches the right offset before iterating further';
  }
  return undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
