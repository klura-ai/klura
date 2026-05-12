// Session-phase state machine — admissibility, transitions, budgets,
// and the load-bearing `surface_changed` re-entry-vs-replan distinction
// from review item #2.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dispatch, forceTransition } = await import('../dist/phases/state-machine.js');
const { currentPhase, currentSpec, checkAdmissibility, UNIVERSAL_TOOLS } = await import(
  '../dist/phases/registry.js'
);
const { SessionPhaseTransitionError, ToolNotAdmissibleError } = await import(
  '../dist/phases/types.js'
);
const { DEFAULT_TRIAGE_MAX_ROUNDS } = await import('../dist/phases/triage.js');

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

test('admissibility: declare_capability admitted in drive, triage, AND lift', () => {
  // Agents routinely realise mid-flow (in triage during plan composition,
  // or in lift during save authoring) that the strategy they're saving
  // needs a sibling capability declared (lookup_X chained as a prereq,
  // list_Y as an enum source). Drive-only restriction forced agents to
  // either inline those prereqs as fetch-extracts (which trip downstream
  // audits) or bail out entirely — see the audit-completeness sprint
  // findings. declare_capability has no phase-specific internal logic and
  // mutates only append-only state, so admitting it in every non-closed
  // phase is structurally safe.
  const driveSession = fresh();
  assert.ok(
    currentSpec(driveSession).checkAdmissibility('declare_capability', driveSession).ok,
    'declare_capability admitted in drive (unchanged behavior)',
  );
  const triageSession = fresh();
  dispatch(triageSession, { kind: 'end_drive_unresolved' });
  assert.ok(
    currentSpec(triageSession).checkAdmissibility('declare_capability', triageSession).ok,
    'declare_capability admitted in triage',
  );
  const liftSession = fresh();
  dispatch(liftSession, { kind: 'end_drive_unresolved' });
  dispatch(liftSession, { kind: 'plan_handoff' });
  assert.ok(
    currentSpec(liftSession).checkAdmissibility('declare_capability', liftSession).ok,
    'declare_capability admitted in lift',
  );
});

test('admissibility: map drive rejects save_strategy with lift_observed_capability handoff', async () => {
  // Map's drive phase is for exploration; lift is reached via
  // lift_observed_capability for any slug already on
  // platform_logbook.observed_capabilities[]. save_strategy itself only
  // runs in the resulting triage/lift phases. The rejection text is the
  // moment-of-mistake teaching surface: agent who reaches for
  // save_strategy in map-drive learns about the explore → record → lift
  // chain inline.
  const { graphFor } = await import('../dist/graphs/index.js');
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
  // Map graph: save_strategy rejects with prose pointing at lift_observed_capability.
  const mapReject = currentSpec(session).checkAdmissibility(
    'save_strategy',
    session,
    map.config,
  );
  assert.equal(mapReject.ok, false, 'map drive rejects save_strategy');
  assert.match(mapReject.reason, /lift_observed_capability/);
  assert.match(mapReject.reason, /record_observed_capability/);
  // submit_triage_plan in map-drive: rejection points at lift_observed_capability too.
  const mapRejectTriage = currentSpec(session).checkAdmissibility(
    'submit_triage_plan',
    session,
    map.config,
  );
  assert.equal(mapRejectTriage.ok, false);
  assert.match(mapRejectTriage.reason, /lift_observed_capability/);
});

test('graph topology: map has triage + lift, reached via lift_observed_capability', async () => {
  const { graphFor } = await import('../dist/graphs/index.js');
  const map = graphFor('map');
  assert.equal(map.nodes.has('drive'), true, 'map graph entry phase is drive');
  assert.equal(map.nodes.has('triage'), true, 'map graph contains triage');
  assert.equal(map.nodes.has('lift'), true, 'map graph contains lift');
  // The drive → triage transition only fires on lift_observed_capability_invoked
  // in map (discover uses end_drive_unresolved + surface_changed instead).
  const driveToTriage = map.transitions.find(
    (t) => t.from === 'drive' && t.on === 'lift_observed_capability_invoked',
  );
  assert.ok(driveToTriage, 'map graph wires drive → triage on lift_observed_capability_invoked');
  assert.equal(driveToTriage.to, 'triage');
  // lift → triage on the same event lets the agent declare a NEXT slug
  // after a successful save without going back to drive first.
  const liftToTriage = map.transitions.find(
    (t) => t.from === 'lift' && t.on === 'lift_observed_capability_invoked',
  );
  assert.ok(liftToTriage, 'map graph wires lift → triage on lift_observed_capability_invoked');
  // Sanity: discover and execute also contain lift.
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
