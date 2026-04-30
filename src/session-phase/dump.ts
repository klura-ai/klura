// Graph dumper — renders a Graph (or all graphs) as Mermaid source. The
// graph topology is data, not code, so any graph can be inspected,
// committed to a doc, or rendered in a CI artifact without running the
// runtime. Tests snapshot this output so transition changes show up as
// reviewable diffs.

import type { Graph, GraphTransition } from './types';
import { isTerminal } from './types';
import { GRAPHS } from './graphs';

function escape(label: string): string {
  return label.replace(/"/g, '\\"');
}

function targetId(t: GraphTransition['to']): string {
  if (isTerminal(t)) return `terminal_${t.status}`;
  return t;
}

function targetLabel(t: GraphTransition['to']): string {
  if (isTerminal(t)) return `terminal{${t.status}}`;
  return t;
}

export function dumpMermaid(graph: Graph): string {
  const lines: string[] = [];
  lines.push(`%% graph: ${graph.name}`);
  lines.push('flowchart LR');
  lines.push(`  start([entry]) --> ${graph.entryPhase}`);
  for (const node of graph.nodes) {
    lines.push(`  ${node}["${node}"]`);
  }
  const terminalsSeen = new Set<string>();
  for (const t of graph.transitions) {
    const dest = targetId(t.to);
    if (isTerminal(t.to) && !terminalsSeen.has(dest)) {
      terminalsSeen.add(dest);
      lines.push(`  ${dest}(("${escape(targetLabel(t.to))}"))`);
    }
    const guardSuffix = t.when ? ' [guarded]' : '';
    lines.push(`  ${t.from} -->|"${escape(t.on)}${guardSuffix}"| ${dest}`);
  }
  return lines.join('\n');
}

export function dumpAllMermaid(): string {
  return Object.values(GRAPHS).map(dumpMermaid).join('\n\n');
}
