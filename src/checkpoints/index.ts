// Checkpoint framework — public surface.
//
// Direct dispatch:
//
// 1. Runtime detects a known-kind event (round counter crossed
//    threshold, recorded step failed, LIFT transition, session
//    expired, post-save validation pending) and builds a typed event
//    via the `checkpointEvent.<kind>` constructor.
// 2. Runtime calls `invokeCheckpointAndGate(event)` which picks the
//    last-registered handler claiming `event.kind` and invokes it.
// 3. On `handover` resolutions, the runtime mints a
//    `checkpoint_token`, attaches `_checkpoint: {kind, prompt?,
//    viewer_url?, checkpoint_token}` to the next tool response.
// 4. Agent's next tool call echoes the token + an ack via the
//    `ack_checkpoint` MCP tool (or explicit cancel with
//    `{cancelled: true, reason}`). Gated by `assertNoPendingCheckpoint`.
//
// See runtime/docs/checkpoints.md for the architecture + runtime/docs/
// principles.md §Checkpoints for the framing.

export {
  registerCheckpointHandler,
  unregisterCheckpointHandler,
  listCheckpointHandlers,
  invokeCheckpoint,
  __clearAllCheckpointHandlers,
} from './registry';

export { registerCheckpointDefaults, setViewerOpener } from './default-handlers';
export type { ViewerOpener } from './default-handlers';

export {
  mintCheckpointToken,
  assertNoPendingCheckpoint,
  invokeCheckpointAndGate,
  type CheckpointEnvelope,
  type CheckpointAckInput,
} from './gate-glue';

export type {
  CheckpointKind,
  CheckpointEvent,
  CheckpointContextMap,
  CheckpointResolution,
  CheckpointHandler,
  TriagePlanCheckpointContext,
  SurfaceChangedCheckpointContext,
  RecordedStepFailedCheckpointContext,
  SessionExpiredCheckpointContext,
  PostSaveValidationConsentCheckpointContext,
  AbortSessionConsentCheckpointContext,
} from './types';
export { CHECKPOINT_KINDS, checkpointEvent } from './types';
export { composeAckHint } from './ack-hints';
