// Tool phase/session policy — the contract half of phase admissibility.
//
// `ToolDef.phasePolicy` (public/mcp-tool.ts) declares WHICH policy a tool
// carries; the host-side projection in phases/tool-catalog.ts derives the
// per-phase admissibility sets from the registry. This module owns the
// vocabulary so the public contracts layer never imports host modules;
// phases/types.ts re-exports these names for host-side consumers.

/** Every session phase, in canonical order. `SessionPhase` derives from this
 *  array; iteration sites (catalog derivation, half-initialized-session
 *  checks, tests) use the array so a new phase lands everywhere at once. */
export const SESSION_PHASES = ['drive', 'triage', 'lift', 'execute'] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];

/** Phase-admissibility categories a ToolDef can declare via `phasePolicy`.
 *  Each category maps to a fixed set of phases (`CATEGORY_PHASES` in
 *  `tool-catalog.ts`); the per-phase allowed-tool sets are derived from the
 *  registry, so a tool's phase membership lives on its own TOOL_DEF.
 *
 *  - `universal` — admissible in every phase AND on finalized sessions
 *    (control plane, memory reads, escape-to-human, admin). Bypasses phase
 *    specs entirely and burns no round budget.
 *  - `none` — never session-gated. Tools that take no `session_id` (consumer
 *    / package tools, cross-session reads) and thus never reach the phase
 *    middleware.
 *  - every other category — phase-scoped: admissible only in its mapped
 *    phases, and each admitted call ticks the current phase's round counter
 *    and registers one pool-level user round. */
export const TOOL_PHASE_CATEGORIES = [
  'universal',
  'read_only_diagnostic',
  'discovery_artifact',
  'logbook_write',
  'triage_and_lift_write',
  'strategy_amend',
  'map_lift_initiator',
  'drive_active',
  'capability_declaration',
  'escape_valve',
  'lift_re_active',
  'none',
] as const;

export type ToolPhaseCategory = (typeof TOOL_PHASE_CATEGORIES)[number];

/** A tool's phase / session policy, declared on its `ToolDef` and projected
 *  into the per-phase admissibility sets by `tool-catalog.ts`. */
export interface ToolPhasePolicy {
  category: ToolPhaseCategory;
  /** Phases the tool is admissible in beyond its category's mapping —
   *  per-tool exceptions (e.g. `perform_action` is drive_active but also
   *  admitted in lift to generate the request being reverse-engineered).
   *  Must not repeat a phase the category already grants. */
  extraPhases?: readonly SessionPhase[];
  /** Phases in which the tool stays admissible after the round budget is
   *  exhausted (`softBlockEngaged`). Subset of the tool's admissible phases.
   *  Phase-exit and honest-abort tools declare this so a budget-exhausted
   *  session always has a way out. */
  allowedWhenExhaustedIn?: readonly SessionPhase[];
}
