// extractEnumValuesFromListing turns a source-capability's listing response into
// {value, label} tuples for dynamic enum resolution. The parallel-array case —
// an HTML listing extracted via two `multiple:true` selectors → {values:[…],
// labels:[…]} — must pair labels by index instead of discarding them.

import test from 'node:test';
import assert from 'node:assert/strict';

const { extractEnumValuesFromListing } = await import('../dist/execution/index.js');

test('array of {value,label} objects → preserved', () => {
  assert.deepEqual(
    extractEnumValuesFromListing([
      { value: 'italian', label: 'Italian' },
      { value: 'sushi', label: 'Sushi' },
    ]),
    [
      { value: 'italian', label: 'Italian' },
      { value: 'sushi', label: 'Sushi' },
    ],
  );
});

test('wrapped array of objects ({categories:[{value,label}]})', () => {
  assert.deepEqual(
    extractEnumValuesFromListing({ categories: [{ value: 'a', label: 'A' }] }),
    [{ value: 'a', label: 'A' }],
  );
});

test('parallel bare-string arrays → labels paired by index from the label-named array', () => {
  const out = extractEnumValuesFromListing({
    categories: ['mexican', 'italian', 'sushi'],
    labels: ['Mexican', 'Italian', 'Sushi'],
  });
  assert.deepEqual(out, [
    { value: 'mexican', label: 'Mexican' },
    { value: 'italian', label: 'Italian' },
    { value: 'sushi', label: 'Sushi' },
  ]);
});

test('parallel arrays of unequal length → no risky pairing (label defaults to value)', () => {
  const out = extractEnumValuesFromListing({
    categories: ['mexican', 'italian'],
    labels: ['Mexican'], // length mismatch — must not pair
  });
  assert.deepEqual(out, [
    { value: 'mexican', label: 'mexican' },
    { value: 'italian', label: 'italian' },
  ]);
});

test('sibling array without a label-shaped key name → not paired (values unchanged)', () => {
  // `ids` is not label-shaped, so it must not be treated as labels.
  const out = extractEnumValuesFromListing({
    categories: ['mexican', 'italian'],
    ids: ['7', '9'],
  });
  assert.deepEqual(out, [
    { value: 'mexican', label: 'mexican' },
    { value: 'italian', label: 'italian' },
  ]);
});

test('bare string array (no labels) → value === label', () => {
  assert.deepEqual(extractEnumValuesFromListing(['a', 'b']), [
    { value: 'a', label: 'a' },
    { value: 'b', label: 'b' },
  ]);
});
