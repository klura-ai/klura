// Structural-dead-end hard bounce: after the 3rd same-family save_strategy
// rejection for one capability, the runtime returns a structural_dead_end
// instead of echoing the same audit prose, forcing the agent to defer /
// switch tier / abort.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { trackRejectionAndMaybeBounce, rejectionFamilyKey, DEAD_END_THRESHOLD } =
  await import('../dist/audit/lift/save-rejection-bounce.js');

function rej(kinds, reason = 'unacked_warnings') {
  return { reason, warnings: kinds.map((k) => ({ kind: k, message: k })) };
}

test('rejectionFamilyKey is stable for the same set of kinds (order-independent)', () => {
  assert.equal(rejectionFamilyKey(rej(['a', 'b'])), rejectionFamilyKey(rej(['b', 'a'])));
});

test('rejectionFamilyKey folds in classifier item kinds', () => {
  const r = { reason: 'answers_inconsistent', warnings: [], items: { literal_provenance: {} } };
  assert.match(rejectionFamilyKey(r), /literal_provenance/);
});

test('invalid_shape collapses to a single family', () => {
  assert.equal(rejectionFamilyKey({ reason: 'invalid_shape', warnings: [] }), 'invalid_shape');
});

test('3rd same-family rejection bounces; first two do not', () => {
  const session = {};
  const normal = 'invalid_strategy: the real rejection text';
  const r = rej(['response_from_binding']);
  assert.equal(trackRejectionAndMaybeBounce(session, 'search_products', r, normal), null, '1st');
  assert.equal(trackRejectionAndMaybeBounce(session, 'search_products', r, normal), null, '2nd');
  const third = trackRejectionAndMaybeBounce(session, 'search_products', r, normal);
  assert.ok(third, '3rd returns a bounce message');
  assert.match(third, /save_strategy_structural_dead_end/);
  assert.match(third, /search_products/);
  assert.match(third, /add_discovery_note/);
  assert.match(third, /abort_session/);
  assert.match(third, /the real rejection text/, 'embeds the underlying rejection for context');
});

test('a different rejection family gets its own fresh budget', () => {
  const session = {};
  const normal = 'invalid_strategy: x';
  const famA = rej(['enum_grounding']);
  const famB = rej(['mutating_verification_required']);
  // Hit family A twice...
  trackRejectionAndMaybeBounce(session, 'cap', famA, normal);
  trackRejectionAndMaybeBounce(session, 'cap', famA, normal);
  // ...family B once — should NOT bounce (independent counter).
  assert.equal(trackRejectionAndMaybeBounce(session, 'cap', famB, normal), null);
});

test('the same family on a different capability has an independent counter', () => {
  const session = {};
  const normal = 'invalid_strategy: x';
  const r = rej(['enum_grounding']);
  trackRejectionAndMaybeBounce(session, 'cap_one', r, normal);
  trackRejectionAndMaybeBounce(session, 'cap_one', r, normal);
  assert.equal(trackRejectionAndMaybeBounce(session, 'cap_two', r, normal), null);
});

test('no session (programmatic save) never bounces', () => {
  const r = rej(['enum_grounding']);
  for (let i = 0; i < DEAD_END_THRESHOLD + 2; i += 1) {
    assert.equal(trackRejectionAndMaybeBounce(null, 'cap', r, 'msg'), null);
  }
});
