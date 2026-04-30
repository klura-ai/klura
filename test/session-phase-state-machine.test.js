// Session-phase state machine — admissibility, transitions, budgets,
// and the load-bearing `surface_changed` re-entry-vs-replan distinction
// from review item #2.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dispatch, forceTransition } = await import('../dist/session-phase/state-machine.js');
const { currentPhase, currentSpec, checkAdmissibility, UNIVERSAL_TOOLS } = await import(
  '../dist/session-phase/registry.js'
);
const { SessionPhaseTransitionError, ToolNotAdmissibleError } = await import(
  '../dist/session-phase/types.js'
);
const { DEFAULT_TRIAGE_MAX_ROUNDS } = await import('../dist/session-phase/phases/triage.js');

function fresh() {
  return { id: 'sess_test_' + Math.random().toString(36).slice(2, 8) };
}

test('currentPhase: fresh session reports "drive"', () => {
  assert.equal(currentPhase(fresh()), 'drive');
});

test('currentPhase: throws on half-initialized session (phase undefined but triage state present)', () => {
  const session = { id: 'sess_half', triage: { enteredAt: 0, roundsSinceEntry: 0, budget: 0, softBlockEngaged: false } };
  assert.throws(() => currentPhase(session), /half-initialized/);
});

test('dispatch: end_drive_unresolved transitions drive → triage', () => {
  const session = fresh();
  const result = dispatch(session, { kind: 'end_drive_unresolved' });
  assert.equal(result.from, 'drive');
  assert.equal(result.to, 'triage');
  assert.equal(result.event, 'end_drive_unresolved');
  assert.equal(currentPhase(session), 'triage');
  assert.ok(session.triage, 'triage bookkeeping initialized');
  assert.equal(session.triage.roundsSinceEntry, 0);
  assert.equal(session.triage.budget, DEFAULT_TRIAGE_MAX_ROUNDS);
});

test('dispatch: illegal transition throws SessionPhaseTransitionError', () => {
  const session = fresh();
  assert.throws(
    () => dispatch(session, { kind: 'plan_handoff' }),
    (err) =>
      err instanceof SessionPhaseTransitionError &&
      err.from === 'drive' &&
      err.event === 'plan_handoff',
  );
});

test('dispatch: plan_handoff transitions triage → lift with fresh lift state', () => {
  const session = fresh();
  dispatch(session, { kind: 'end_drive_unresolved' });
  dispatch(session, { kind: 'plan_handoff' });
  assert.equal(currentPhase(session), 'lift');
  assert.ok(session.lift);
  assert.equal(session.lift.roundsSinceHandoff, 0);
});

test('re-plan: lift → triage (plan_submitted) → lift (plan_handoff) PRESERVES lift counter', () => {
  const session = fresh();
  dispatch(session, { kind: 'end_drive_unresolved' });
  dispatch(session, { kind: 'plan_handoff' });
  // Simulate lift work having burned 7 rounds.
  session.lift.roundsSinceHandoff = 7;
  dispatch(session, { kind: 'plan_submitted' });
  assert.equal(currentPhase(session), 'triage');
  assert.equal(session.triage.triggeredBy, 'plan_submitted');
  dispatch(session, { kind: 'plan_handoff' });
  assert.equal(currentPhase(session), 'lift');
  assert.equal(
    session.lift.roundsSinceHandoff,
    7,
    're-plan re-entry preserves the lift counter (same surface, updated verdict)',
  );
});

test('surface_changed re-entry: lift → triage (surface_changed) → lift (plan_handoff) RESETS lift counter', () => {
  const session = fresh();
  dispatch(session, { kind: 'end_drive_unresolved' });
  dispatch(session, { kind: 'plan_handoff' });
  // Simulate lift work having burned 12 rounds on the prior surface.
  session.lift.roundsSinceHandoff = 12;
  dispatch(session, { kind: 'surface_changed' });
  assert.equal(currentPhase(session), 'triage');
  assert.equal(session.triage.triggeredBy, 'surface_changed');
  dispatch(session, { kind: 'plan_handoff' });
  assert.equal(currentPhase(session), 'lift');
  assert.equal(
    session.lift.roundsSinceHandoff,
    0,
    'surface-change re-entry resets the lift counter (new surface deserves fresh budget)',
  );
});

test('triage: surface_changed self-loop refreshes triage state', () => {
  const session = fresh();
  dispatch(session, { kind: 'end_drive_unresolved' });
  session.triage.roundsSinceEntry = 6;
  dispatch(session, { kind: 'surface_changed' });
  assert.equal(currentPhase(session), 'triage');
  assert.equal(session.triage.roundsSinceEntry, 0, 'self-loop resets the triage counter');
  assert.equal(session.triage.triggeredBy, 'surface_changed');
});

test('admissibility: universal tools always admit, even after the graph terminates', () => {
  const session = fresh();
  // Force the graph to a terminal node via dispatch chain.
  dispatch(session, { kind: 'end_drive_unresolved' });
  dispatch(session, { kind: 'resolved_via_save' });
  assert.equal(session.status, 'closed', 'session.status set when terminal node reached');
  for (const tool of UNIVERSAL_TOOLS) {
    const r = checkAdmissibility(session, tool);
    assert.ok(r.ok, `universal tool '${tool}' should admit on a closed session`);
  }
});

test('admissibility: phase-scoped tool rejected outside its phase', () => {
  const session = fresh();
  // try_generator is lift-only.
  const r = checkAdmissibility(session, 'try_generator');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not available in phase 'drive'/);
});

test('forceTransition: returns event=null for forced transitions', () => {
  const session = fresh();
  const r = forceTransition(session, { kind: 'terminal', status: 'closed' });
  assert.equal(r.from, 'drive');
  assert.deepEqual(r.to, { kind: 'terminal', status: 'closed' });
  assert.equal(r.event, null, 'forced transition reports event=null (no originating PhaseEvent)');
  assert.equal(session.status, 'closed');
});

test('triage budget exhaustion narrows the admissible-tools set', async () => {
  const session = fresh();
  dispatch(session, { kind: 'end_drive_unresolved' });
  // Manually engage soft-block to mimic budget-exhausted state.
  session.triage.softBlockEngaged = true;
  // submit_triage_plan stays admissible.
  const okR = currentSpec(session).checkAdmissibility('submit_triage_plan', session);
  assert.ok(okR.ok);
  // Other diagnostic tools blocked.
  const blocked = currentSpec(session).checkAdmissibility('get_network_log', session);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /TRIAGE BUDGET EXHAUSTED/);
});
