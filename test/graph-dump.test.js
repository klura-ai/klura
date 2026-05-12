// Graph Mermaid-dump snapshot. The dumper reads each Graph literal and
// produces deterministic Mermaid source — useful in docs, CI artifacts,
// review diffs. This test pins the output shape so a transition change
// produces a reviewable diff.

import test from 'node:test';
import assert from 'node:assert/strict';

const { dumpMermaid, dumpAllMermaid } = await import('../dist/graphs/dump.js');
const { GRAPHS } = await import('../dist/graphs/index.js');

test('discover graph: Mermaid dump contains expected nodes and transitions', () => {
  const out = dumpMermaid(GRAPHS.discover);
  assert.match(out, /%% graph: discover/);
  assert.match(out, /flowchart LR/);
  assert.match(out, /start\(\[entry\]\) --> drive/);
  assert.match(out, /drive -->\|"end_drive_unresolved"\| triage/);
  assert.match(out, /drive -->\|"resolved_via_save"\| terminal_closed/);
  assert.match(out, /triage -->\|"plan_handoff"\| lift/);
  assert.match(out, /lift -->\|"resolved_via_save"\| terminal_closed/);
});

test('map graph: drive ⇄ triage ⇄ lift with lift_observed_capability_invoked entry', () => {
  const out = dumpMermaid(GRAPHS.map);
  assert.match(out, /%% graph: map/);
  assert.match(out, /start\(\[entry\]\) --> drive/);
  // Lift cycle entry edges.
  assert.match(out, /drive -->\|"lift_observed_capability_invoked"\| triage/);
  assert.match(out, /lift -->\|"lift_observed_capability_invoked"\| triage/);
  // Triage → lift via the usual triage_plan checkpoint handoff.
  assert.match(out, /triage -->\|"plan_handoff"\| lift/);
  // Terminal closure from any phase.
  assert.match(out, /drive -->\|"end_drive_unresolved"\| terminal_closed/);
  assert.match(out, /lift -->\|"end_drive_unresolved"\| terminal_closed/);
  assert.match(out, /lift -->\|"resolved_via_save"\| terminal_closed/);
});

test('execute graph: guarded execute_failed renders [guarded] suffix', () => {
  const out = dumpMermaid(GRAPHS.execute);
  assert.match(out, /%% graph: execute/);
  assert.match(out, /start\(\[entry\]\) --> execute/);
  assert.match(out, /execute -->\|"execute_succeeded"\| terminal_closed/);
  assert.match(out, /execute -->\|"execute_failed \[guarded\]"\| triage/);
  assert.match(out, /execute -->\|"execute_failed"\| terminal_failed/);
});

test('dumpAllMermaid emits all three graphs separated by blank lines', () => {
  const out = dumpAllMermaid();
  assert.match(out, /%% graph: discover/);
  assert.match(out, /%% graph: map/);
  assert.match(out, /%% graph: execute/);
});
