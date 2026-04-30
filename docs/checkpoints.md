# Checkpoints — runtime-emitted known-kind events

A **checkpoint** is a mid-flow event where the runtime itself is the detector and the event's `kind` is drawn from a closed enum. Distinct from [interruptions](interruptions.md) (agent-detected ambient page state, menu-driven dispatch) and from the pre-commit [gate family](gates.md) (save/commit-time payload shape).

When a round counter crosses its threshold, a recorded-path step throws, a post-save validation is about to fire — the runtime already knows what happened. No description menu, no LLM-semantic routing. Direct dispatch: the runtime invokes whichever plugin claimed that kind; last-registered wins.

## `CheckpointKind` (closed)

```ts
type CheckpointKind =
  | 'triage_plan' // submit_triage_plan committed; ack before LIFT
  | 'surface_changed' // perform_action landed on a path-distinct URL no triage plan covers
  | 'recorded_step_failed' // Recorded-path step threw / timed out
  | 'session_expired' // Runtime detected 401/403 session-expired pattern
  | 'post_save_validation_consent'; // save_strategy about to fire a mutating validation call
```

Adding a kind = adding an emit site + at least one default handler that claims it. `invokeCheckpoint` throws at dispatch time if no handler claims the kind.

## Architecture

`runtime/src/checkpoints/`:

```ts
interface CheckpointHandler {
  name: string; // stable id; same-name re-register replaces in place
  kinds: CheckpointKind[]; // closed-enum claim
  handle(event: CheckpointEvent, session: Session): Promise<CheckpointResolution>;
}

interface CheckpointEvent {
  session_id: string;
  capability?: string;
  context: Record<string, unknown>; // kind-specific payload
}

type CheckpointResolution =
  | { status: 'resolved'; value?: unknown; patch?: Record<string, unknown> }
  | { status: 'handover'; target: 'user' | 'viewer'; prompt: string; viewer_url?: string }
  | { status: 'continue'; hint?: string };
```

Dispatch (`runtime/src/checkpoints/registry.ts`):

```ts
invokeCheckpoint(kind, event, session);
// picks the LAST-registered handler whose `kinds` includes `kind`
// throws if no handler claims the kind
```

Defaults register at module load (via `registerCheckpointDefaults()` called from `runtime-state.ts`). Scenario / enterprise plugins register after to pre-empt them. Unregister reverts to defaults.

## What the LLM sees

When a runtime code path fires a checkpoint and the handler returns `handover`, the next tool response carries:

```json
{
  "_checkpoint": {
    "kind": "recorded_step_failed",
    "context": { "failed_step_index": 3, "...": "..." },
    "prompt": "A recorded-path step failed mid-execute. The remote viewer is open; …",
    "viewer_url": "https://viewer.klura.io/remote/abc…",
    "checkpoint_token": "ck_…"
  }
}
```

The agent acks via the MCP tool:

```
ack_checkpoint({
  session_id,
  checkpoint_token,
  user_response?: "...",     // for triage_plan, surface_changed, post_save_validation_consent
  viewer_result?: {...},     // for recorded_step_failed, session_expired
  cancelled?: true, reason?: "..."
})
```

Without an ack, every other tool call on the session rejects with `invalid_strategy: pending_checkpoint …`.

When the handler returns `resolved` or `continue`, no envelope surfaces and the runtime folds the answer into its continuation.

## Shipped defaults

`runtime/src/checkpoints/default-handlers.ts` registers three defaults covering every shipped kind:

| Default                                 | Kinds claimed                             |
| --------------------------------------- | ----------------------------------------- |
| `default-handover-viewer-checkpoint`    | `recorded_step_failed`, `session_expired` |
| `default-ask-user-checkpoint`           | `triage_plan`, `surface_changed`          |
| `default-pre-action-consent-checkpoint` | `post_save_validation_consent`            |

Viewer spin-up lives in the default handler — `setViewerOpener(...)` in `runtime-state.ts` injects the real `startRemoteSession` call so the handler can open the viewer inline and populate `viewer_url`.

## Test / scenario overrides

Every autonomous-run scenario (no human in the loop) reduces to:

```ts
registerCheckpointHandler({
  name: 'test-continue-all',
  kinds: [
    'triage_plan',
    'surface_changed',
    'recorded_step_failed',
    'session_expired',
    'post_save_validation_consent',
  ],
  async handle() {
    return { status: 'continue' };
  },
});
```

Or narrower — claim a subset, let defaults handle the rest. Last-registered wins, so scenarios don't need to unregister defaults.

## Emit sites

The runtime dispatches checkpoints from:

| Emit site | Kind |
| --- | --- |
| `runtime/src/tools/submit-triage-plan.ts` (after the per-surface plan persists) | `triage_plan` |
| `runtime/src/tools/perform-action.ts` (navigation crossed to an un-triaged surface) | `surface_changed` |
| `runtime/src/execution/recorded-path.ts` | `recorded_step_failed` |
| `runtime/src/index.ts` (save_strategy post-save validation) | `post_save_validation_consent` |
| _reserved_ | `session_expired` |

Every emit site routes through `invokeCheckpointAndGate(kind, event)` (`runtime/src/checkpoints/gate-glue.ts`), which mints the token + builds the envelope on `handover` resolutions.

## Token gate

The checkpoint gate is a sibling of the interruption gate — both are built on `buildTokenGate` from `runtime/src/gate/`. Separate kinds (`checkpoint_ack` vs `interruption_ack`), separate per-session pending maps. `assertNoPendingCheckpoint` and `assertNoPendingInterruption` are two calls in the MCP pre-handler gate so a test failure names the specific surface that blocked.

## Related

- [interruptions.md](interruptions.md) — agent-detected menu-driven dispatch; scope narrowed to ambient page state the agent spots in the a11y tree.
- [gates.md](gates.md) — save/commit-time structural gates. Shared `buildTokenGate` factory.
- [principles.md](principles.md) §Checkpoints + §Interruptions — the "why" for the split.
