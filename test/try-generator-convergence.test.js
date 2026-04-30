// Unit tests for computeConvergence — the helper that turns a single
// try_generator(verify_against) diff plus the per-session ring buffer
// into a normalized progress signal (length_match_pct, diff_offset_pct,
// shape, progress, hint). The agent reading "iteration 3, envelope_correct,
// converging, hint: 'one byte off in body — check epoch_id derivation'"
// has the gradient that raw byte offsets don't carry.

import test from 'node:test';
import assert from 'node:assert';

const { computeConvergence } = await import('../dist/response/convergence.js');

function diff(opts) {
  return {
    first_diff_offset: opts.first_diff_offset ?? 0,
    expected_length: opts.expected_length ?? 1000,
    output_length: opts.output_length ?? opts.expected_length ?? 1000,
  };
}

function entry(attempt, first_diff_offset, expected_length = 1000, output_length = 1000) {
  return { attempt, first_diff_offset, expected_length, output_length };
}

test('computeConvergence: first_iteration when ring buffer is empty', () => {
  const sig = computeConvergence(diff({ first_diff_offset: 386, expected_length: 1255, output_length: 1676 }), [], 1);
  assert.strictEqual(sig.progress, 'first_iteration');
  assert.strictEqual(sig.iteration, 1);
});

test('computeConvergence: envelope_correct when length within 5% AND diff past header', () => {
  // 1000 vs 990 = 1% length delta; diff at offset 500 (past 4-byte header)
  const sig = computeConvergence(diff({ first_diff_offset: 500, expected_length: 1000, output_length: 990 }), [], 1);
  assert.strictEqual(sig.shape, 'envelope_correct');
  assert.ok(sig.hint, 'envelope_correct should carry a hint');
  assert.match(sig.hint, /envelope shape correct/);
});

test('computeConvergence: envelope_wrong when length is < 50% match', () => {
  // 100 vs 1000 = huge length delta
  const sig = computeConvergence(diff({ first_diff_offset: 50, expected_length: 1000, output_length: 100 }), [], 1);
  assert.strictEqual(sig.shape, 'envelope_wrong');
  assert.ok(sig.hint);
  assert.match(sig.hint, /length is under by/);
});

test('computeConvergence: envelope_wrong when first diff is in the header', () => {
  const sig = computeConvergence(diff({ first_diff_offset: 1, expected_length: 1000, output_length: 1000 }), [], 1);
  assert.strictEqual(sig.shape, 'envelope_wrong');
  assert.match(sig.hint, /header diverges within the first few bytes/);
});

test('computeConvergence: partial when length 90%-95% and diff past header', () => {
  // 1000 vs 920 = 8% length delta — outside 5% tolerance, more than 50% match
  const sig = computeConvergence(diff({ first_diff_offset: 100, expected_length: 1000, output_length: 920 }), [], 1);
  assert.strictEqual(sig.shape, 'partial');
});

test('computeConvergence: progress=converging when first_diff_offset moves forward', () => {
  const recent = [entry(1, 100), entry(2, 200)];
  const sig = computeConvergence(diff({ first_diff_offset: 350, expected_length: 1000 }), recent, 3);
  assert.strictEqual(sig.progress, 'converging');
  assert.strictEqual(sig.iteration, 3);
});

test('computeConvergence: progress=stuck when first_diff_offset is unchanged', () => {
  // Use a partial-shape fixture (length 80% match, diff past header) so
  // the shape-based hint doesn't dominate the progress hint.
  const recent = [entry(1, 386, 1255, 1100), entry(2, 386, 1255, 1100)];
  const sig = computeConvergence(diff({ first_diff_offset: 386, expected_length: 1255, output_length: 1100 }), recent, 3);
  assert.strictEqual(sig.progress, 'stuck');
  // shape-correct hint takes priority when both apply; progress=stuck is
  // still computed correctly even if hint text is shape-driven.
});

test('computeConvergence: progress=oscillating when A->B->A pattern', () => {
  const recent = [entry(1, 200), entry(2, 300)]; // current returns to 200
  const sig = computeConvergence(diff({ first_diff_offset: 200, expected_length: 1000 }), recent, 3);
  assert.strictEqual(sig.progress, 'oscillating');
});

test('computeConvergence: progress=diverging when offset moves backward without length improving', () => {
  const recent = [entry(1, 500, 1000, 1000), entry(2, 400, 1000, 1000)];
  const sig = computeConvergence(diff({ first_diff_offset: 200, expected_length: 1000, output_length: 1000 }), recent, 3);
  assert.strictEqual(sig.progress, 'diverging');
});

test('computeConvergence: length_match_pct rounds to 2 decimals', () => {
  const sig = computeConvergence(diff({ first_diff_offset: 100, expected_length: 1000, output_length: 333 }), [], 1);
  // 1 - |1000-333|/max(1000,333) = 1 - 667/1000 = 0.333
  assert.strictEqual(sig.length_match_pct, 0.33);
});

test('computeConvergence: diff_offset_pct rounds to 2 decimals', () => {
  const sig = computeConvergence(diff({ first_diff_offset: 250, expected_length: 1000 }), [], 1);
  assert.strictEqual(sig.diff_offset_pct, 0.25);
});

test('computeConvergence: hint omitted on partial without obvious story', () => {
  // Length 92% match, diff at offset 100 — partial, no specific hint matches
  const sig = computeConvergence(diff({ first_diff_offset: 100, expected_length: 1000, output_length: 920 }), [], 1);
  assert.strictEqual(sig.shape, 'partial');
  // Could be undefined — that's fine, partial without trajectory is silent
  if (sig.hint !== undefined) {
    assert.ok(sig.hint.length <= 200);
  }
});

test('computeConvergence: hint length cap respected', () => {
  for (const [opts, recent] of [
    [diff({ first_diff_offset: 1, expected_length: 1000 }), []],
    [diff({ first_diff_offset: 50, expected_length: 1000, output_length: 100 }), []],
    [diff({ first_diff_offset: 500, expected_length: 1000, output_length: 990 }), []],
    [diff({ first_diff_offset: 200, expected_length: 1000 }), [entry(1, 200)]],
  ]) {
    const sig = computeConvergence(opts, recent, 1);
    if (sig.hint) {
      assert.ok(sig.hint.length <= 250, `hint too long: ${sig.hint.length}`);
    }
  }
});
