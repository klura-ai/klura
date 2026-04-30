// Graph invariant tests. The session FSM is data — three Graph literals in
// runtime/src/session-phase/graphs/. These tests assert structural
// invariants by walking each graph's transition table; if a graph
// definition drifts (transition added/removed, terminal swapped), the
// test that depends on the invariant fails with a clear message.

import test from 'node:test';
import assert from 'node:assert/strict';

const { GRAPHS } = await import('../dist/session-phase/graphs/index.js');
const { isTerminal } = await import('../dist/session-phase/types.js');

/** BFS over a graph's transitions starting at `from`; returns the set of
 *  reachable phase nodes (excludes terminal nodes). */
function reachablePhases(graph, from) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const here = queue.shift();
    for (const t of graph.transitions) {
      if (t.from !== here) continue;
      if (isTerminal(t.to)) continue;
      if (!seen.has(t.to)) {
        seen.add(t.to);
        queue.push(t.to);
      }
    }
  }
  return seen;
}

/** Set of (from, on) pairs that have at least one transition pointing at a
 *  terminal node. */
function terminalDestinations(graph) {
  const out = new Set();
  for (const t of graph.transitions) {
    if (isTerminal(t.to)) out.add(`${t.from}/${t.on}`);
  }
  return out;
}

test('every graph has a defined entry phase that is one of its nodes', () => {
  for (const [name, g] of Object.entries(GRAPHS)) {
    assert.ok(g.entryPhase, `${name}: entryPhase is defined`);
    assert.ok(g.nodes.has(g.entryPhase), `${name}: entryPhase '${g.entryPhase}' is in nodes`);
  }
});

test("every transition's from and (non-terminal) to are in the graph's nodes", () => {
  for (const [name, g] of Object.entries(GRAPHS)) {
    for (const t of g.transitions) {
      assert.ok(g.nodes.has(t.from), `${name}: transition.from '${t.from}' is in nodes`);
      if (!isTerminal(t.to)) {
        assert.ok(g.nodes.has(t.to), `${name}: transition.to '${t.to}' is in nodes`);
      }
    }
  }
});

test('discover graph: drive→lift requires passing through triage', () => {
  const g = GRAPHS.discover;
  // Direct drive→lift transition must not exist.
  const direct = g.transitions.find((t) => t.from === 'drive' && t.to === 'lift');
  assert.equal(direct, undefined, 'no direct drive→lift transition allowed');
  // Reachability from drive must include both triage and lift, but lift
  // must only be reachable via triage (verified by the absence above).
  const reach = reachablePhases(g, 'drive');
  assert.ok(reach.has('triage'), 'drive reaches triage');
  assert.ok(reach.has('lift'), 'drive reaches lift (via triage)');
});

test('map graph: only one node (drive); no triage, no lift', () => {
  const g = GRAPHS.map;
  assert.equal(g.nodes.size, 1, 'map graph has exactly one node');
  assert.ok(g.nodes.has('drive'), "map graph's only node is 'drive'");
  assert.ok(!g.nodes.has('triage'), 'map graph has no triage node');
  assert.ok(!g.nodes.has('lift'), 'map graph has no lift node');
});

test('execute graph: execute_failed has guarded + unguarded transitions in order', () => {
  const g = GRAPHS.execute;
  const failedTransitions = g.transitions.filter(
    (t) => t.from === 'execute' && t.on === 'execute_failed',
  );
  assert.equal(failedTransitions.length, 2, 'execute_failed has two transitions');
  // Guarded comes first (rediscover-fires → triage).
  assert.ok(failedTransitions[0].when, 'first execute_failed transition is guarded');
  assert.equal(failedTransitions[0].to, 'triage', 'guarded execute_failed → triage');
  // Unguarded fallback second (terminal{failed}).
  assert.equal(failedTransitions[1].when, undefined, 'second execute_failed transition is unguarded');
  assert.ok(isTerminal(failedTransitions[1].to), 'unguarded execute_failed → terminal');
  assert.equal(failedTransitions[1].to.status, 'failed', 'unguarded terminal status is failed');
});

test('execute graph: execute_succeeded → terminal{closed}', () => {
  const g = GRAPHS.execute;
  const t = g.transitions.find(
    (x) => x.from === 'execute' && x.on === 'execute_succeeded',
  );
  assert.ok(t, 'execute_succeeded transition exists');
  assert.ok(isTerminal(t.to), 'execute_succeeded → terminal');
  assert.equal(t.to.status, 'closed', 'execute_succeeded terminal status is closed');
});

test('every graph has at least one transition that reaches a terminal', () => {
  for (const [name, g] of Object.entries(GRAPHS)) {
    const terminals = terminalDestinations(g);
    assert.ok(terminals.size > 0, `${name}: at least one terminal destination`);
  }
});

test('resolved_via_save terminates from any non-terminal node in discover/execute', () => {
  for (const name of ['discover', 'execute']) {
    const g = GRAPHS[name];
    for (const node of g.nodes) {
      // Each non-entry phase must have either a resolved_via_save terminal
      // OR a transition that eventually reaches one. We check the direct
      // transition for now (sufficient for current graphs).
      const direct = g.transitions.find(
        (t) => t.from === node && t.on === 'resolved_via_save' && isTerminal(t.to),
      );
      // execute graph's `execute` phase doesn't have resolved_via_save
      // (the strategy save happens in lift). Skip that single exception.
      if (name === 'execute' && node === 'execute') continue;
      assert.ok(direct, `${name}: phase '${node}' has resolved_via_save → terminal`);
    }
  }
});
