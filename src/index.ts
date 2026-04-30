import fs from 'fs';
import path from 'path';
// pool / tokenCache / listenerManager lifecycle + provider wiring lives in
// ./runtime-state. Importing it here is enough to run the init at module-load
// time.
import './runtime-state';

// Absolute path to SKILL.md inside the installed klura package. At runtime
// __dirname is <pkg>/dist, so SKILL.md sits one level up. Consumers (mcp,
// benchmark, ClawHub skill) should resolve via `require('klura').SKILL_MD_PATH`
// rather than guessing relative paths.
export const SKILL_MD_PATH = path.join(__dirname, '..', 'SKILL.md');
export const REFERENCE_MD_PATH = path.join(__dirname, '..', 'REFERENCE.md');

/** Read SKILL.md from the installed klura package. */
export function getSkillMd(): string {
  return fs.readFileSync(SKILL_MD_PATH, 'utf-8');
}

/** Read REFERENCE.md from the installed klura package. */
export function getReferenceMd(): string {
  return fs.readFileSync(REFERENCE_MD_PATH, 'utf-8');
}

// ---- Re-exports from non-tool modules ----

export { readObservedCapabilities, readUrlGraph, readFormsSeen } from './working-dir/logbook';

export { assertNoPendingInterruption } from './tool-helpers';
export { assertNoPendingCheckpoint, ackCheckpoint } from './checkpoints-api';

export {
  resolveReferenceResource,
  listReferenceSections,
  parseReferenceSections,
  slugifyHeading,
  generateReferenceToc,
  findReferenceSection,
} from './response/reference-sections';
export type { ReferenceSection } from './response/reference-sections';

export type { InterruptionEnvelope } from './tool-helpers';
export type { CheckpointEnvelope } from './checkpoints';
export {
  registerCheckpointHandler,
  unregisterCheckpointHandler,
  listCheckpointHandlers,
  CHECKPOINT_KINDS,
  composeAckHint,
} from './checkpoints';
export type {
  CheckpointKind,
  CheckpointEvent,
  CheckpointResolution,
  CheckpointHandler,
} from './checkpoints';

export {
  registerSaveConfirmationDecider,
  unregisterSaveConfirmationDecider,
  getRegisteredSaveConfirmationDecider,
} from './audit/save-confirmation-decider';
export type {
  SaveConfirmationDecider,
  SaveConfirmationDecision,
} from './audit/save-confirmation-decider';

// Interruption registry — public surface for scenarios, enterprise plugins,
// and the `list_interruption_resolvers` / `resolve_interruption` MCP tools.
export {
  registerInterruptionHandler,
  unregisterInterruptionHandler,
  listInterruptionHandlers,
  invokeInterruptionHandler,
} from './interruptions';
export type {
  InterruptionEvent,
  InterruptionResolution,
  InterruptionHandler,
} from './interruptions';

export { classifyUrlParams, computeReverseEngineerHandoff } from './close-session/re-handoff';
export { closeSession } from './close-session/orchestrator';

// ---- Tool-surface re-exports ----

export { startSession, GRAPH_MODES } from './tools/start-session';
export type { StartSessionResult } from './tools/start-session';

export {
  performAction,
  getA11yTree,
  getActionHistory,
  getNetworkLog,
} from './tools/perform-action';
export type { ActionResult } from './tools/perform-action';

export { saveStrategy } from './tools/save-strategy';

export { submitTriagePlan } from './tools/submit-triage-plan';
export type { SubmitTriagePlanArgs, SubmitTriagePlanResult } from './tools/submit-triage-plan';
export type { TriagePlan, DefenseSurface } from './working-dir/schema';

// Session-phase machine — exported for plugin / scenario authors who want
// to read the current phase or dispatch transitions from outside the
// runtime's tool tree.
export { dispatch as dispatchPhaseEvent } from './session-phase/state-machine';
export {
  currentPhase,
  currentSpec,
  checkAdmissibility as checkPhaseAdmissibility,
  UNIVERSAL_TOOLS,
} from './session-phase/registry';
export {
  assertToolAdmissible,
  assertToolAdmissibleBySessionId,
  tickPhaseCounter,
} from './session-phase/middleware';
export type { SessionPhase, PhaseSpec, PhaseEvent, PhaseEventKind } from './session-phase/types';
export { ToolNotAdmissibleError, SessionPhaseTransitionError } from './session-phase/types';

// Public, runtime-state-bound entry point for the saved-strategy executor.
// The lower-level `execute` in `runtime/src/execution.ts` takes pool +
// tokenCache as positional args; this wrapper binds them from runtime
// state so callers (daemon CLI bridge, programmatic Node consumers) get
// the four-arg shape they expect.
import { execute as executeCore } from './execution';
import type { ExecuteResult } from './execution/types';
import { pool as runtimePool, tokenCache as runtimeTokenCache } from './runtime-state';

export async function execute(
  platform: string,
  capability: string,
  args: Record<string, unknown> = {},
  opts: { identity?: string } = {},
): Promise<ExecuteResult> {
  return executeCore(platform, capability, args, runtimePool, runtimeTokenCache, {
    identity: opts.identity,
  });
}

export { resumeExecution } from './tools/execute';

export { getStrategyHealth } from './tools/health';
export type {
  GetStrategyHealthArgs,
  GetStrategyHealthResult,
  StrategyHealthEntry,
} from './tools/health';

export { listInterruptionResolvers, resolveInterruption } from './tools/interruption-tools';
export type { ResolveInterruptionArgs } from './tools/interruption-tools';

export { declareCapability } from './tools/declare-capability';
export type { DeclareCapabilityArgs } from './tools/declare-capability';

export {
  addResumePointer,
  addDiscoveryNote,
  recordObservedCapability,
  saveVerifiedExpression,
  getDiscoveryArtifactField,
} from './tools/discovery-artifact-tools';
export type {
  AddResumePointerArgs,
  AddDiscoveryNoteArgs,
  RecordObservedCapabilityArgs,
  SaveVerifiedExpressionArgs,
  GetDiscoveryArtifactFieldArgs,
} from './tools/discovery-artifact-tools';

export { getUnusedSignerDiscoveryTools, getSessionObligation } from './tools/session-envelopes';

export { startRemote, stopRemote, waitForRemote, setStartRemoteHandler } from './tools/remote';
export type { StartRemoteHandler } from './tools/remote';

export { status, startListener, stopListener, getEvents, listListeners } from './tools/listeners';

export {
  listPlatformSkills,
  getStrategy,
  getPlatformLogbook,
  liftRate,
  liftRateFormatted,
  clearAll,
  clearSkills,
} from './tools/skills-query';
export type { GetStrategyArgs } from './tools/skills-query';

export {
  getConfig,
  describeConfigTool,
  configureSetting,
  restartRuntime,
} from './tools/config-tools';

// ---- Existing tools/ re-exports (modules that already lived under tools/) ----

export { tryGenerator, tryGeneratorInPage, buildNextSaveHint } from './tools/generators';
export type {
  TryGeneratorArgs,
  TryGeneratorResult,
  TryGeneratorInPageArgs,
} from './tools/generators';

export {
  explainWsFrameStructure,
  inspectWsFrame,
  findInWsFrame,
  pinWsFrame,
} from './tools/ws-frames';
export type {
  ExplainWsFrameStructureArgs,
  InspectWsFrameArgs,
  FindInWsFrameArgs,
  PinWsFrameArgs,
  PinWsFrameResult,
} from './tools/ws-frames';

export { triggerReferenceSend } from './tools/trigger-reference-send';
export type {
  TriggerReferenceSendArgs,
  TriggerReferenceSendResult,
} from './tools/trigger-reference-send';

export {
  getJsSource,
  getSendEncoder,
  searchJsSourceTool,
  readJsFunctionTool,
  listLoadedScriptsTool,
  jsEval,
  installPageInitScript,
  removePageInitScript,
} from './tools/js-tools';
export type {
  GetJsSourceArgs,
  GetSendEncoderArgs,
  SearchJsSourceArgs,
  ReadJsFunctionArgs,
  ListLoadedScriptsArgs,
  JsEvalArgs,
  InstallPageInitScriptArgs,
  RemovePageInitScriptArgs,
} from './tools/js-tools';

export {
  setBreakpointTool,
  removeBreakpointTool,
  listBreakpointsTool,
  waitForPauseTool,
  getFrameScopeTool,
  evaluateOnFrameTool,
  stepTool,
  resumeTool,
} from './tools/debugger';

export { getScreenshot, getAttribute, findInPage } from './tools/page-helpers';

export * from './public-api';
