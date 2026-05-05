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

test('admissibility: end_drive admitted in lift as the abandon path', () => {
  // Drive → triage → lift via the canonical sequence. end_drive must be
  // admissible from lift so the agent can bail out of an audit loop without
  // leaking the session.
  const session = fresh();
  dispatch(session, { kind: 'end_drive_unresolved' }); // → triage
  dispatch(session, { kind: 'plan_handoff' }); // → lift
  assert.equal(currentPhase(session), 'lift');
  const r = currentSpec(session).checkAdmissibility('end_drive', session);
  assert.ok(r.ok, 'end_drive admitted in lift');
});

test('admissibility: end_drive remains admissible when lift budget is exhausted', () => {
  // The exhausted set must include end_drive too, otherwise a
  // budget-exhausted lift session has no exit at all.
  const session = fresh();
  dispatch(session, { kind: 'end_drive_unresolved' });
  dispatch(session, { kind: 'plan_handoff' });
  session.lift.softBlockEngaged = true;
  const r = currentSpec(session).checkAdmissibility('end_drive', session);
  assert.ok(r.ok, 'end_drive admissible even when lift budget exhausted');
});

test('admissibility: get_a11y_tree admitted in drive', () => {
  // Drive-phase agents legitimately need the full a11y tree when the
  // trimmed default from perform_action truncates around the element they
  // want. Forcing them into triage just to read the page DOM blocks the
  // goal-directed path for a read-only operation.
  const session = fresh();
  const r = currentSpec(session).checkAdmissibility('get_a11y_tree', session);
  assert.ok(r.ok, 'get_a11y_tree admitted in drive (read-only diagnostic)');
});

test('admissibility: get_a11y_tree admitted in triage and lift too', () => {
  // It's a read-only diagnostic — must be reachable from every active phase.
  const triageSession = fresh();
  dispatch(triageSession, { kind: 'end_drive_unresolved' });
  assert.ok(currentSpec(triageSession).checkAdmissibility('get_a11y_tree', triageSession).ok);
  const liftSession = fresh();
  dispatch(liftSession, { kind: 'end_drive_unresolved' });
  dispatch(liftSession, { kind: 'plan_handoff' });
  assert.ok(currentSpec(liftSession).checkAdmissibility('get_a11y_tree', liftSession).ok);
});

test('admissibility: map mode REJECTS save_strategy in drive — observation-only contract', async () => {
  // Map is observation-only by design. Strategies are committed in
  // 'discover' graph (which has triage + lift phases for surface
  // classification and per-save audit). Map sessions persist findings via
  // record_observed_capability / save_verified_expression / add_discovery_note
  // / add_resume_pointer; a follow-up discover({capability}) session reads
  // those priors at turn 0 and warm-starts the lift.
  //
  // The rejection text is the moment-of-mistake teaching surface: agent
  // who reaches for save_strategy in map sees the four persistence tools
  // and the discover handoff inline.
  const { graphFor } = await import('../dist/session-phase/graphs/index.js');
  const map = graphFor('map');
  const discover = graphFor('discover');
  const session = fresh();
  // Discover graph: save_strategy rejects in drive (must hand to triage).
  const discoverReject = currentSpec(session).checkAdmissibility(
    'save_strategy',
    session,
    discover.config,
  );
  assert.equal(discoverReject.ok, false, 'discover drive rejects save_strategy');
  assert.match(discoverReject.reason, /hand over to triage/);
  // Map graph: save_strategy ALSO rejects, with prose pointing at the
  // four persistence tools + discover handoff.
  const mapReject = currentSpec(session).checkAdmissibility(
    'save_strategy',
    session,
    map.config,
  );
  assert.equal(mapReject.ok, false, 'map drive rejects save_strategy (observation-only)');
  assert.match(mapReject.reason, /observation-only/);
  for (const persistTool of [
    'record_observed_capability',
    'save_verified_expression',
    'add_discovery_note',
    'add_resume_pointer',
  ]) {
    assert.match(
      mapReject.reason,
      new RegExp(persistTool),
      `map save_strategy rejection should name ${persistTool} as a persistence path`,
    );
  }
  assert.match(mapReject.reason, /discover/, 'rejection should point at discover graph follow-up');
  // Map rejection prose for an unrelated tool reflects map's exit (end_drive).
  const mapRejectOther = currentSpec(session).checkAdmissibility(
    'submit_triage_plan',
    session,
    map.config,
  );
  assert.equal(mapRejectOther.ok, false);
  assert.match(mapRejectOther.reason, /observation-only.*end_drive/s);
});

test('graph topology: map has no lift phase', async () => {
  // Backstop for the orchestrator's lift-bookkeeping graph guard. The guard
  // checks `currentGraph(session).nodes.has('lift')` before populating
  // session.lift; if a future graph rev added 'lift' to map's node set
  // without the matching state-machine transitions, the guard would
  // incorrectly write bookkeeping for an unreachable phase.
  const { graphFor } = await import('../dist/session-phase/graphs/index.js');
  const map = graphFor('map');
  assert.equal(map.nodes.has('lift'), false, 'map graph must not contain a lift phase');
  assert.equal(map.nodes.has('triage'), false, 'map graph must not contain a triage phase');
  // Sanity: discover and execute do contain lift.
  const discover = graphFor('discover');
  const execute = graphFor('execute');
  assert.equal(discover.nodes.has('lift'), true);
  assert.equal(execute.nodes.has('lift'), true);
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
