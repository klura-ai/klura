// Checkpoint framework — public surface.
//
// Direct dispatch:
//
// 1. Runtime detects a known-kind event (round counter crossed
//    threshold, recorded step failed, LIFT transition, session
//    expired, post-save validation pending).
// 2. Runtime calls `invokeCheckpointAndGate(kind, event)` which picks
//    the last-registered handler claiming that kind and invokes it.
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
  CheckpointResolution,
  CheckpointHandler,
} from './types';
export { CHECKPOINT_KINDS } from './types';
export { composeAckHint } from './ack-hints';
