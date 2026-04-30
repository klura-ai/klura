// Unit tests for the per-kind ack_checkpoint hint composer.
//
// Every CheckpointKind has a tailored hint surfaced on the ack response.
// The composer is exhaustive over the kind union — adding a new kind
// without a hint case is a TypeScript build error, not a silent UX gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { composeAckHint } = await import('../dist/checkpoints/ack-hints.js');

// ---------- exhaustiveness: every CheckpointKind returns a hint ----------

test('composeAckHint: every CheckpointKind returns a non-empty string', () => {
  const kinds = [
    'triage_plan',
    'surface_changed',
    'recorded_step_failed',
    'session_expired',
    'post_save_validation_consent',
  ];
  for (const k of kinds) {
    const hint = composeAckHint(k, {});
    assert.equal(typeof hint, 'string', `${k}: hint must be a string`);
    assert.ok(hint.length > 0, `${k}: hint must be non-empty`);
  }
});

// ---------- per-kind specifics ----------

test('triage_plan: hint nudges toward LIFT + tier preference', () => {
  const hint = composeAckHint('triage_plan', {});
  assert.match(hint, /LIFT/);
  assert.match(hint, /save_strategy/);
  assert.match(hint, /fetch.*page-script.*recorded-path/);
});

test('surface_changed: hint nudges re-triage via submit_triage_plan', () => {
  const hint = composeAckHint('surface_changed', {});
  assert.match(hint, /submit_triage_plan/);
  assert.match(hint, /surface_label/);
});

test('recorded_step_failed: hint points to patch_step + resume_execution', () => {
  const hint = composeAckHint('recorded_step_failed', {});
  assert.match(hint, /patch_step/);
  assert.match(hint, /resume_execution/);
});

test('session_expired: hint points at re-auth + execute_strategy retry', () => {
  const hint = composeAckHint('session_expired', {});
  assert.match(hint, /Re-authenticate/);
  assert.match(hint, /execute_strategy/);
});

test('post_save_validation_consent: hint mentions Tier 1 / Tier 2 + decline path', () => {
  const hint = composeAckHint('post_save_validation_consent', {});
  assert.match(hint, /Tier 1/);
  assert.match(hint, /Tier 2/);
  assert.match(hint, /add_discovery_note/);
});
