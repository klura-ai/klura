// Klura vocabulary — single source of truth for every stable identifier
// that appears in agent-facing surfaces (tool names, audit classifier names,
// warning kinds, decision values, REFERENCE.md slugs).
//
// **Why this exists.** Identifiers like `start_session`, `re_persistence`, or
// `klura://reference#end-drive-audit` are referenced in many places: tool
// descriptions, audit code, error messages, REFERENCE.md prose, runtime
// template strings, tests. Every duplicated string literal is a drift
// surface. When one is renamed, every stale literal becomes either a broken
// link (for ref slugs), an unsearchable mention (for tool names), or a
// silently incorrect wire-format value (for audit/warning kinds).
//
// **How to use it.**
//
// In TS code that mentions a tool name, import the const map and reference
// the property:
//
//     import { TOOL_NAMES } from '../vocab';
//     const msg = `Call ${TOOL_NAMES.endDrive}({session_id: "${id}"})`;
//
// In tool descriptions (TOOL_DEF.description), use template literals:
//
//     description: `Call ${TOOL_NAMES.startSession} first. See ${refUrl(REF_LINKS.checkpoints)}.`
//
// Renaming a tool then becomes: edit ONE entry in TOOL_NAMES, tsc cascades
// the rename through every TS reference. The `check-vocab-leakage` lint
// script (runtime/scripts/) catches any bare string literal that didn't go
// through the const map.

// ---------- Tool names ----------

/** Every MCP-exposed tool. Add a new entry here when registering a new tool;
 *  the registry parity test asserts every TOOL_DEF.name appears here. */
export const TOOL_NAMES = {
  ackCheckpoint: 'ack_checkpoint',
  addDiscoveryNote: 'add_discovery_note',
  addResumePointer: 'add_resume_pointer',
  configure: 'configure',
  declareCapability: 'declare_capability',
  describeConfig: 'describe_config',
  endDrive: 'end_drive',
  evaluateOnFrame: 'evaluate_on_frame',
  explainWsFrameStructure: 'explain_ws_frame_structure',
  findInPage: 'find_in_page',
  findInWsFrame: 'find_in_ws_frame',
  getA11yTree: 'get_a11y_tree',
  getActionHistory: 'get_action_history',
  getAttribute: 'get_attribute',
  getConfig: 'get_config',
  getDiscoveryArtifactField: 'get_discovery_artifact_field',
  getEvents: 'get_events',
  getFrameScope: 'get_frame_scope',
  getJsSource: 'get_js_source',
  getNetworkLog: 'get_network_log',
  getPlatformLogbook: 'get_platform_logbook',
  getScreenshot: 'get_screenshot',
  getSecret: 'get_secret',
  getSendEncoder: 'get_send_encoder',
  getStrategy: 'get_strategy',
  getStrategyEvents: 'get_strategy_events',
  getStrategyHealth: 'get_strategy_health',
  inspectWsFrame: 'inspect_ws_frame',
  installPageInitScript: 'install_page_init_script',
  jsEval: 'js_eval',
  listBreakpoints: 'list_breakpoints',
  listInterruptionResolvers: 'list_interruption_resolvers',
  listLoadedScripts: 'list_loaded_scripts',
  listPlatformSkills: 'list_platform_skills',
  patchStep: 'patch_step',
  performAction: 'perform_action',
  pinWsFrame: 'pin_ws_frame',
  readJsFunction: 'read_js_function',
  recordObservedCapability: 'record_observed_capability',
  removeBreakpoint: 'remove_breakpoint',
  removePageInitScript: 'remove_page_init_script',
  resolveInterruption: 'resolve_interruption',
  restartRuntime: 'restart_runtime',
  resume: 'resume',
  resumeExecution: 'resume_execution',
  saveStrategy: 'save_strategy',
  saveVerifiedExpression: 'save_verified_expression',
  searchJsSource: 'search_js_source',
  setBreakpoint: 'set_breakpoint',
  startListener: 'start_listener',
  startRemoteSession: 'start_remote_session',
  startSession: 'start_session',
  step: 'step',
  stopListener: 'stop_listener',
  stopRemoteSession: 'stop_remote_session',
  submitTriagePlan: 'submit_triage_plan',
  triggerReferenceSend: 'trigger_reference_send',
  tryGenerator: 'try_generator',
  tryGeneratorInPage: 'try_generator_in_page',
  waitForPause: 'wait_for_pause',
  waitForRemote: 'wait_for_remote',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

// ---------- Audit classifier + detector names ----------

/** Wire-format kind strings for end-drive-audit + save-strategy-audit
 *  Detectors and Classifiers. Match the `kind:` literal on each Detector /
 *  Classifier object in runtime/src/audit/. The audit framework uses these
 *  as discriminators in the rejection envelope. */
export const AUDIT_KINDS = {
  // End-drive audit
  capabilityDeclarationRequired: 'capability_declaration_required',
  saveAttemptedNoneLanded: 'save_attempted_none_landed',
  rePersistence: 're_persistence',
  triageAcknowledgment: 'triage_acknowledgment',
  // Save-strategy audit (Detectors + Classifiers — frequently referenced)
  userConfirmation: 'user_confirmation',
  literalProvenance: 'literal_provenance',
  noSelectorSelfReference: 'no_selector_self_reference',
  unobservedUrl: 'unobserved_url',
  surfaceTriageMissing: 'surface_triage_missing',
  tierBelowTriageVerdict: 'tier_below_triage_verdict',
  tierJustificationUnciteable: 'tier_justification_unciteable',
} as const;

export type AuditKind = (typeof AUDIT_KINDS)[keyof typeof AUDIT_KINDS];

// ---------- Save-time warning kinds ----------

/** Wire-format kind strings for save-time warnings. Used in
 *  notes.save_warnings_acked entries. */
export const WARNING_KINDS = {
  unparametrizedSessionId: 'unparametrized_session_id',
  unresolvedNameToIdGap: 'unresolved_name_to_id_gap',
  entityPinnedInfraPrereq: 'entity_pinned_infra_prereq',
  enumValueBakedIntoSlug: 'enum_value_baked_into_slug',
  enumParamListingUnfactored: 'enum_param_listing_unfactored',
  recordedPathInlinesLookup: 'recorded_path_inlines_lookup',
  ungroundedEnumPlaceholder: 'ungrounded_enum_placeholder',
  lookupEmbeddedInPrereq: 'lookup_embedded_in_prereq',
  multiFetchInlinePrereq: 'multi_fetch_inline_prereq',
  parameterizationDisclosureRequired: 'parameterization_disclosure_required',
  unreferencedPrereqBinding: 'unreferenced_prereq_binding',
} as const;

export type WarningKind = (typeof WARNING_KINDS)[keyof typeof WARNING_KINDS];

// ---------- Audit decision values ----------

/** Wire-format values for user_confirmation.user_decision and similar
 *  approve/reject classifier answers. */
export const DECISION_VALUES = {
  approve: 'approve',
  reject: 'reject',
  acknowledgeNoProgress: 'acknowledge_no_progress',
  acknowledged: 'acknowledged',
} as const;

export type DecisionValue = (typeof DECISION_VALUES)[keyof typeof DECISION_VALUES];

// ---------- REFERENCE.md slug links ----------

/** Slugs of `## ` and `#### ` headers in runtime/REFERENCE.md, addressed via
 *  `klura://reference#<slug>` URLs in agent-facing surfaces. The
 *  check-ref-links lint script asserts each entry resolves to a real header.
 *  When adding a new entry, add the matching `## <Header>` or `#### <Header>`
 *  in REFERENCE.md in the same change. */
export const REF_LINKS = {
  capabilityCache: 'capability-cache',
  capabilityParameters: 'capability-parameters',
  capabilityPrereq: 'capability-prereq',
  checkpoints: 'checkpoints',
  configure: 'configure',
  debuggerSurface: 'debugger-surface',
  discoveryArtifact: 'discovery-artifact',
  endDriveAudit: 'end-drive-audit',
  enumParams: 'enum-params',
  executeErrorsClassificationAndRecovery: 'execute-errors-classification-and-recovery',
  fetchSchema: 'fetch-schema',
  graphs: 'graphs',
  identities: 'identities',
  interruptions: 'interruptions',
  interrupts: 'interrupts',
  jsEval: 'js-eval',
  networkLogDiscoveryWorkflow: 'network-log-discovery-workflow',
  observedCapabilities: 'observed-capabilities',
  pageScriptAnchors: 'page-script-anchors',
  parameterizationDisclosureRequired: 'parameterization-disclosure-required',
  pageScriptSchema: 'page-script-schema',
  platformSurfaceMap: 'platform-surface-map',
  popups: 'popups',
  rePatternChoice: 're-pattern-choice',
  recordedPathSchema: 'recorded-path-schema',
  tryGenerator: 'try-generator',
  rediscoverGate: 'rediscover-gate',
  reverseEngineerMode: 'reverse-engineer-mode',
  reverseEngineerPlaybook: 'reverse-engineer-playbook',
  saveStrategyAudit: 'save-strategy-audit',
  selfVerifyingStrategies: 'self-verifying-strategies',
  stepHealingResponseFormat: 'step-healing-response-format',
  strategySchemasOverview: 'strategy-schemas-overview',
  tagPrereq: 'tag-prereq',
  triage: 'triage',
  triageSurfaceBinding: 'triage-surface-binding',
  websocketProtocol: 'websocket-protocol',
} as const;

export type RefLink = (typeof REF_LINKS)[keyof typeof REF_LINKS];

/** Build the full klura://reference#<slug> URL. Type-safe — `slug` must be a
 *  REF_LINKS value. */
export function refUrl(slug: RefLink): string {
  return `klura://reference#${slug}`;
}
