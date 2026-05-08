// Single source of truth for which tools belong to which capability category.
// Each phase composes its allowedTools by unioning the relevant categories;
// adding or moving a tool is a one-line edit here, not a sweep across four
// phase modules. Categories are mutually orthogonal — a tool lives in
// exactly one set.
//
// Tool names match the registered MCP tool name (`mcp/tools.js`). When a new
// tool is added there, it must also be slotted into one of these sets — the
// MCP wrapper hard-blocks unknown tool names by default (no bypass).

/** Allowed in every non-closed phase AND in closed (control plane + memory
 *  reads + escape valve + admin). The phase machine never considers these. */
export const UNIVERSAL_TOOLS: ReadonlySet<string> = new Set([
  // Control plane
  'ack_checkpoint',
  'resolve_interruption',
  'list_interruption_resolvers',
  // Memory reads (cross-session learning)
  'list_platform_skills',
  'get_platform_logbook',
  'get_strategy',
  'get_strategy_events',
  'get_discovery_artifact_field',
  // Escape valve
  'start_remote_session',
  'stop_remote_session',
  'wait_for_remote',
  // Read-only config
  'describe_config',
  'get_config',
  'get_secret',
  // Admin / maintenance — rarely called inside an agent loop, but never
  // gated by phase when they are.
  'configure',
  'restart_runtime',
  'archive_strategy',
  'unarchive_strategy',
  'mark_healed',
  'demote_fetch_to_page_script',
]);

/** Read-only investigation tools. Allowed in drive, triage, and lift.
 *  `get_a11y_tree` lives here because the trimmed tree returned by
 *  `perform_action` truncates around the 15 KB mark; agents legitimately
 *  need the full tree mid-drive when the element they want lives outside
 *  that window (long lists, deeply nested content, popup trees). Forcing
 *  them into triage just to read the page DOM blocks the goal-directed
 *  path for a read-only operation. */
export const READ_ONLY_DIAGNOSTIC: ReadonlySet<string> = new Set([
  'get_network_log',
  'get_action_history',
  'get_a11y_tree',
  'find_in_page',
  'get_attribute',
  'get_screenshot',
  'get_js_source',
  'search_js_source',
  'read_js_function',
  'list_loaded_scripts',
  'inspect_ws_frame',
  'find_in_ws_frame',
  'pin_ws_frame',
  'explain_ws_frame_structure',
  'js_eval',
]);

/** Discovery-artifact persistence. Allowed in drive, triage, and lift —
 *  the end_drive re_persistence Classifier demands at least one of these
 *  calls when the agent did RE work, so they must be reachable from drive
 *  (where end_drive fires the audit). countPersistCalls in
 *  end-drive/orchestrator.ts sums against the same three. */
export const DISCOVERY_ARTIFACT: ReadonlySet<string> = new Set([
  'save_verified_expression',
  'add_discovery_note',
  'add_resume_pointer',
]);

/** Cross-session platform_logbook write — flags a sibling capability the
 *  agent observed but didn't lift. Semantically distinct from
 *  DISCOVERY_ARTIFACT (per-session artifact accumulator) and from
 *  TRIAGE_AND_LIFT_WRITE (plan/commit). Reachable from drive so map-mode
 *  agents (whose graph has only a drive phase) can persist findings, and
 *  from triage/lift so the discover-graph audit prose telling the agent to
 *  call it during the audit loop actually works. */
export const LOGBOOK_WRITE: ReadonlySet<string> = new Set(['record_observed_capability']);

/** Plan-submission + strategy commit. Allowed in triage and lift. */
export const TRIAGE_AND_LIFT_WRITE: ReadonlySet<string> = new Set([
  'save_strategy',
  'submit_triage_plan',
]);

/** UI-driving tools + the drive-phase exit. Drive-only. `start_session` is
 *  here for completeness; the middleware skips admissibility for tools
 *  called without a live session. */
export const DRIVE_ACTIVE: ReadonlySet<string> = new Set([
  'start_session',
  'perform_action',
  'end_drive',
  'declare_capability',
  'execute',
  'resume_execution',
]);

/** Honest-exit primitive. Admissible in every non-closed phase (drive,
 *  triage, lift) — when the agent realises the session shouldn't have started
 *  (existing capability covers the task, user said stop, site dead) the
 *  honest move is to abort cleanly, not satisfy the close-time audit with a
 *  fabricated declaration. NOT in `closed` — calling abort on a closed
 *  session is a phase rejection (and `pool.getSession` would already throw). */
export const ESCAPE_VALVE: ReadonlySet<string> = new Set(['abort_session']);

/** Active reverse-engineering tools. Lift-only. */
export const LIFT_RE_ACTIVE: ReadonlySet<string> = new Set([
  'try_generator',
  'try_generator_in_page',
  'get_send_encoder',
  'set_breakpoint',
  'remove_breakpoint',
  'list_breakpoints',
  'wait_for_pause',
  'get_frame_scope',
  'evaluate_on_frame',
  'step',
  'resume',
  'install_page_init_script',
  'remove_page_init_script',
  'trigger_reference_send',
  'patch_step',
  'start_listener',
  'stop_listener',
  'get_events',
]);

export function unionSets(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of sets) for (const x of s) out.add(x);
  return out;
}
