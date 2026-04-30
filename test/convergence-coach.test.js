// Convergence signal shape classification.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeConvergence } = await import('../dist/response/convergence.js');

test('shape: envelope_correct when length matches and diff is past header', () => {
  const sig = computeConvergence(
    { first_diff_offset: 350, expected_length: 1254, output_length: 1254 },
    [],
    1,
  );
  assert.equal(sig.shape, 'envelope_correct');
});

test('shape: envelope_wrong when header diverges', () => {
  const sig = computeConvergence(
    { first_diff_offset: 2, expected_length: 1254, output_length: 1254 },
    [
      { first_diff_offset: 2, expected_length: 1254, output_length: 1254 },
      { first_diff_offset: 2, expected_length: 1254, output_length: 1254 },
    ],
    3,
  );
  assert.equal(sig.shape, 'envelope_wrong');
});

test('shape: not envelope_correct when lengths differ significantly', () => {
  const sig = computeConvergence(
    { first_diff_offset: 500, expected_length: 1254, output_length: 1000 },
    [
      { first_diff_offset: 500, expected_length: 1254, output_length: 900 },
      { first_diff_offset: 500, expected_length: 1254, output_length: 950 },
    ],
    3,
  );
  assert.notEqual(sig.shape, 'envelope_correct');
});
