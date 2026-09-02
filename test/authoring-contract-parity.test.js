// Parity lock between the audit instances and the authoring contracts.
//
// Each lockstep concern owns one shared fact source (vocab kind consts +
// the extractors under runtime/src/audit/concerns/) projected into both
// the audit issue and the authoring hint. These tests are the enforcement
// that replaced the "kept in lockstep" comments:
//
//   - Triage: FULL two-way coverage. Every constraint's detector_kind is a
//     live triagePlanAudit detector, and every triagePlanAudit detector is
//     projected by some constraint. Adding a triage detector without a
//     constraint (or vice versa) fails here.
//   - Save: every constraint's detector_kind is a live saveStrategyAudit
//     concern (Detector or Classifier). The reverse direction is a
//     REVIEWED SUBSET: the save contract deliberately projects only the
//     concerns whose evidence exists at compose time (the contract's
//     redaction philosophy argues against full projection). AUDIT_ONLY
//     below is that reviewed list — a new save-time concern must be
//     added either as a constraint projection or to the allowlist, so the
//     subset stays a decision instead of silent drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-contract-parity-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { triagePlanAudit } = await import('../dist/audit/triage/triage-plan.js');
const { saveStrategyAudit } = await import('../dist/audit/lift/save-strategy.js');
const { composeTriageAuthoringContract } = await import(
  '../dist/phases/triage/triage-authoring-contract.js'
);
const { composeSaveAuthoringContract } = await import(
  '../dist/phases/lift/save-authoring-contract.js'
);

// ---------- triage: full two-way parity ----------

function triageSession() {
  return {
    intercepted: [{ url: 'https://x.com/api/list?category=italian' }],
    declaredCapabilities: [{ capability: 'list_restaurants', args: {}, declared_at: 0 }],
    domNavigations: [{ url: 'https://x.com/restaurants', at: 1 }],
  };
}

test('parity: every triage constraint projects a live triagePlanAudit detector', () => {
  const contract = composeTriageAuthoringContract(triageSession());
  const live = new Set(triagePlanAudit.detectorKinds());
  for (const constraint of contract.constraints) {
    assert.ok(
      live.has(constraint.detector_kind),
      `constraint "${constraint.kind}" references dead detector_kind "${constraint.detector_kind}"`,
    );
  }
});

test('parity: every triagePlanAudit detector is projected by a triage constraint', () => {
  const contract = composeTriageAuthoringContract(triageSession());
  const projected = new Set(contract.constraints.map((c) => c.detector_kind));
  assert.deepEqual(
    [...projected].sort(),
    triagePlanAudit.detectorKinds().sort(),
    'triage contract must cover every detector (add a constraint when adding a detector)',
  );
});

// ---------- save: forward parity + reviewed reverse subset ----------

/** Save-audit concerns the contract deliberately does NOT project. Each
 *  entry is a decision, not an omission — the concern's evidence either
 *  doesn't exist at compose time or would over-coach (the contract's
 *  redaction philosophy). Moving a kind out of this list means adding a
 *  constraint that projects it. */
const AUDIT_ONLY = new Set([
  // Detectors
  'unparametrized_session_id',
  'unresolved_name_to_id_gap',
  'entity_pinned_infra_prereq',
  'inline_multi_fetch_prereq',
  'prereq_bind_key_mismatch',
  'lookup_embedded_in_prereq',
  'unreferenced_prereq_binding',
  'params_key_unreferenced',
  'useless_capability_prereq',
  // Its complement. Both read the target capability's saved tiers, which the
  // contract cannot see at compose time.
  'side_effect_prereq_unproven',
  'recorded_path_inlines_lookup',
  'lookup_sibling_not_referenced',
  'sensitive_action_must_be_recorded_not_saved',
  'endpoint_collides_with_saved_capability',
  'unobserved_url',
  'lookup_prereq_must_be_capability',
  'popup_addressing_without_trigger',
  'hardcoded_pagination_value',
  // Classifiers
  'parameterization_disclosure_required',
  'mutating_verification_required',
  'observed_property_keys',
  'observed_literal_values',
  'capability_name_justification',
  'observed_siblings',
  'user_confirmation',
]);

/** The concerns the SaveConstraint union projects (its detector_kind
 *  values). Kept in the test as the review surface for the reverse
 *  check. */
const PROJECTED = new Set([
  'enum_value_baked_into_slug',
  'ungrounded_enum_placeholder',
  'enum_param_listing_unfactored',
  'captured_query_param_missing_from_strategy',
  'auth_gated_without_auth_prereq',
  'literal_provenance',
  'tier_below_triage_verdict',
  'surface_triage_missing',
]);

test('parity: PROJECTED ∪ AUDIT_ONLY exactly covers the save audit, with no overlap', () => {
  const live = [...saveStrategyAudit.detectorKinds(), ...saveStrategyAudit.classifierKinds()];
  const covered = [...PROJECTED, ...AUDIT_ONLY].sort();
  assert.deepEqual(
    [...live].sort(),
    covered,
    'a save-audit concern is missing from both PROJECTED and AUDIT_ONLY (or a listed kind is dead) — decide its contract projection explicitly',
  );
  for (const kind of PROJECTED) {
    assert.ok(!AUDIT_ONLY.has(kind), `"${kind}" is in both PROJECTED and AUDIT_ONLY`);
  }
});

test('parity: composed save constraints project only live save-audit concerns', () => {
  const session = {
    id: 'sess_save_parity',
    platform: 'contract-parity-test',
    intercepted: [
      {
        url: 'https://x.com/api/list?category=italian',
        method: 'GET',
        headers: {},
        status: 200,
      },
    ],
    performActionHistory: [],
    visitedUrls: ['https://x.com/'],
    declaredCapabilities: [
      { capability: 'list_restaurants', args: { category: 'italian' }, declared_at: 0 },
    ],
    domNavigations: [],
  };
  const contract = composeSaveAuthoringContract(
    session,
    'list_restaurants',
    { category: 'italian' },
    'contract-parity-test',
  );
  const live = new Set([
    ...saveStrategyAudit.detectorKinds(),
    ...saveStrategyAudit.classifierKinds(),
  ]);
  assert.ok(contract.constraints.length > 0, 'expected at least one composed constraint');
  for (const constraint of contract.constraints) {
    assert.ok(
      live.has(constraint.detector_kind),
      `constraint "${constraint.kind}" references dead detector_kind "${constraint.detector_kind}"`,
    );
    assert.ok(
      PROJECTED.has(constraint.detector_kind),
      `constraint "${constraint.kind}" projects "${constraint.detector_kind}" — add it to PROJECTED (it is a reviewed decision)`,
    );
  }
});
