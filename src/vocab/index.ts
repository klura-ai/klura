// Klura vocabulary — single source of truth for every stable identifier
// that appears in agent-facing surfaces (tool names, audit classifier names,
// warning kinds, decision values, REFERENCE.md slugs).
//
// **Why this exists.** Identifiers like `start_session`, `re_persistence`, or
// `klura://reference#checkpoints` are referenced in many places: tool
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
// the rename through every TS reference. The lint scripts in
// runtime/scripts/ (check-ref-links.js, check-tool-names.js,
// check-no-static-synopses.js) catch stale slugs and hand-written synopses
// that bypassed the const maps.

// ---------- Tool names ----------

/** Every MCP-exposed tool. Add a new entry here when registering a new tool;
 *  the registry parity test asserts every TOOL_DEF.name appears here. */
export const TOOL_NAMES = {
  abortSession: 'abort_session',
  ackCheckpoint: 'ack_checkpoint',
  addDiscoveryNote: 'add_discovery_note',
  addResumePointer: 'add_resume_pointer',
  configure: 'configure',
  callPackageCapability: 'call_package_capability',
  clearPackageSession: 'clear_package_session',
  completePackageLogin: 'complete_package_login',
  cancelScrapeRun: 'cancel_scrape_run',
  declareCapability: 'declare_capability',
  discardScrapeRun: 'discard_scrape_run',
  describeConfig: 'describe_config',
  endDrive: 'end_drive',
  evaluateInIframe: 'evaluate_in_iframe',
  evaluateInIframeChain: 'evaluate_in_iframe_chain',
  evaluateInWorker: 'evaluate_in_worker',
  evaluateOnFrame: 'evaluate_on_frame',
  explainWsFrameStructure: 'explain_ws_frame_structure',
  exportPlatformPackage: 'export_platform_package',
  findInPage: 'find_in_page',
  findInWsFrame: 'find_in_ws_frame',
  getA11yTree: 'get_a11y_tree',
  getScrapeRun: 'get_scrape_run',
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
  installLocalPackage: 'install_local_package',
  installPackage: 'install_package',
  jsEval: 'js_eval',
  liftObservedCapability: 'lift_observed_capability',
  listBreakpoints: 'list_breakpoints',
  listInterruptionResolvers: 'list_interruption_resolvers',
  listInstalledPackages: 'list_installed_packages',
  listLoadedScripts: 'list_loaded_scripts',
  listPlatformSkills: 'list_platform_skills',
  listScrapeRunItems: 'list_scrape_run_items',
  listScrapeRuns: 'list_scrape_runs',
  patchStep: 'patch_step',
  openPackageLogin: 'open_package_login',
  performAction: 'perform_action',
  pinWsFrame: 'pin_ws_frame',
  readJsFunction: 'read_js_function',
  recordObservedCapability: 'record_observed_capability',
  runConsumerDoctor: 'run_consumer_doctor',
  removeBreakpoint: 'remove_breakpoint',
  removePackage: 'remove_package',
  removePageInitScript: 'remove_page_init_script',
  resolveInterruption: 'resolve_interruption',
  restartRuntime: 'restart_runtime',
  resume: 'resume',
  resumeScrapeRun: 'resume_scrape_run',
  resumeExecution: 'resume_execution',
  reviewStrategyCandidate: 'review_strategy_candidate',
  saveStrategy: 'save_strategy',
  updateStrategy: 'update_strategy',
  saveVerifiedExpression: 'save_verified_expression',
  searchJsSource: 'search_js_source',
  searchPackages: 'search_packages',
  setBreakpoint: 'set_breakpoint',
  startListener: 'start_listener',
  startScrapeRun: 'start_scrape_run',
  startRemoteSession: 'start_remote_session',
  startSession: 'start_session',
  step: 'step',
  stopListener: 'stop_listener',
  stopRemoteSession: 'stop_remote_session',
  submitTriagePlan: 'submit_triage_plan',
  showPackage: 'show_package',
  triggerReferenceSend: 'trigger_reference_send',
  tryGenerator: 'try_generator',
  tryGeneratorInPage: 'try_generator_in_page',
  waitForPause: 'wait_for_pause',
  waitForRemote: 'wait_for_remote',
  waitScrapeRun: 'wait_scrape_run',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

// ---------- Strategy tiers ----------

/** The three strategy tiers, in optimality order (fastest first). Canonical
 *  owner of the tier identifier set: TS unions derive from `StrategyTier`,
 *  Zod enums via `z.enum(STRATEGY_TIERS)`, MCP JSON-schema enums via
 *  `[...STRATEGY_TIERS]`, and per-tier metadata maps are typed
 *  `Record<StrategyTier, ...>` so tsc enforces coverage. Sites that need a
 *  different presentation order (e.g. policy caps listing recorded-path
 *  first) derive it explicitly from this array rather than re-declaring. */
export const STRATEGY_TIERS = ['fetch', 'page-script', 'recorded-path'] as const;

export type StrategyTier = (typeof STRATEGY_TIERS)[number];

// ---------- Prereq kinds ----------

/** Every prerequisite `kind`. Canonical owner of the prereq-kind identifier
 *  set — the per-kind Zod schemas live in
 *  `runtime/src/strategies/schemas/prereqs.ts`, whose registry is typed
 *  `satisfies Record<PrereqKind, ...>` so tsc enforces one schema per kind. */
export const PREREQ_KIND_VALUES = [
  'js-eval',
  'page-extract',
  'browser',
  'fetch-extract',
  'capability',
  'tag',
  'cached',
] as const;

export type PrereqKind = (typeof PREREQ_KIND_VALUES)[number];

// ---------- Session outcomes ----------

/** Wire-format values for `session_meta.outcome` in the working-dir capture
 *  stream (`SessionMetaPayload`) and per-capability `lift_attempt` records. */
export const SESSION_OUTCOMES = [
  'fetch_saved',
  'page_script_saved',
  'recorded_path_saved',
  'no_save',
  'user_deferred',
  'error',
] as const;

export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/** The saved-outcome value a landed strategy of each tier reports. Typed as a
 *  full record so adding a tier forces the outcome mapping to be decided. */
export const SAVED_OUTCOME_BY_TIER: Record<StrategyTier, SessionOutcome> = {
  fetch: 'fetch_saved',
  'page-script': 'page_script_saved',
  'recorded-path': 'recorded_path_saved',
};

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
  sensitiveActionMustBeRecordedNotSaved: 'sensitive_action_must_be_recorded_not_saved',
  capturedQueryParamMissingFromStrategy: 'captured_query_param_missing_from_strategy',
  authGatedWithoutAuthPrereq: 'auth_gated_without_auth_prereq',
  saveStrategyStructuralDeadEnd: 'save_strategy_structural_dead_end',
  // Triage-plan audit
  requestPatternUrlExtractable: 'request_pattern_url_extractable',
  requestPatternUrlObserved: 'request_pattern_url_observed',
  capabilityNotDeclared: 'capability_not_declared',
  recordedPathNavigateUrlUnbound: 'recorded_path_navigate_url_unbound',
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
  hardcodedPaginationValue: 'hardcoded_pagination_value',
  unansweredPaginationQuestion: 'unanswered_pagination_question',
  sideEffectPrereqUnproven: 'side_effect_prereq_unproven',
  callerArgBaked: 'caller_arg_baked',
  requiredParamWithoutExample: 'required_param_without_example',
} as const;

export type WarningKind = (typeof WARNING_KINDS)[keyof typeof WARNING_KINDS];

// ---------- Save origins ----------

/** Wire-format origin tags for strategy producers. Every persisted strategy
 *  routes through `evaluateSavePolicy({origin, ...})`
 *  (runtime/src/audit/lift/save-policy.ts); the origin selects how the
 *  saveStrategyAudit's detectors apply to that producer — differences between
 *  producers are expressed via origin, never by skipping the audit. */
export const SAVE_ORIGINS = {
  agentExplicit: 'agent_explicit',
  autoSynthFetch: 'auto_synth_fetch',
  autoSynthRecorded: 'auto_synth_recorded',
  graduation: 'graduation',
  programmatic: 'programmatic',
} as const;

export type SaveOrigin = (typeof SAVE_ORIGINS)[keyof typeof SAVE_ORIGINS];

// ---------- Audit decision values ----------

/** Wire-format values for user_confirmation.user_decision and similar
 *  approve/reject classifier answers. */
export const DECISION_VALUES = {
  approve: 'approve',
  reject: 'reject',
  acknowledged: 'acknowledged',
  verifiedSuccess: 'verified_success',
  verifiedFailure: 'verified_failure',
  inconclusive: 'inconclusive',
} as const;

export type DecisionValue = (typeof DECISION_VALUES)[keyof typeof DECISION_VALUES];

// ---------- Abort-ledger provenance ----------

/** Wire-format values for `abort_events[].provenance`. Says where the abort's
 *  classification came from, so replayed history is read as evidence of the
 *  right strength:
 *
 *   - `agent_asserted`  — the `kind` an agent passed to `abort_session`. A
 *     claim recorded by a prior session, never a runtime detection.
 *   - `runtime_observed` — the same claim, corroborated by the runtime's own
 *     origin-blocked detector firing on the aborted host during that session.
 *
 *  Historical ledger entries carry no field; readers default them to
 *  `agent_asserted`. */
export const ABORT_PROVENANCE_VALUES = ['agent_asserted', 'runtime_observed'] as const;

export type AbortProvenance = (typeof ABORT_PROVENANCE_VALUES)[number];

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
  consumerTools: 'consumer-tools',
  contextBoundReplaybook: 'context-bound-replaybook',
  debuggerSurface: 'debugger-surface',
  discoveryArtifact: 'discovery-artifact',
  executeErrorsClassificationAndRecovery: 'execute-errors-classification-and-recovery',
  fetchSchema: 'fetch-schema',
  graphs: 'graphs',
  identities: 'identities',
  interruptions: 'interruptions',
  interrupts: 'interrupts',
  jsEval: 'js-eval',
  localPackage: 'local-package',
  networkLogDiscoveryWorkflow: 'network-log-discovery-workflow',
  pageScriptAnchors: 'page-script-anchors',
  pageScriptSchema: 'page-script-schema',
  packageExport: 'package-export',
  platformSurfaceMap: 'platform-surface-map',
  popups: 'popups',
  rePatternChoice: 're-pattern-choice',
  recordedPathSchema: 'recorded-path-schema',
  tryGenerator: 'try-generator',
  rediscoverGate: 'rediscover-gate',
  reverseEngineerMode: 'reverse-engineer-mode',
  reverseEngineerPlaybook: 'reverse-engineer-playbook',
  selfVerifyingStrategies: 'self-verifying-strategies',
  stepHealingResponseFormat: 'step-healing-response-format',
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
