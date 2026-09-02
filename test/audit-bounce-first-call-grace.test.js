// The save-rejection bounce's one-time per-family grace for first-call
// answers.
//
// Before `audit.firstCallAnswers`, round 1 of a save loop was always free:
// a token-less call could only be rejected `pending`, and `pending` yields no
// family key. Once a first call may carry answers, that same call can be
// rejected `answers_inconsistent` — a substantive reason — so the agent would
// silently spend one of its three strikes on a round it had no way to know was
// being scored.
//
// The fix must satisfy three constraints at once, and these tests pin all
// three:
//   1. `answers_inconsistent` stays substantive. Adding it to
//      NON_SUBSTANTIVE_REASONS would gut the bounce entirely.
//   2. Token-less calls are NOT unconditionally exempt. An agent that never
//      echoes a token would otherwise loop forever.
//   3. The grace is ONE per family. Omitting the token again buys nothing —
//      this is the farm-proofing pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { trackRejectionAndMaybeBounce, rejectionFamilyKey, resetSaveRejectionFamilies, DEAD_END_THRESHOLD } =
  await import('../dist/audit/lift/save-rejection-bounce.js');

const FETCH = { strategy: 'fetch' };
const NORMAL = 'invalid_strategy: the normal audit rejection prose';

/** An `answers_inconsistent` rejection whose active component is `kind`.
 *  `firstCall` stamps the `first_call_answers` marker the audit sets when the
 *  call carried answers but no token. */
function inconsistent(kind, { firstCall = false } = {}) {
  return {
    reason: 'answers_inconsistent',
    warnings: [],
    items: { [kind]: [{ path: 'endpoint' }] },
    classifier_issues: [`${kind}["endpoint"] is not consistent with the payload`],
    ...(firstCall ? { first_call_answers: true } : {}),
  };
}

// ---------- the reason stays substantive ----------

test('answers_inconsistent still yields a family key — it is NOT exempted wholesale', () => {
  assert.ok(rejectionFamilyKey(inconsistent('literal_provenance'), 'fetch'));
  assert.ok(rejectionFamilyKey(inconsistent('literal_provenance', { firstCall: true }), 'fetch'));
  // The marker must not change which family the rejection belongs to —
  // otherwise the graced round and the counted rounds would land in different
  // buckets and the budget would double.
  assert.equal(
    rejectionFamilyKey(inconsistent('literal_provenance', { firstCall: true }), 'fetch'),
    rejectionFamilyKey(inconsistent('literal_provenance'), 'fetch'),
  );
});

// ---------- the grace ----------

test('the first token-less answers_inconsistent in a family is free', () => {
  const session = {};
  assert.equal(
    trackRejectionAndMaybeBounce(
      session,
      'cap',
      FETCH,
      inconsistent('literal_provenance', { firstCall: true }),
      NORMAL,
    ),
    null,
  );
  // The graced round left the family on record with a zero count, so the
  // budget that follows is the full one.
  for (let i = 1; i < DEAD_END_THRESHOLD; i++) {
    assert.equal(
      trackRejectionAndMaybeBounce(session, 'cap', FETCH, inconsistent('literal_provenance'), NORMAL),
      null,
      `rejection ${i} after the grace must not bounce`,
    );
  }
  assert.ok(
    trackRejectionAndMaybeBounce(session, 'cap', FETCH, inconsistent('literal_provenance'), NORMAL),
    'the budget after the grace must be exactly DEAD_END_THRESHOLD',
  );
});

test('FARM-PROOFING: repeated token omission does not buy unlimited free rounds', () => {
  // Every call is a first-call-answers rejection in the same family — the
  // shape an agent would produce by never echoing the token. Only the first
  // is graced; the rest count normally, so the bounce still fires.
  const session = {};
  const results = [];
  for (let i = 0; i < DEAD_END_THRESHOLD + 1; i++) {
    results.push(
      trackRejectionAndMaybeBounce(
        session,
        'cap',
        FETCH,
        inconsistent('literal_provenance', { firstCall: true }),
        NORMAL,
      ),
    );
  }
  const bounced = results.findIndex((r) => r !== null);
  assert.equal(
    bounced,
    DEAD_END_THRESHOLD,
    `expected the bounce on call ${DEAD_END_THRESHOLD + 1} (one grace + ${DEAD_END_THRESHOLD} counted); got ${JSON.stringify(results.map(Boolean))}`,
  );
  assert.match(results[bounced], /save_strategy_structural_dead_end/);

  // And it keeps bouncing — the grace can never be re-earned by omitting the
  // token again.
  for (let i = 0; i < 5; i++) {
    assert.ok(
      trackRejectionAndMaybeBounce(
        session,
        'cap',
        FETCH,
        inconsistent('literal_provenance', { firstCall: true }),
        NORMAL,
      ),
      'a spent grace stays spent',
    );
  }
});

test('the grace is per family — a different family earns its own', () => {
  const session = {};
  assert.equal(
    trackRejectionAndMaybeBounce(
      session,
      'cap',
      FETCH,
      inconsistent('literal_provenance', { firstCall: true }),
      NORMAL,
    ),
    null,
  );
  assert.equal(
    trackRejectionAndMaybeBounce(
      session,
      'cap',
      FETCH,
      inconsistent('observed_property_keys', { firstCall: true }),
      NORMAL,
    ),
    null,
    'a fresh family gets its own grace',
  );
  // …and each family's post-grace budget is independent.
  for (let i = 1; i < DEAD_END_THRESHOLD; i++) {
    trackRejectionAndMaybeBounce(session, 'cap', FETCH, inconsistent('literal_provenance'), NORMAL);
  }
  assert.ok(
    trackRejectionAndMaybeBounce(session, 'cap', FETCH, inconsistent('literal_provenance'), NORMAL),
  );
  assert.equal(
    trackRejectionAndMaybeBounce(
      session,
      'cap',
      FETCH,
      inconsistent('observed_property_keys'),
      NORMAL,
    ),
    null,
    'the sibling family is untouched by the first family exhausting its budget',
  );
});

test('the grace is per capability', () => {
  const session = {};
  trackRejectionAndMaybeBounce(
    session,
    'cap_one',
    FETCH,
    inconsistent('literal_provenance', { firstCall: true }),
    NORMAL,
  );
  assert.equal(
    trackRejectionAndMaybeBounce(
      session,
      'cap_two',
      FETCH,
      inconsistent('literal_provenance', { firstCall: true }),
      NORMAL,
    ),
    null,
  );
  assert.equal(
    trackRejectionAndMaybeBounce(session, 'cap_two', FETCH, inconsistent('literal_provenance'), NORMAL),
    null,
    'cap_two is on its first counted rejection, not inheriting cap_one bookkeeping',
  );
});

test('a token-bearing answers_inconsistent counts from the very first one', () => {
  // No `first_call_answers` marker → the agent had a token in hand and knew
  // the attempt was being scored. No grace.
  const session = {};
  for (let i = 1; i < DEAD_END_THRESHOLD; i++) {
    assert.equal(
      trackRejectionAndMaybeBounce(session, 'cap', FETCH, inconsistent('literal_provenance'), NORMAL),
      null,
    );
  }
  assert.ok(
    trackRejectionAndMaybeBounce(session, 'cap', FETCH, inconsistent('literal_provenance'), NORMAL),
  );
});

test('the grace does not apply once the family already has counted rejections', () => {
  // A token-bearing rejection lands first, then the agent drops the token.
  // The family is already on record, so the late first-call rejection counts.
  const session = {};
  trackRejectionAndMaybeBounce(session, 'cap', FETCH, inconsistent('literal_provenance'), NORMAL);
  trackRejectionAndMaybeBounce(session, 'cap', FETCH, inconsistent('literal_provenance'), NORMAL);
  assert.ok(
    trackRejectionAndMaybeBounce(
      session,
      'cap',
      FETCH,
      inconsistent('literal_provenance', { firstCall: true }),
      NORMAL,
    ),
    'a first-call rejection arriving 3rd in an established family must still bounce',
  );
});

test('resetSaveRejectionFamilies clears the spent grace along with the counts', () => {
  const session = {};
  trackRejectionAndMaybeBounce(
    session,
    'cap',
    FETCH,
    inconsistent('literal_provenance', { firstCall: true }),
    NORMAL,
  );
  assert.deepEqual(Object.keys(session.saveRejectionFamilyCounts).length, 1);
  resetSaveRejectionFamilies(session, 'cap');
  assert.deepEqual(session.saveRejectionFamilyCounts, {});
  // A re-planned capability earns a fresh grace.
  assert.equal(
    trackRejectionAndMaybeBounce(
      session,
      'cap',
      FETCH,
      inconsistent('literal_provenance', { firstCall: true }),
      NORMAL,
    ),
    null,
  );
});

test('a spent grace survives a reset scoped to a different capability', () => {
  const session = {};
  trackRejectionAndMaybeBounce(
    session,
    'cap_one',
    FETCH,
    inconsistent('literal_provenance', { firstCall: true }),
    NORMAL,
  );
  resetSaveRejectionFamilies(session, 'cap_two');
  assert.equal(Object.keys(session.saveRejectionFamilyCounts).length, 1);
  // cap_one's grace is still spent: the next rejection counts as the 1st.
  for (let i = 1; i < DEAD_END_THRESHOLD; i++) {
    assert.equal(
      trackRejectionAndMaybeBounce(
        session,
        'cap_one',
        FETCH,
        inconsistent('literal_provenance'),
        NORMAL,
      ),
      null,
    );
  }
  assert.ok(
    trackRejectionAndMaybeBounce(
      session,
      'cap_one',
      FETCH,
      inconsistent('literal_provenance'),
      NORMAL,
    ),
  );
});

test('pending stays free and unbookkept — the grace never fires for it', () => {
  const session = {};
  for (let i = 0; i < 10; i++) {
    assert.equal(
      trackRejectionAndMaybeBounce(
        session,
        'cap',
        FETCH,
        { reason: 'pending', warnings: [] },
        NORMAL,
      ),
      null,
    );
  }
  assert.deepEqual(session.saveRejectionFamilyCounts ?? {}, {});
});
