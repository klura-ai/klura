# Checkpoints — runtime-emitted known-kind events

A **checkpoint** is a mid-flow event where the runtime itself is the detector and the event's `kind` is drawn from a closed enum. Distinct from [interruptions](interruptions.md) (agent-detected ambient page state, menu-driven dispatch) and from the pre-commit [gate family](gates.md) (save/commit-time payload shape).

When a round counter crosses its threshold, a recorded-path step throws, a post-save validation is about to fire — the runtime already knows what happened. No description menu, no LLM-semantic routing. Direct dispatch: the runtime invokes whichever plugin claimed that kind; last-registered wins.

## `CheckpointKind` (closed)

```ts
type CheckpointKind =
  | 'triage_plan' // submit_triage_plan committed; ack before LIFT
  | 'surface_changed' // navigation landed on a path-distinct URL no triage plan covers
  | 'recorded_step_failed' // Recorded-path step threw / timed out
  | 'session_expired' // Runtime detected 401/403 session-expired pattern
  | 'post_save_validation_consent' // save_strategy staged a post-save verification needing consent
  | 'abort_session_consent'; // abort_session wants teardown; user approves or vetoes
```

Adding a kind = adding an emit site + at least one default handler that claims it. `invokeCheckpoint` throws at dispatch time if no handler claims the kind.

## Architecture

`runtime/src/checkpoints/`:

```ts
// Discriminated union — `kind` appears exactly once, as the discriminant,
// and selects the per-kind typed context (CheckpointContextMap in
// runtime/src/checkpoints/types.ts). `switch (event.kind)` narrows
// `event.context` with no casts.
type CheckpointEvent<K extends CheckpointKind = CheckpointKind> = {
  [P in K]: {
    kind: P;
    session_id: string;
    capability?: string;
    context: CheckpointContextMap[P]; // typed per kind
  };
}[K];

interface CheckpointHandler<K extends CheckpointKind = CheckpointKind> {
  name: string; // stable id; same-name re-register replaces in place
  kinds: readonly K[]; // closed-enum claim
  handle(event: CheckpointEvent<K>, session: Session): Promise<CheckpointResolution>;
}

type CheckpointResolution =
  | { status: 'resolved'; value?: unknown; patch?: Record<string, unknown> }
  | { status: 'handover'; target: 'user' | 'viewer'; prompt: string; viewer_url?: string }
  | { status: 'continue'; hint?: string };
```

Producers build events through the per-kind `checkpointEvent` constructors — the only place `kind` is stamped onto an event, so no emit site can restate (or contradict) it inside the context:

```ts
checkpointEvent.abort_session_consent({
  session_id,
  context: { reason, abort_kind, capturedActionsCount, phase_at_abort },
});
```

Dispatch (`runtime/src/checkpoints/registry.ts`):

```ts
invokeCheckpoint(event, session);
// picks the LAST-registered handler whose `kinds` includes `event.kind`
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

**Wire contract:** `kind` appears exactly once — at the top level of `_checkpoint`. `context` is the per-kind payload and never carries a `kind` key of its own; consumers (plugins, transcript pipelines, MCP clients) must discriminate on `_checkpoint.kind`, not on anything inside `context`.

The agent acks via the MCP tool:

```
ack_checkpoint({
  session_id,
  checkpoint_token,
  user_response?: "...",     // for triage_plan, surface_changed, post_save_validation_consent, abort_session_consent
  viewer_result?: {...},     // for recorded_step_failed, session_expired
  cancelled?: true, reason?: "..."
})
```

Without an ack, every other tool call on the session rejects with `invalid_strategy: pending_checkpoint …`.

When the handler returns `resolved` or `continue`, no envelope surfaces and the runtime folds the answer into its continuation.

## Shipped defaults

`runtime/src/checkpoints/default-handlers.ts` registers four defaults covering every shipped kind:

| Default                                    | Kinds claimed                             |
| ------------------------------------------ | ----------------------------------------- |
| `default-handover-viewer-checkpoint`       | `recorded_step_failed`, `session_expired` |
| `default-ask-user-checkpoint`              | `triage_plan`, `surface_changed`          |
| `default-pre-action-consent-checkpoint`    | `post_save_validation_consent`            |
| `default-abort-session-consent-checkpoint` | `abort_session_consent`                   |

Viewer spin-up lives in the default handler — `setViewerOpener(...)` in `runtime-state.ts` injects the real `startRemoteSession` call so the handler can open the viewer inline and populate `viewer_url`.

## Test / scenario overrides

Every autonomous-run scenario (no human in the loop) reduces to:

```ts
registerCheckpointHandler({
  name: 'test-continue-all',
  kinds: CHECKPOINT_KINDS, // claim every shipped kind — derive, don't copy
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
| `runtime/src/phases/surface-changed.ts` (navigation crossed to an un-triaged surface; fired from both `perform_action` and `js_eval`) | `surface_changed` |
| `runtime/src/execution/recorded-path.ts` | `recorded_step_failed` |
| `runtime/src/tools/start-session.ts` (auto-execute diagnosis `auth_failed`) | `session_expired` |
| `runtime/src/tools/save-strategy.ts` (staged post-save verification — active save and inactive candidate paths) | `post_save_validation_consent` |
| `runtime/src/tools/abort_session.ts` (staged abort teardown) | `abort_session_consent` |

Every emit site routes through `invokeCheckpointAndGate(event)` (`runtime/src/checkpoints/gate-glue.ts`), which mints the token + builds the envelope on `handover` resolutions.

## Token gate

The checkpoint gate is a sibling of the interruption gate — both are built on `buildTokenGate` from `runtime/src/gate/`. Separate kinds (`checkpoint_ack` vs `interruption_ack`), separate per-session pending maps. `assertNoPendingCheckpoint` and `assertNoPendingInterruption` are two calls in the MCP pre-handler gate so a test failure names the specific surface that blocked.

**Pending-state lifetime.** A pending entry is cleared by a committed ack, and otherwise dies with the session: minting registers a session-scope disposer (`runtime/src/pool/session-scope.ts`), so any close path that kills the session id — clean close, abort, pool shutdown, an auto-execute inner session torn down with its outer parent — drops the unacked entry instead of leaking it for the daemon's lifetime.

## Related

- [interruptions.md](interruptions.md) — agent-detected menu-driven dispatch; scope narrowed to ambient page state the agent spots in the a11y tree.
- [gates.md](gates.md) — save/commit-time structural gates. Shared `buildTokenGate` factory.
- [principles.md](principles.md) §Checkpoints + §Interruptions — the "why" for the split.
