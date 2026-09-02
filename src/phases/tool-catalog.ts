// Phase tool catalog — a derived projection over TOOL_REGISTRY.
//
// Each ToolDef declares its own phase admissibility via `phasePolicy`
// (category + optional per-tool extra phases + exhausted-set membership).
// This module projects those declarations into the per-phase allowed /
// exhausted sets the phase specs consume, and into the `UNIVERSAL_TOOLS`
// bypass set the middleware checks first. A tool that exists in the
// registry always has a policy (the `phasePolicy` field is required on
// `ToolDef`), and a name can only appear in a phase set by being a
// registered tool — catalog entries without a backing tool are impossible
// by construction. `runtime/test/registry-parity.test.js` locks the
// projection down.
//
// Derivation is lazy: tool modules import `phases/*` at module scope, so an
// eager top-level import of `../tools/registry` here would form an
// init-order cycle with partially-initialized exports. The registry is
// required inside the derivation function, on the first admissibility
// check — long after module init.

import type { SessionPhase, ToolPhaseCategory, ToolPhasePolicy } from './types';
import { SESSION_PHASES } from './types';
import type { ToolDef } from '../public/mcp-tool';

/** Phase composition per category. `universal` and `none` map to no phase:
 *  universal tools bypass phase specs entirely (admitted everywhere,
 *  including finalized sessions, via the middleware short-circuit), and
 *  `none` tools are never session-gated.
 *
 *  Category rationale:
 *  - `read_only_diagnostic` — read-only investigation, admissible in every
 *    agent-driven phase. `get_a11y_tree` lives here because the trimmed tree
 *    returned by `perform_action` truncates around the 15 KB mark; agents
 *    legitimately need the full tree mid-drive.
 *  - `discovery_artifact` — discovery-artifact persistence, reachable from
 *    drive because the end_drive re_persistence Detector demands at least
 *    one of these calls when the agent did heavy RE work it can't show a
 *    saved strategy for (end_drive fires the audit from drive).
 *  - `logbook_write` — cross-session platform_logbook write. Reachable from
 *    drive so map-mode agents can persist findings, and from triage/lift so
 *    the discover-graph audit prose telling the agent to call it during the
 *    audit loop actually works.
 *  - `triage_and_lift_write` — plan submission + strategy commit.
 *  - `strategy_amend` — amend an already-saved strategy without re-entering
 *    lift. Admissible from drive + lift + execute; the tool rejects when no
 *    saved strategy exists and runs the full save audit, so phase
 *    admissibility can stay liberal.
 *  - `map_lift_initiator` — opens a triage+lift cycle on an already-observed
 *    capability without ending the map session. Drive (first lift) and lift
 *    (subsequent capability after a save) — NOT triage: an active plan
 *    should resolve before a new capability bumps it. The tool itself
 *    rejects on non-map sessions, so phase admissibility stays
 *    graph-agnostic.
 *  - `drive_active` — UI-driving tools + the drive-phase exit.
 *    `start_session` is here for completeness; the middleware skips
 *    admissibility for tools called without a live session.
 *  - `capability_declaration` — agents routinely realise mid-flow (triage
 *    plan composition, lift save authoring) that the strategy needs a
 *    sibling capability declared. Append-only state, no phase-specific
 *    internal logic — structurally safe in every non-closed phase.
 *  - `escape_valve` — the honest-exit primitive, admissible in every
 *    non-closed phase. NOT universal: calling abort on a finalized session
 *    is a phase rejection.
 *  - `lift_re_active` — active reverse-engineering tools, lift-only. */
export const CATEGORY_PHASES: Record<ToolPhaseCategory, readonly SessionPhase[]> = {
  universal: [],
  none: [],
  read_only_diagnostic: ['drive', 'triage', 'lift'],
  discovery_artifact: ['drive', 'triage', 'lift'],
  logbook_write: ['drive', 'triage', 'lift'],
  triage_and_lift_write: ['triage', 'lift'],
  strategy_amend: ['drive', 'lift', 'execute'],
  map_lift_initiator: ['drive', 'lift'],
  drive_active: ['drive'],
  capability_declaration: ['drive', 'triage', 'lift'],
  escape_valve: ['drive', 'triage', 'lift'],
  lift_re_active: ['lift'],
};

interface DerivedCatalog {
  universal: ReadonlySet<string>;
  allowed: Record<SessionPhase, ReadonlySet<string>>;
  exhausted: Record<SessionPhase, ReadonlySet<string>>;
  policies: ReadonlyMap<string, ToolPhasePolicy>;
}

let derivedCatalog: DerivedCatalog | undefined;

/** Phases a policy admits the tool in (category mapping + extras).
 *  `universal` is empty here by design — the middleware short-circuit
 *  handles it before any phase spec is consulted. */
function admissiblePhases(policy: ToolPhasePolicy): SessionPhase[] {
  return [...CATEGORY_PHASES[policy.category], ...(policy.extraPhases ?? [])];
}

function deriveCatalog(): DerivedCatalog {
  if (derivedCatalog) return derivedCatalog;
  // Lazy require — see the head comment for why this must not be a
  // top-level import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registryModule = require('../tools/registry') as typeof import('../tools/registry');
  const registry: ToolDef[] | undefined = registryModule.TOOL_REGISTRY;
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error(
      'phase tool catalog derived while ../tools/registry is still initializing — ' +
        'a module in the phases/tools import graph is forcing derivation at module ' +
        'top level. Defer the first admissibility / UNIVERSAL_TOOLS access until ' +
        'after startup (first tool call).',
    );
  }

  const issues: string[] = [];
  const universal = new Set<string>();
  const allowed: Record<SessionPhase, Set<string>> = {
    drive: new Set(),
    triage: new Set(),
    lift: new Set(),
    execute: new Set(),
  };
  const exhausted: Record<SessionPhase, Set<string>> = {
    drive: new Set(),
    triage: new Set(),
    lift: new Set(),
    execute: new Set(),
  };
  const policies = new Map<string, ToolPhasePolicy>();

  for (const def of registry) {
    const policy = def.phasePolicy as ToolPhasePolicy | undefined;
    if (!policy || typeof policy !== 'object') {
      issues.push(`tool '${def.name}' has no phasePolicy — every ToolDef must declare one`);
      continue;
    }
    if (!(policy.category in CATEGORY_PHASES)) {
      issues.push(`tool '${def.name}' declares unknown phasePolicy.category '${policy.category}'`);
      continue;
    }
    policies.set(def.name, policy);
    const categoryPhases = CATEGORY_PHASES[policy.category];
    if (policy.category === 'universal' || policy.category === 'none') {
      if (policy.extraPhases?.length || policy.allowedWhenExhaustedIn?.length) {
        issues.push(
          `tool '${def.name}' (category '${policy.category}') must not declare extraPhases ` +
            `or allowedWhenExhaustedIn — the category is not phase-scoped`,
        );
      }
      if (policy.category === 'universal') universal.add(def.name);
      continue;
    }
    for (const phase of policy.extraPhases ?? []) {
      if (categoryPhases.includes(phase)) {
        issues.push(
          `tool '${def.name}': extraPhases repeats '${phase}', which category ` +
            `'${policy.category}' already grants`,
        );
      }
    }
    const phases = admissiblePhases(policy);
    for (const phase of phases) allowed[phase].add(def.name);
    for (const phase of policy.allowedWhenExhaustedIn ?? []) {
      if (!phases.includes(phase)) {
        const extrasFragment = policy.extraPhases?.length
          ? ` + extraPhases [${policy.extraPhases.join(', ')}]`
          : '';
        issues.push(
          `tool '${def.name}': allowedWhenExhaustedIn includes '${phase}' but the tool ` +
            `is not admissible in that phase (category '${policy.category}'${extrasFragment})`,
        );
        continue;
      }
      exhausted[phase].add(def.name);
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `phase tool catalog derivation failed — ${issues.length} issue(s), fix all before retrying:\n` +
        issues.map((s) => `  - ${s}`).join('\n'),
    );
  }

  derivedCatalog = { universal, allowed, exhausted, policies };
  return derivedCatalog;
}

/** ReadonlySet facade whose backing set is computed on first access. Lets
 *  phase specs bind their `allowedTools` at module init without forcing
 *  the registry derivation during module load. */
class DerivedToolSet implements ReadonlySet<string> {
  constructor(private readonly select: () => ReadonlySet<string>) {}
  private get backing(): ReadonlySet<string> {
    return this.select();
  }
  has(value: string): boolean {
    return this.backing.has(value);
  }
  get size(): number {
    return this.backing.size;
  }
  forEach(
    callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ): void {
    this.backing.forEach(callbackfn, thisArg);
  }
  entries(): SetIterator<[string, string]> {
    return this.backing.entries();
  }
  keys(): SetIterator<string> {
    return this.backing.keys();
  }
  values(): SetIterator<string> {
    return this.backing.values();
  }
  [Symbol.iterator](): SetIterator<string> {
    return this.backing[Symbol.iterator]();
  }
}

/** Tools admissible in every phase AND on finalized sessions (control plane
 *  + memory reads + escape-to-human + admin). The phase machine never
 *  considers these, and they burn no round budget. Derived from the
 *  registry: every ToolDef whose `phasePolicy.category` is 'universal'. */
export const UNIVERSAL_TOOLS: ReadonlySet<string> = new DerivedToolSet(
  () => deriveCatalog().universal,
);

function perPhaseSets(
  select: (catalog: DerivedCatalog) => Record<SessionPhase, ReadonlySet<string>>,
): Record<SessionPhase, ReadonlySet<string>> {
  const out = {} as Record<SessionPhase, ReadonlySet<string>>;
  for (const phase of SESSION_PHASES) {
    out[phase] = new DerivedToolSet(() => select(deriveCatalog())[phase]);
  }
  return out;
}

const allowedByPhase = perPhaseSets((catalog) => catalog.allowed);
const exhaustedByPhase = perPhaseSets((catalog) => catalog.exhausted);

/** Tools admissible in `phase` (universal tools excluded — those bypass the
 *  phase spec via the middleware short-circuit). */
export function phaseAllowedTools(phase: SessionPhase): ReadonlySet<string> {
  return allowedByPhase[phase];
}

/** Tools that remain admissible in `phase` once its round budget is
 *  exhausted (`softBlockEngaged`). Subset of `phaseAllowedTools(phase)`. */
export function phaseExhaustedTools(phase: SessionPhase): ReadonlySet<string> {
  return exhaustedByPhase[phase];
}

/** Every registered tool's phase policy, keyed by tool name. Read by the
 *  parity tests; not consulted on the per-call admissibility path. */
export function toolPhasePolicies(): ReadonlyMap<string, ToolPhasePolicy> {
  return deriveCatalog().policies;
}
