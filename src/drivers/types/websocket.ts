/**
 * Compact summary of a single WebSocket frame, returned alongside HTTP entries
 * by `get_network_log`. The payload is always clipped to a small preview in
 * summary form; agents that need the full bytes follow up with `{ws_i: N, full:
 * true}`.
 */
export interface WsFrameSummary {
  /** Absolute index into the raw wsFrames ring buffer. Positional — use
   *  only against a stable buffer; rotates as new frames arrive. Prefer
   *  `ws_hash` for cross-call references. */
  i: number;
  /** Stable content-hash of `direction|url|payload`. Doesn't move when the
   *  ring rotates and survives explicit pinning. Every RE tool that
   *  accepts `ws_i` also accepts `ws_hash` — pinned frames are only
   *  reachable via hash. */
  ws_hash: string;
  direction: 'sent' | 'received';
  url: string;
  ts: number;
  /** Payload clipped to a 512-char preview. If clipped, see
   *  `payload_truncated` + `payload_total_chars` + `payload_slice_end` +
   *  `payload_hint`. Fetch the untrimmed payload with `{ws_i, full: true}`. */
  payload: string;
  payload_truncated?: boolean;
  payload_total_chars?: number;
  /** Character offset the current payload slice starts at. 0 for the
   *  default head-slice. */
  payload_slice_start?: number;
  /** Exclusive end char of the slice. Equal to payload_total_chars when the
   *  whole payload fit. */
  payload_slice_end?: number;
  /** Human-readable pointer telling the caller how to fetch the full
   *  payload. Only present when the slice was taken. */
  payload_hint?: string;
  /** True when this frame is currently pinned (kept out of the FIFO ring).
   *  Set by `pin_ws_frame` / auto-pin on `close_session`'s RE nag. */
  pinned?: boolean;
  /** Hint pointing at `get_send_encoder` when this frame's `direction` is
   *  `'sent'` — the runtime captured a live handle to the WebSocket the
   *  page sent through, plus the exact bytes the page passed to `.send()`.
   *  Mirrored from `inspect_ws_frame`'s `live_handle_hint` so agents that
   *  survey via `get_network_log` and skip `inspect_ws_frame` still learn
   *  the path. Only present on sent-direction frames. */
  live_handle_hint?: {
    tool: 'get_send_encoder';
    args: { session_id?: string; ws_i: number };
    reason: string;
  };
}

/**
 * A single WebSocket frame captured from a page's WebSocket connection. Used by
 * browser-event listeners to tap into chat/feed/notification push channels
 * without cracking the WS handshake open from outside the browser.
 */
export interface WebSocketFrame {
  url: string;
  direction: 'sent' | 'received';
  payload: string;
  timestamp: number;
  /** When a `direction: 'sent'` frame can be correlated with a captured
   *  `WebSocket.prototype.send` call (the page-side wrapper installed by
   *  the driver), the JS callstack at send time. The agent reads this on
   *  `inspect_ws_frame` to find the file:line of the encoder — the
   *  reverse-engineer's "where do my bytes leave?" question. Absent for
   *  received frames and for sent frames the wrapper missed (e.g. the
   *  page swapped `WebSocket.prototype.send` after our init script ran). */
  js_callstack?: WsSendCallstack;
}

export interface WsSendCallstack {
  /** Raw `Error.stack` string, engine-formatted (V8 / SpiderMonkey / JSC). */
  raw_stack: string;
  /** Parsed frames, top-to-bottom (innermost caller first). Empty when the
   *  stack format wasn't recognized — the raw_stack is still present. */
  frames: WsSendStackFrame[];
}

export interface WsSendStackFrame {
  function?: string;
  file?: string;
  line?: number;
  column?: number;
  native?: boolean;
}

/**
 * Handle returned by `streamWebSocketFrames`. The caller awaits `closed` in
 * parallel with consuming frames via the callback; when `closed` resolves, the
 * stream has terminated (dispose called, connection dropped, page crash) and
 * the caller should trigger whatever reconnect / cleanup logic it owns.
 */
export interface WebSocketFrameStream {
  /** Stop the stream and release underlying resources. Safe to call twice. */
  dispose: () => Promise<void>;
  /** Resolves when the stream terminates. `reason` is a short identifier. */
  closed: Promise<{ reason: string }>;
}
