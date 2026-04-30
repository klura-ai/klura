// Interruption-handler framework — public surface.
//
// Menu-driven dispatch:
//
// 1. Runtime detects a condition (timer tick, step failed, pre-save consent,
//    etc.) and builds an `InterruptionEvent` with descriptive `context`
//    (free-form, typically includes a `reason` string naming the condition).
// 2. Runtime calls `listInterruptionHandlers()` → gets every registered
//    plugin as `{name, description}` tuples.
// 3. Runtime attaches `_interruption: {context, candidates, interruption_token}`
//    to the next tool response. The token is minted via the gate framework
//    and bound to the event-context hash.
// 4. Agent reads the menu, picks a handler by name, calls the
//    `resolve_interruption` MCP tool with `{session_id, context, resolver}`.
// 5. Runtime invokes `invokeInterruptionHandler(name, event, session)` → a
//    resolution, returned to the agent.
// 6. Agent echoes the `interruption_token` on its next tool call, gated by
//    `assertNoPendingInterruption` in tool-helpers.
//
// Plugins register via `registerInterruptionHandler({name, description,
// handle})`. Test scenarios and CI environments register per-scenario
// plugins whose `continue` / `resolved` resolutions short-circuit the
// interactive defaults — the agent reads each registered handler's
// description and picks the best match for the event context.
//
// Runtime ships with default handlers that assume an interactive human is
// available; behavior is plugin-orchestrated end-to-end, no flag-driven
// branches in runtime hot paths.
//
// See runtime/docs/interruptions.md for the full architecture and
// runtime/docs/principles.md §Interruption handlers for the framing.

export {
  registerInterruptionHandler,
  unregisterInterruptionHandler,
  listInterruptionHandlers,
  invokeInterruptionHandler,
  __clearAllHandlers,
} from './registry';

export { registerDefaults, setViewerOpener } from './default-handlers';
export type { ViewerOpener } from './default-handlers';

export type { InterruptionEvent, InterruptionResolution, InterruptionHandler } from './types';
