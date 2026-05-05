// dispatchExecuteGraphOutcome guard for "didn't try" auto-execute reasons.
//
// When start_session({graph: 'execute'}) declines to attempt the saved
// strategy (missing args, no complete saved strategy), the session must
// stay in an active state so drive primitives remain admissible — the
// `_hint`'s "drive the flow yourself" path becomes truthful only when the
// FSM doesn't terminate the session on a non-failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dispatchExecuteGraphOutcome } = await import('../dist/tools/start-session.js');
const { checkAdmissibility, UNIVERSAL_TOOLS } = await import(
  '../dist/session-phase/registry.js'
);

function executeSession() {
  return {
    id: 'sess_exec_' + Math.random().toString(36).slice(2, 8),
    graph: 'execute',
  };
}

test('execute graph: args_required_to_auto_execute → swap to discover, session stays active', () => {
  const session = executeSession();
  const opts = { platform: 'p', capability: 'c' };
  const result = { executed: false, auto_execute_reason: 'args_required_to_auto_execute' };
  dispatchExecuteGraphOutcome(session, opts, result);
  assert.equal(session.status, undefined, 'session.status must not be set on decline');
  assert.equal(session.graph, 'discover', 'session.graph must swap back to discover');
  // Drive primitives are admissible in the drive phase (discover graph entry).
  const r = checkAdmissibility(session, 'js_eval');
  assert.ok(r.ok, `js_eval must be admissible after auto-execute decline; got ${JSON.stringify(r)}`);
});

test('execute graph: no_complete_saved_strategy → no dispatch, session stays active', () => {
  const session = executeSession();
  const opts = { platform: 'p', capability: 'c' };
  const result = { executed: false, auto_execute_reason: 'no_complete_saved_strategy' };
  dispatchExecuteGraphOutcome(session, opts, result);
  assert.equal(session.status, undefined);
});

test('execute graph: auto_execute_threw → execute_failed dispatched, session terminated', () => {
  const session = executeSession();
  const opts = { platform: 'p', capability: 'c' };
  const result = {
    executed: false,
    auto_execute_reason: 'auto_execute_threw: boom',
  };
  dispatchExecuteGraphOutcome(session, opts, result);
  // No rediscover-failure-gate signal here (no diagnosis_kind, no prior
  // success rate), so the gate's fallback fires → terminal{failed}.
  assert.equal(
    session.status,
    'failed',
    'genuine throw must remain terminal; guard only covers didnt-try reasons',
  );
});

test('execute graph: executed: true with ok body → execute_succeeded → terminal{closed}', () => {
  const session = executeSession();
  const opts = { platform: 'p', capability: 'c' };
  const result = {
    executed: true,
    execute_result: { status: 200, body: { ok: true } },
  };
  dispatchExecuteGraphOutcome(session, opts, result);
  assert.equal(session.status, 'closed');
});

test('discover graph: dispatch is a no-op regardless of result shape', () => {
  const session = { id: 'sess_disc', graph: 'discover' };
  const opts = { platform: 'p', capability: 'c' };
  const result = { executed: false, auto_execute_reason: 'auto_execute_threw: x' };
  dispatchExecuteGraphOutcome(session, opts, result);
  assert.equal(session.status, undefined, 'discover graph never dispatches outcomes');
});

test('admissibility: drive primitives stay admissible after args_required decline', () => {
  const session = executeSession();
  const opts = { platform: 'p', capability: 'c' };
  const result = { executed: false, auto_execute_reason: 'args_required_to_auto_execute' };
  dispatchExecuteGraphOutcome(session, opts, result);
  // Spot-check: js_eval is in UNIVERSAL_TOOLS so it always admits, but the
  // load-bearing claim is that NON-universal drive tools also admit, since
  // status isn't 'failed'.
  for (const tool of ['js_eval', 'get_a11y_tree', 'get_screenshot']) {
    const r = checkAdmissibility(session, tool);
    assert.ok(r.ok, `${tool} must be admissible; got ${JSON.stringify(r)}`);
  }
});
