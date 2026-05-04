# Reverse-engineering pipeline

When a captured request carries bytes that don't round-trip — binary WebSocket frames with rotating session-scoped IDs, signed bodies, persisted GraphQL with mutated fields — the agent has to read the page's own encoder to lift the capability. This file documents the toolkit and the plumbing beneath it. For the discovery flow that decides when to enter LIFT, see [discovery.md](discovery.md).

## RE toolkit

The fast path is reading the page's own encoder. The toolkit is a set of primitives the agent composes — there's no "RE these bytes" command.

- **`list_loaded_scripts(session_id)`** — every script the page loaded, deduped + ordered by size. The bundle hunt starts here.
- **`search_js_source(session_id, url, pattern)`** — literal substring search across a cached bundle body. The agent searches for protocol literals (`"/ls_req"`, `"encodeSend"`, field names from the envelope JSON) to find candidate call sites.
- **`read_js_function(session_id, url, line)`** — bracket-match-based extraction of the function enclosing a given line. Read one function at a time instead of guessing line windows.
- **`get_js_source(session_id, url, line, context?)`** — windowed source read around a specific line, when you need surrounding context the function-extractor doesn't capture.
- **`js_eval(session_id, expression)`** — evaluate an arbitrary expression in the live page. Binary returns (ArrayBuffer / Uint8Array) are hex-encoded by a shared wrapper so they round-trip cleanly across the driver boundary. Top-level statements (`const x = ...; x`) auto-wrap into an async IIFE so the LLM can paste the shape it'd write in a Node REPL — see [principles.md](principles.md#if-the-llm-keeps-making-the-same-mistake-the-runtime-is-wrong).
- **`inspect_ws_frame(session_id, ws_i | ws_hash)`** — load a captured WebSocket frame with full metadata, including `js_callstack` (the `file:line:col` where `WebSocket.send` was called).
- **`get_send_encoder(session_id, ws_i | ws_hash)`** — live handle to the captured encoder function from the frame's call site.

Combined, the agent navigates a minified bundle the way a reverse engineer with DevTools open would.

## Source-level debugger

Above the reading primitives sits an eight-tool debugger surface that wraps CDP's `Debugger` domain:

- **`set_breakpoint(session_id, url, line, column?)`**
- **`remove_breakpoint(session_id, breakpoint_id)`**
- **`list_breakpoints(session_id)`**
- **`wait_for_pause(session_id, timeout_ms?)`**
- **`get_frame_scope(session_id, frame_index?)`**
- **`evaluate_on_frame(session_id, frame_index, expression)`**
- **`step(session_id, kind)`** (`over` / `into` / `out`)
- **`resume(session_id)`**

Instead of reading the minified bundle, the agent drops a breakpoint at the `WebSocket.send` file:line reported by `inspect_ws_frame.js_callstack`, re-triggers the flow with `perform_action`, and reads the encoder out of the paused closure via `get_frame_scope` + `evaluate_on_frame`. This collapses the hardest RE case — encoders where the closure captures private state the module never exports globally — from hours of bundle-hunting to a handful of tool calls. Implemented only on the Playwright driver (CDP session per klura session, lazy-initialized on first `set_breakpoint`); the remote driver throws `not_implemented`. Cleanup is automatic at `end_drive` (resume → remove bps → disable Debugger). Full workflow in `klura://reference#debugger-surface`.

## The save shape: `frameFromPage`

The strategy shape that makes a reverse-engineered encoder warm-executable is `frameFromPage`: a JS expression interpolated with `{{args}}`, run via `driver.evaluateExpression` at execute time, returning hex or base64 bytes that the runtime decodes and dispatches via `sendWebSocketFrame`. Because the expression runs in the live page, `document` / `window.require` / per-session globals all work — the Node-VM sandbox path (`generated.frame.code`) is the fallback for encoders that don't need page state. Full schema + named-moves playbook live in `klura://reference#reverse-engineer-playbook`.

---

## Why the plumbing exists

A naive "run the agent in a loop" approach breaks in ways that look like bugs but are actually deterministic failure modes — ring-buffer rotation, session-scoped ids baked into runtime code, byte-perfect convergence with diminishing returns past envelope agreement. The plumbing below closes those gaps.

### Frame pinning and the ring buffer

The driver captures every sent / received WebSocket frame into `session.wsFrames`, capped by default at `WS_FRAMES_BUFFER_CAP = 2000` entries with FIFO eviction so chatty long-lived sessions don't drive memory up unboundedly. During an RE loop the agent can easily push 50+ probe sends, which rotates the original reference frame out from under subsequent `try_generator_in_page({verify_against})` calls.

The two-part fix lives in `runtime/src/response/ws-pin.ts`:

- **Content-addressed `ws_hash`** — SHA-256 first 12 hex chars of `direction|url|payload`. Stable across rotation, surfaced on every shaped WS frame (`response/network-log-shape.ts:summarizeWsFrame`) and on the RE-nag signal. Every tool that accepts `ws_i` also accepts `ws_hash`; the resolver (`resolveWsFrame`) tries the pinned map first, falls back to a ring scan by hash, falls back to positional `ws_i`.
- **Pinned slots** — per-session `Session.pinnedWsFrames: Map<hash, WebSocketFrame>` lifts specific frames out of the FIFO ring. Capped at `WS_PINNED_FRAMES_CAP = 8` with LRU eviction; overflow returns the evicted hash so callers can surface it.
- **Dynamic ring cap** — `Session.wsFramesCap` overrides the driver default. When `detectSessionComplexity` (`runtime/src/strategies/close-complexity.ts`) fires an envelope advisory, it raises the cap to `WS_FRAMES_BUFFER_CAP_RE_MODE = 10_000` for the rest of the session. Complementary to pinning: pinning protects the specific advisory target; the ring bump keeps companion frames (ack, diff candidates) around without explicit pins.

### Auto-pin on the end-drive RE nag

`detectSessionComplexity` is the integration point. When it fires a `recorded_path_only_lift_possible` advisory that attaches to a ws frame, it pins the target frame before returning the signal, and stamps `signal.ws_hash` alongside `signal.ws_i`. The agent's subsequent `inspect_ws_frame(ws_hash)` / `try_generator_in_page({verify_against: {ws_hash}})` calls address the frame by hash and survive any amount of subsequent rotation.

### Explicit pin and trigger primitives

Two tools round out the surface:

- **`pin_ws_frame`** — pins a frame the auto-pin couldn't know about (companion ack, prior-send diff target). Returns `ws_hash`, `pinned_count`, `pinned_cap`, and `evicted_hash` when an LRU overflow happened.
- **`trigger_reference_send`** — fires a short `perform_action` sequence and returns every new sent-frame candidate that lands within a settle window, each with its hash. For sessions where the auto-pin window already passed or where the agent wants a fresh reference independent of `end_drive`.

### Convergence coach

`try_generator` and `try_generator_in_page` stamp a `ConvergenceSignal` on every `ok:false` response (`runtime/src/response/convergence.ts`). The signal names the shape (`envelope_correct` / `envelope_wrong` / `partial`) and the trajectory (`converging` / `stuck` / `oscillating` / etc.) so the agent can read the gradient and decide whether to keep iterating or fold. There is no "save partial" escape hatch: a strategy is either saved (complete) or not saved. If byte-perfect never lands, the agent either keeps iterating, lifts the encoder white-box (`klura://reference#re-pattern-choice`), or folds to a recorded-path.

### Structural match mode

`try_generator` / `try_generator_in_page` accept `match: 'bytes' | 'structural'`. In structural mode, when byte-diff fails, `runtime/src/response/structural-match.ts` extracts JSON from both sides (by searching for the first `{` / `[` — handles length-prefixed binary envelopes that wrap a JSON body), recursively unwraps stringified-JSON-in-strings and compares shapes depth-first: same keys per object, same value types per path, same array lengths + element types. Value differences within the same type count as a match.

The mode is opt-in because structural match answers a narrower question than byte match, and the right answer depends on intent. `match:"structural"` gives agents a route to `ok:true` past envelope convergence when cosmetic byte differences are stalling the loop.
