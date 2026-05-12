// Audit Classifiers expose their items inside the rejection envelope's
// `items:` block. The agent reads each item's `hint:` field for guidance on
// where to put the answer. Two classifiers in
// `audit/lift/save-strategy-warning-classifiers.ts`
// (`mutating_verification_required`, `parameterization_disclosure_required`)
// reuse the underlying SaveWarning's `hint:` text via `buildItems`. The
// SaveWarning hint historically said `Acknowledge inline:
// notes.save_warnings_acked: [{...}]` — the DETECTOR slot. But these are
// Classifiers; their answers go in `audit_answers`, not in the
// `save_warnings_acked` array.
//
// Repro (live trace): llm-tests/search-enforcement/fresh-discovery v7b r17.
// Agent reads the per-item hint, puts `mutating_verification_required` in
// `notes.save_warnings_acked`, gets back "acks contains kind '...' but no
// detector emitted a warning with that kind". Agent thrashes for ~10 rounds
// trying to defeat the audit instead of moving the answer to the right slot.
//
// The fix: SaveWarning hints for these two kinds name `audit_answers.<kind>`
// directly. The agent's `audit_answers` map is the routing the framework
// uses for Classifier answers; spelling that out in the per-item hint stops
// it contradicting the envelope's top-level `how_to_respond` line.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectMutatingStrategyVerificationApproach } = await import(
  '../dist/gate/save-warnings-mutating-verification.js'
);
const { detectParameterizationDisclosureRequired } = await import(
  '../dist/gate/save-warnings-parameterization.js'
);

test('mutating_verification_required hint routes to audit_answers, not save_warnings_acked', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'http://example.test',
    endpoint: '/api/conversations/{{member_id}}/messages',
    contentType: 'json',
    body: { text: '{{text}}' },
    notes: { params: { member_id: { kind: 'id' }, text: { kind: 'text' } } },
  };
  const warnings = detectMutatingStrategyVerificationApproach(strategy);
  assert.equal(warnings.length, 1);
  const hint = warnings[0].hint || '';
  // The Detector slot must NOT be referenced — that's the slot the agent
  // ended up using in the live thrash.
  assert.doesNotMatch(hint, /notes\.save_warnings_acked/);
  assert.doesNotMatch(hint, /Acknowledge inline/);
  // The Classifier slot IS named — `audit_answers.<kind>` is the routing
  // the framework actually consumes.
  assert.match(hint, /audit_answers\.mutating_verification_required/);
});

test('parameterization_disclosure_required hint routes to audit_answers, not save_warnings_acked', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/me/profile',
    // No notes.params → detector fires.
  };
  const warnings = detectParameterizationDisclosureRequired(strategy);
  assert.equal(warnings.length, 1);
  const hint = warnings[0].hint || '';
  // Note: this warning DOES have a legitimate `notes.params` remedy (declare
  // params instead of acking), so the hint mentions notes.params for the
  // declare path. The forbidden phrase is the ack-slot misdirection
  // `notes.save_warnings_acked`.
  assert.doesNotMatch(hint, /notes\.save_warnings_acked/);
  assert.doesNotMatch(hint, /Or ack inline/);
  // The Classifier-slot answer path is named.
  assert.match(hint, /audit_answers\.parameterization_disclosure_required/);
});
