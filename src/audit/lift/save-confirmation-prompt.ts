// Compose the user-facing prompt the agent reads aloud at save time. Pure
// function from a Strategy + ctx to a 2-4 sentence summary that surfaces the
// shape of the proposed save so the user can make an informed accept/reject
// call.
//
// Tier-agnostic: covers fetch / page-script / recorded-path uniformly.
// Describes the save without judgement language ("lowest tier", "fold path"
// avoided) — the user makes the quality call, not the prompt.

import type { Strategy } from '../../strategies/skills';
import type { SaveStrategyCtx } from './save-strategy';

interface NormalizedStrategy {
  tier: string;
  endpoint?: string;
  baseUrl?: string;
  method?: string;
  steps?: unknown[];
  prerequisites?: unknown[];
  notes?: Record<string, unknown>;
  runtime_meta?: Record<string, unknown>;
  transport?: string;
}

function asNormalized(strategy: Strategy): NormalizedStrategy {
  const s = strategy as unknown as Record<string, unknown>;
  return {
    tier: typeof s.strategy === 'string' ? s.strategy : 'unknown',
    endpoint: typeof s.endpoint === 'string' ? s.endpoint : undefined,
    baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : undefined,
    method: typeof s.method === 'string' ? s.method : undefined,
    steps: Array.isArray(s.steps) ? s.steps : undefined,
    prerequisites: Array.isArray(s.prerequisites) ? s.prerequisites : undefined,
    notes:
      s.notes && typeof s.notes === 'object' ? (s.notes as Record<string, unknown>) : undefined,
    runtime_meta:
      s.runtime_meta && typeof s.runtime_meta === 'object'
        ? (s.runtime_meta as Record<string, unknown>)
        : undefined,
    transport: typeof s.transport === 'string' ? s.transport : undefined,
  };
}

function describePrereqs(prereqs: unknown[]): string {
  if (prereqs.length === 0) return 'no prereqs';
  const kindCounts = new Map<string, number>();
  for (const raw of prereqs) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = (raw as { kind?: unknown }).kind;
    const k = typeof kind === 'string' ? kind : 'unknown';
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [k, n] of kindCounts) parts.push(`${n} ${k}`);
  return `${prereqs.length} prereq${prereqs.length === 1 ? '' : 's'} (${parts.join(', ')})`;
}

function describeAnchor(anchor_type: unknown): string {
  switch (anchor_type) {
    case 'module':
      return 'module-anchored (calls a module the page itself calls — high durability)';
    case 'protocol':
      return 'protocol-anchored (builds the wire-level payload — highest durability)';
    case 'dom':
      return 'dom-anchored (drives the UI from inside js_eval; selectors might break on UI refactors)';
    case 'unknown':
    case undefined:
    case null:
      return 'unclassified anchor (treated as fragile)';
    default:
      return `anchor_type "${String(anchor_type)}"`;
  }
}

function describeSteps(steps: unknown[]): string {
  if (steps.length === 0) return '0 steps';
  const actionCounts = new Map<string, number>();
  let a11yLocators = 0;
  let cssOnlyLocators = 0;
  for (const raw of steps) {
    if (!raw || typeof raw !== 'object') continue;
    const step = raw as { action?: unknown; locators?: unknown };
    const action = typeof step.action === 'string' ? step.action : 'unknown';
    actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
    if (step.locators && typeof step.locators === 'object') {
      const locs = step.locators as Record<string, unknown>;
      if (locs.a11y) a11yLocators += 1;
      else if (locs.css) cssOnlyLocators += 1;
    }
  }
  const actionsSummary: string[] = [];
  for (const [a, n] of actionCounts) actionsSummary.push(`${n}× ${a}`);
  let stability: string;
  if (a11yLocators > cssOnlyLocators) {
    stability = 'a11y-anchored locators (durable)';
  } else if (cssOnlyLocators > 0) {
    stability = 'CSS-only locators (may break on UI refactors)';
  } else {
    stability = 'no locator info';
  }
  return `${steps.length} step${steps.length === 1 ? '' : 's'} (${actionsSummary.join(', ')}); ${stability}`;
}

function describeWarnings(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const warnings = meta.save_warnings;
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  const kinds = new Set<string>();
  for (const w of warnings) {
    if (w && typeof w === 'object') {
      const k = (w as { kind?: unknown }).kind;
      if (typeof k === 'string') kinds.add(k);
    }
  }
  if (kinds.size === 0) return null;
  const quoted = Array.from(kinds, (k) => `"${k}"`).join(', ');
  return `save_warnings detected: ${quoted}`;
}

/**
 * Compose the user-facing prompt for a proposed save. Deterministic given
 * the strategy — same strategy, same prompt, same audit-token hash.
 */
export function composeUserPrompt(strategy: Strategy, ctx: SaveStrategyCtx): string {
  const s = asNormalized(strategy);
  const lines: string[] = [];

  // Headline: tier + capability + targeting.
  if (s.tier === 'fetch' || s.tier === 'page-script') {
    let where: string;
    if (s.endpoint) {
      const fullPath = s.baseUrl ? s.baseUrl + s.endpoint : s.endpoint;
      where = `${s.method ?? 'GET'} ${fullPath}`;
    } else {
      where = s.baseUrl ?? '<no endpoint>';
    }
    const transportNote =
      s.transport === 'browser' ? ' (browser-bound — fires from inside the page)' : '';
    lines.push(
      `Proposed save for capability "${ctx.capability}": ${s.tier} → ${where}${transportNote}.`,
    );
  } else if (s.tier === 'recorded-path') {
    const stepDesc = describeSteps(s.steps ?? []);
    lines.push(`Proposed save for capability "${ctx.capability}": recorded-path with ${stepDesc}.`);
  } else {
    lines.push(`Proposed save for capability "${ctx.capability}": tier "${s.tier}".`);
  }

  // Anchor type for page-script.
  if (s.tier === 'page-script') {
    const anchor = s.notes && s.notes.anchor_type;
    lines.push(`Anchor: ${describeAnchor(anchor)}.`);
  }

  // Prereq summary for fetch / page-script.
  if (s.tier === 'fetch' || s.tier === 'page-script') {
    lines.push(`Prereqs: ${describePrereqs(s.prerequisites ?? [])}.`);
  }

  // Warnings, if any are stamped on runtime_meta.
  const warningsLine = describeWarnings(s.runtime_meta);
  if (warningsLine) lines.push(warningsLine + '.');

  lines.push(`Save this strategy? (yes / no, with a one-line reason if no)`);
  return lines.join(' ');
}
