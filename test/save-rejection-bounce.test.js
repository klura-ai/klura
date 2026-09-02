// Structural-dead-end hard bounce: after the 3rd same-family save_strategy
// rejection for one capability, the runtime returns a structural_dead_end
// instead of echoing the same audit prose. The family key derives from the
// ACTIVE issues of the current rejection plus the saved tier; `pending` /
// `payload_changed` never count; the exit menu leads with the underlying
// rejection's own remedy; an accepted triage re-plan resets the budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  trackRejectionAndMaybeBounce,
  rejectionFamilyKey,
  resetSaveRejectionFamilies,
  DEAD_END_THRESHOLD,
} = await import('../dist/audit/lift/save-rejection-bounce.js');
const { applySaveRejectionBounce } = await import('../dist/audit/lift/save-policy.js');
const { AUDIT_KINDS, SAVE_ORIGINS, WARNING_KINDS } = await import('../dist/vocab/index.js');

const FETCH = { strategy: 'fetch' };
const RECORDED = { strategy: 'recorded-path' };

function rej(kinds, reason = 'unacked_warnings') {
  return { reason, warnings: kinds.map((k) => ({ kind: k, message: k })) };
}

// ---------- family key ----------

test('rejectionFamilyKey is stable for the same set of kinds (order-independent)', () => {
  assert.equal(
    rejectionFamilyKey(rej(['a', 'b']), 'fetch'),
    rejectionFamilyKey(rej(['b', 'a']), 'fetch'),
  );
});

test('invalid_shape collapses to a single family per tier', () => {
  const r = { reason: 'invalid_shape', warnings: [] };
  assert.equal(rejectionFamilyKey(r, 'fetch'), 'fetch::invalid_shape');
  assert.notEqual(rejectionFamilyKey(r, 'fetch'), rejectionFamilyKey(r, 'page-script'));
});

test('family key includes the tier — the same kinds on different tiers are different families', () => {
  const r = rej(['literal_provenance', 'mutating_verification_required']);
  assert.notEqual(rejectionFamilyKey(r, 'fetch'), rejectionFamilyKey(r, 'recorded-path'));
});

test('pending and payload_changed are non-substantive — no family key at all', () => {
  assert.equal(rejectionFamilyKey({ reason: 'pending', warnings: [] }, 'fetch'), null);
  assert.equal(rejectionFamilyKey({ reason: 'payload_changed', warnings: [] }, 'fetch'), null);
});

test('answers_inconsistent family derives from classifiers with ACTIVE issues, not the items checklist', () => {
  const r = {
    reason: 'answers_inconsistent',
    warnings: [],
    items: { literal_provenance: [{ path: 'endpoint' }], user_confirmation: { ask: true } },
    classifier_issues: ['literal_provenance["endpoint"] missing — classify the field'],
  };
  const family = rejectionFamilyKey(r, 'fetch');
  assert.match(family, /literal_provenance/);
  // user_confirmation is on the checklist but raised no issue this round —
  // auto-resolved / clean classifiers must not inflate the family.
  assert.doesNotMatch(family, /user_confirmation/);
});

test('enum-grounding bullets attribute by notes.params.<param> path — same param is one family, different params differ', () => {
  const bulletA = {
    reason: 'answers_inconsistent',
    warnings: [],
    items: { literal_provenance: [{ path: 'endpoint' }] },
    classifier_issues: [
      'notes.params.cuisine.observed_values[0].value = "sushi" was not observed in captured traffic',
    ],
  };
  const bulletASameParamOtherProse = {
    reason: 'answers_inconsistent',
    warnings: [],
    items: { literal_provenance: [{ path: 'endpoint' }] },
    classifier_issues: [
      'notes.params.cuisine.kind === "enum" requires at least 2 distinct observed_values',
    ],
  };
  const bulletB = {
    reason: 'answers_inconsistent',
    warnings: [],
    items: { literal_provenance: [{ path: 'endpoint' }] },
    classifier_issues: ['notes.params.city.observed_values[0].value must be a non-empty string'],
  };
  assert.equal(
    rejectionFamilyKey(bulletA, 'fetch'),
    rejectionFamilyKey(bulletASameParamOtherProse, 'fetch'),
    'prose drift on the same param stays in one family',
  );
  assert.notEqual(
    rejectionFamilyKey(bulletA, 'fetch'),
    rejectionFamilyKey(bulletB, 'fetch'),
    'a different param is a fresh family',
  );
});

// ---------- counting + bounce ----------

test('3rd same-family rejection bounces; first two do not', () => {
  const session = {};
  const normal = 'invalid_strategy: the real rejection text';
  const r = rej(['response_from_binding']);
  assert.equal(
    trackRejectionAndMaybeBounce(session, 'search_products', FETCH, r, normal),
    null,
    '1st',
  );
  assert.equal(
    trackRejectionAndMaybeBounce(session, 'search_products', FETCH, r, normal),
    null,
    '2nd',
  );
  const third = trackRejectionAndMaybeBounce(session, 'search_products', FETCH, r, normal);
  assert.ok(third, '3rd returns a bounce message');
  assert.match(third, new RegExp(AUDIT_KINDS.saveStrategyStructuralDeadEnd));
  assert.match(third, /search_products/);
  assert.match(third, /add_discovery_note/);
  assert.match(third, /abort_session/);
  assert.match(third, /the real rejection text/, 'embeds the underlying rejection for context');
  assert.match(
    third,
    /evaluated in full/,
    'states that a genuinely-fixed retry still commits — the bounce fires on the rejection, not the attempt',
  );
});

test('a different rejection family gets its own fresh budget', () => {
  const session = {};
  const normal = 'invalid_strategy: x';
  const famA = rej(['enum_grounding']);
  const famB = rej(['mutating_verification_required']);
  trackRejectionAndMaybeBounce(session, 'cap', FETCH, famA, normal);
  trackRejectionAndMaybeBounce(session, 'cap', FETCH, famA, normal);
  // 3rd attempt is fully evaluated: its OWN rejection content decides the
  // family, so a materially different failure never inherits the budget.
  assert.equal(trackRejectionAndMaybeBounce(session, 'cap', FETCH, famB, normal), null);
});

test('a tier pivot resets the family even when the same kinds fire on both tiers', () => {
  const session = {};
  const normal = 'invalid_strategy: x';
  const r = rej(['literal_provenance', 'mutating_verification_required']);
  trackRejectionAndMaybeBounce(session, 'reply_to_user', FETCH, r, normal);
  trackRejectionAndMaybeBounce(session, 'reply_to_user', FETCH, r, normal);
  assert.equal(
    trackRejectionAndMaybeBounce(session, 'reply_to_user', RECORDED, r, normal),
    null,
    'first recorded-path rejection starts a fresh family',
  );
});

test('pending and payload_changed rejections never count toward the budget', () => {
  const session = {};
  const normal = 'invalid_strategy: x';
  for (let i = 0; i < DEAD_END_THRESHOLD + 2; i += 1) {
    assert.equal(
      trackRejectionAndMaybeBounce(session, 'cap', FETCH, rej([], 'pending'), normal),
      null,
    );
    assert.equal(
      trackRejectionAndMaybeBounce(session, 'cap', FETCH, rej([], 'payload_changed'), normal),
      null,
    );
  }
  // The substantive budget is untouched: two same-family rejections still
  // pass, only the third bounces.
  const r = rej(['enum_grounding']);
  assert.equal(trackRejectionAndMaybeBounce(session, 'cap', FETCH, r, normal), null);
  assert.equal(trackRejectionAndMaybeBounce(session, 'cap', FETCH, r, normal), null);
  assert.ok(trackRejectionAndMaybeBounce(session, 'cap', FETCH, r, normal));
});

test('the same family on a different capability has an independent counter', () => {
  const session = {};
  const normal = 'invalid_strategy: x';
  const r = rej(['enum_grounding']);
  trackRejectionAndMaybeBounce(session, 'cap_one', FETCH, r, normal);
  trackRejectionAndMaybeBounce(session, 'cap_one', FETCH, r, normal);
  assert.equal(trackRejectionAndMaybeBounce(session, 'cap_two', FETCH, r, normal), null);
});

test('no session (programmatic save) never bounces', () => {
  const r = rej(['enum_grounding']);
  for (let i = 0; i < DEAD_END_THRESHOLD + 2; i += 1) {
    assert.equal(trackRejectionAndMaybeBounce(null, 'cap', FETCH, r, 'msg'), null);
  }
});

// ---------- remedy-derived exit menu ----------

function bounceWith(rejection, normal = 'invalid_strategy: inner text') {
  const session = {};
  let out = null;
  for (let i = 0; i < DEAD_END_THRESHOLD; i += 1) {
    out = trackRejectionAndMaybeBounce(session, 'cap', FETCH, rejection, normal);
  }
  assert.ok(out, 'threshold reached');
  return out;
}

test("the dead-end menu leads with the underlying warning's own hint", () => {
  const hint =
    'Add a {kind: "capability"} prerequisite pointing at list_restaurants so the source resolves at execute time.';
  const r = {
    reason: 'unacked_warnings',
    warnings: [{ kind: 'capability_source_missing_prereq', message: 'missing prereq', hint }],
  };
  const msg = bounceWith(r);
  assert.ok(msg.includes(hint), 'menu quotes the warning hint verbatim');
  assert.ok(
    msg.indexOf(hint) < msg.indexOf('DEFER —'),
    'the remedy-derived exit precedes the generic defer/tier/abandon triad',
  );
  assert.match(msg, /\(a\) APPLY THE FIX/);
});

test('a capability_alternative classifier remedy becomes a leading exit option', () => {
  const r = {
    reason: 'answers_inconsistent',
    warnings: [],
    items: { capability_name_justification: { slug: 'get_thing_by_name' } },
    classifier_issues: ['capability_name_justification: justification is too vague'],
    classifier_remedies: {
      capability_name_justification: {
        kind: 'capability_alternative',
        suggested_capability_kind: 'capability',
        reasoning: 'chain to a sibling lookup capability',
      },
    },
  };
  const msg = bounceWith(r);
  assert.match(msg, /RESTRUCTURE PER THE "capability_name_justification" REMEDY/);
  assert.match(msg, /\{kind: "capability"\}/);
  assert.ok(msg.indexOf('RESTRUCTURE PER') < msg.indexOf('DEFER —'));
});

test('enum-grounding-shaped rejections add the return-to-drive exit', () => {
  const viaWarning = bounceWith({
    reason: 'unacked_warnings',
    warnings: [{ kind: WARNING_KINDS.ungroundedEnumPlaceholder, message: 'no observed values' }],
  });
  assert.match(viaWarning, /RETURN TO DRIVE TO CAPTURE GROUNDING/);

  const viaParamBullets = bounceWith({
    reason: 'answers_inconsistent',
    warnings: [],
    items: { literal_provenance: [{ path: 'endpoint' }] },
    classifier_issues: [
      'notes.params.cuisine.observed_values[0].value = "sushi" was not observed in captured traffic',
    ],
  });
  assert.match(viaParamBullets, /RETURN TO DRIVE TO CAPTURE GROUNDING/);

  const plain = bounceWith(rej(['response_from_binding']));
  assert.doesNotMatch(plain, /RETURN TO DRIVE TO CAPTURE GROUNDING/);
});

// ---------- triage re-plan reset ----------

test('resetSaveRejectionFamilies restarts the budget for one capability only', () => {
  const session = {};
  const normal = 'invalid_strategy: x';
  const r = rej(['enum_grounding']);
  trackRejectionAndMaybeBounce(session, 'cap_a', FETCH, r, normal);
  trackRejectionAndMaybeBounce(session, 'cap_a', FETCH, r, normal);
  trackRejectionAndMaybeBounce(session, 'cap_b', FETCH, r, normal);
  trackRejectionAndMaybeBounce(session, 'cap_b', FETCH, r, normal);

  resetSaveRejectionFamilies(session, 'cap_a');

  // cap_a restarts: two more pass, only the third bounces again.
  assert.equal(trackRejectionAndMaybeBounce(session, 'cap_a', FETCH, r, normal), null);
  assert.equal(trackRejectionAndMaybeBounce(session, 'cap_a', FETCH, r, normal), null);
  assert.ok(trackRejectionAndMaybeBounce(session, 'cap_a', FETCH, r, normal));
  // cap_b kept its two counted rejections — the next one bounces.
  assert.ok(trackRejectionAndMaybeBounce(session, 'cap_b', FETCH, r, normal));
});

// ---------- save-policy origin gating ----------

test('applySaveRejectionBounce fires only for agent_explicit — unattended origins pass through', () => {
  const session = {};
  const r = rej(['enum_grounding']);
  for (let i = 0; i < DEAD_END_THRESHOLD + 2; i += 1) {
    assert.equal(
      applySaveRejectionBounce({
        origin: SAVE_ORIGINS.autoSynthFetch,
        capability: 'cap',
        strategy: FETCH,
        session,
        rejection: r,
        renderedMessage: 'rendered',
      }),
      'rendered',
    );
  }
  assert.deepEqual(session, {}, 'unattended rejections never touch the session counters');

  let last = null;
  for (let i = 0; i < DEAD_END_THRESHOLD; i += 1) {
    last = applySaveRejectionBounce({
      origin: SAVE_ORIGINS.agentExplicit,
      capability: 'cap',
      strategy: FETCH,
      session,
      rejection: r,
      renderedMessage: 'rendered',
    });
  }
  assert.match(last, new RegExp(AUDIT_KINDS.saveStrategyStructuralDeadEnd));
});
