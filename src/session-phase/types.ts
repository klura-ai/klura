// Session-phase architectural primitives.
//
// A session belongs to one of three named graphs (discover | map | execute);
// each graph is a small declarative state machine over a shared set of
// phases. The phase enum is graph-agnostic (drive | triage | lift | execute);
// terminal-ness is a property of the Graph node, not the phase enum, and
// session.status carries 'active' | 'closed' | 'failed'.
//
// Adding a tool to a phase = a one-line edit to that phase's PhaseSpec. Adding
// a graph = one new file in graphs/, no cross-cutting wiring.

import type { Session } from '../drivers/types/session';
import type { DaemonConfig } from '../config/handler';

export type SessionPhase = 'drive' | 'triage' | 'lift' | 'execute';

export type GraphName = 'discover' | 'map' | 'execute';

export type SessionStatus = 'active' | 'closed' | 'failed';

/** Terminal node in a Graph's transition table. Ends the FSM and stamps
 *  session.status. Distinct from SessionPhase — terminal-ness is a
 *  property of the graph topology, not a phase the agent occupies. */
export interface TerminalNode {
  kind: 'terminal';
  status: SessionStatus;
}

export function isTerminal(target: SessionPhase | TerminalNode): target is TerminalNode {
  return typeof target === 'object';
}

/** Discriminated event kinds the state machine accepts. Any caller that
 *  wants to mutate phase must dispatch one of these — there is no other
 *  way. Out-of-band writes to session.phase are forbidden by code review;
 *  the principle is: if it isn't an event here, it shouldn't change phase. */
export type PhaseEventKind =
  | 'end_drive_unresolved' // drive -> triage
  | 'plan_submitted' // triage -> triage (with side effects); lift -> triage
  | 'plan_handoff' // triage -> lift. Unconditional handoff via the triage_plan checkpoint; the agent classifies the user's ack reply downstream and either proceeds or calls submit_triage_plan again.
  | 'surface_changed' // lift -> triage; triage self-loop. Emitted by perform_action when navigation crosses to an un-triaged surface.
  | 'resolved_via_save' // drive | triage | lift -> terminal{closed}
  | 'execute_succeeded' // execute -> terminal{closed} (graph: 'execute' only)
  | 'execute_failed'; // execute -> triage (gate fires) | terminal{failed} (gate doesn't fire)

export interface PhaseEvent {
  kind: PhaseEventKind;
  /** Event-specific payload travels alongside the kind. Guard predicates
   *  read the payload to decide between alternate transitions for the same
   *  event kind (e.g. `execute_failed` with a stale-strategy snapshot vs.
   *  one with a structural error). */
  payload?: unknown;
}

/** Per-phase mutable bookkeeping. The drive / triage / lift / execute
 *  fields on Session each conform to this. */
export interface PhaseStateData {
  enteredAt: number;
  /** Increments on every admitted tool call while the session is in this
   *  phase. Reset to 0 by the state machine when entering or self-looping
   *  into the phase. lift conventionally calls this `roundsSinceHandoff`
   *  but the meaning is identical. */
  roundsSinceEntry: number;
  /** Resolved at phase entry from `config.<phase>.max_rounds`; `0` means
   *  unlimited and short-circuits the soft-block check. */
  budget: number;
  /** Becomes true when `roundsSinceEntry >= budget && budget > 0`. While
   *  set, only `allowedToolsWhenExhausted` admit; everything else is
   *  rejected by the middleware. */
  softBlockEngaged: boolean;
}

export type AdmissibilityResult = { ok: true } | { ok: false; reason: string };

/** Per-graph configuration. Flat, graph-wide. Knobs describe the *behavior*,
 *  not the graph; each graph definition opts in to whichever knobs it needs.
 *  Callers read these via `graphConfig(session)`. */
export interface GraphConfig {
  /** When true, mutating perform_action calls (POST/PUT/DELETE on bound XHRs,
   *  destructive-text clicks) gate on a per-(action, selector) consent
   *  checkpoint. Read by perform_action during drive. Map graph turns this on. */
  gateMutatingActions?: boolean;
  /** When true, end-drive does not auto-synthesize a recorded-path
   *  fallback strategy from perform_action history. Map graph turns this on. */
  skipAutoSynth?: boolean;
  /** When true, end-drive infers observed capabilities from declared
   *  args + captured XHR bodies even when `declaredCapabilities` is empty.
   *  Map graph turns this on. */
  inferObservedCapabilitiesAtClose?: boolean;
  /** When true, the end-drive declaration-required short-circuit fires
   *  immediately (declared capabilities are not required for a clean close).
   *  Map graph turns this on. */
  skipDeclarationGuard?: boolean;
  /** Re-persistence audit threshold. Fires the gate when the agent has made
   *  `actions` perform_action calls with fewer than `reCalls` save-strategy /
   *  persistence calls. Map graph tightens this; discover/execute leave
   *  unset (gate inactive). */
  rePersistenceThreshold?: { reCalls: number; actions: number };
  /** Obligation-prose flavor surfaced in start_session result hints and
   *  middleware messages. */
  obligationStyle?: 'lift_required' | 'flush_reminder' | 'none';
  /** Optional `_hint` attached to start_session response. */
  startSessionHint?: string;
}

/** A phase's full behavior in one object. The state machine is a tiny
 *  dispatcher over a small registry of PhaseSpec instances. PhaseSpec is
 *  per-phase (drive does the same job in any graph that contains it);
 *  per-graph variation lives in GraphConfig. */
export interface PhaseSpec {
  readonly name: SessionPhase;

  /** Tools admissible while in this phase. Universal tools (e.g.
   *  ack_checkpoint, list_platform_skills) are NOT in this set — the registry's
   *  UNIVERSAL_TOOLS set bypasses the spec entirely for those. */
  readonly allowedTools: ReadonlySet<string>;

  /** When `softBlockEngaged === true`, only these tools are admitted.
   *  Subset of allowedTools by definition. */
  readonly allowedToolsWhenExhausted: ReadonlySet<string>;

  /** Initialize this phase's bookkeeping on entry. Resolves the budget
   *  from config, zeros the counter, clears softBlockEngaged. `event` is
   *  the PhaseEvent that triggered the transition (null for forced
   *  transitions); phases that need to distinguish how they were entered
   *  (e.g. lift treats `surface_changed` as fresh budget but
   *  `plan_submitted` re-entry as preserve-counter) read it. */
  onEnter(
    session: Session,
    ctx: { config: DaemonConfig; graphConfig: GraphConfig; event: PhaseEvent | null },
  ): void;

  /** Composite admissibility: phase membership + exhausted-set narrowing.
   *  Tool-body audits (e.g. surface_triage_missing) are structurally
   *  orthogonal and run inside the tool body, after admissibility passes. */
  checkAdmissibility(
    toolName: string,
    session: Session,
    graphConfig: GraphConfig,
  ): AdmissibilityResult;

  /** Prefix prose surfaced when the budget is exhausted. The hard block
   *  already happens via checkAdmissibility — this is purely informative
   *  for the agent's next prompt. */
  exhaustedPrefix(session: Session): string;
}

/** A transition entry in a Graph's transition table. Optional `when` guard
 *  lets a single event kind branch to different destinations based on the
 *  payload (e.g. `execute_failed` → triage when the rediscover gate fires;
 *  → terminal{failed} otherwise). The first matching entry in array order
 *  wins; entries with `when` should appear before unguarded fallbacks for
 *  the same `from`+`on`. */
export interface GraphTransition {
  from: SessionPhase;
  on: PhaseEventKind;
  to: SessionPhase | TerminalNode;
  when?: (session: Session, payload: unknown) => boolean;
}

/** A named state machine. Three graphs ship: discover (drive→triage→lift→
 *  closed), map (drive→closed), execute (execute→triage→lift→closed|failed).
 *  A new graph is one new file in graphs/ that exports a Graph literal. */
export interface Graph {
  readonly name: GraphName;
  readonly entryPhase: SessionPhase;
  readonly nodes: ReadonlySet<SessionPhase>;
  readonly transitions: ReadonlyArray<GraphTransition>;
  readonly config: Readonly<GraphConfig>;
}

/** Returned by `dispatch` / `forceTransition`. Useful for trace logging
 *  / telemetry. `event` is `null` for forced transitions (those don't
 *  carry an originating PhaseEvent). `to` is either the destination phase
 *  the session now occupies, or a TerminalNode if the graph ended. */
export interface TransitionResult {
  from: SessionPhase;
  to: SessionPhase | TerminalNode;
  event: PhaseEventKind | null;
  at: number;
}

export class SessionPhaseTransitionError extends Error {
  constructor(
    public readonly from: SessionPhase,
    public readonly event: PhaseEventKind,
  ) {
    super(`illegal transition: ${event} not legal from phase '${from}'`);
    this.name = 'SessionPhaseTransitionError';
  }
}

export class ToolNotAdmissibleError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly phase: SessionPhase | 'terminal',
    public readonly reason: string,
  ) {
    super(reason);
    this.name = 'ToolNotAdmissibleError';
  }
}
