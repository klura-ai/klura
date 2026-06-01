// normalizeEnumArgCasing: case-only normalization of a caller's enum arg to the
// observed value's exact casing, so warm-execute sends the API's value
// ("Italian" → observed "italian") instead of failing the unobserved-enum check.

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeEnumArgCasing } = await import('../dist/execution/index.js');

function strat(observed) {
  return {
    strategy: 'fetch',
    endpoint: '/api/restaurants?category={{category}}',
    notes: { params: { category: { kind: 'enum', observed_values: observed } } },
  };
}

test('title-cased caller value is normalized to the observed lowercase slug', () => {
  const args = { category: 'Italian' };
  normalizeEnumArgCasing(
    strat([{ value: 'italian', label: 'Taste the pride of Napoli' }, { value: 'mexican', label: 'Taco-tuesday' }]),
    args,
  );
  assert.equal(args.category, 'italian');
});

test('exact match is left untouched', () => {
  const args = { category: 'italian' };
  normalizeEnumArgCasing(strat([{ value: 'italian', label: 'x' }, { value: 'mexican', label: 'y' }]), args);
  assert.equal(args.category, 'italian');
});

test('a value with no case-insensitive match is left untouched (still flags as unobserved)', () => {
  const args = { category: 'pizza' };
  normalizeEnumArgCasing(strat([{ value: 'italian', label: 'x' }, { value: 'mexican', label: 'y' }]), args);
  assert.equal(args.category, 'pizza');
});

test('ambiguous case-insensitive collision is left untouched', () => {
  const args = { category: 'ABC' };
  normalizeEnumArgCasing(strat([{ value: 'abc', label: 'x' }, { value: 'Abc', label: 'y' }]), args);
  assert.equal(args.category, 'ABC');
});

test('non-enum params are ignored', () => {
  const args = { q: 'Hello' };
  normalizeEnumArgCasing(
    { strategy: 'fetch', endpoint: '/s?q={{q}}', notes: { params: { q: { kind: 'text' } } } },
    args,
  );
  assert.equal(args.q, 'Hello');
});
