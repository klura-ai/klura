import { pool } from '../runtime-state';
import {
  inspectWsPayload,
  findInWsPayload,
  type InspectFormat,
  type InspectWsFrameResult,
  type FindInWsFrameResult,
} from '../response/ws-frame-inspect';
import { buildBinaryWsStarter } from '../response/ws-frame-starter';
import { recordStarterIssued } from '../response/starter-cache';
import { ensureAccumulator, ringPush, digestArgs } from '../strategies/discovery-artifact';
import { truncateString } from '../response/response-size';

export interface InspectWsFrameArgs {
  session_id: string;
  /** Positional ring-buffer index. Fragile — the ring rotates as new
   *  frames arrive. Prefer `ws_hash` for any reference the agent will
   *  reuse later in the session. */
  ws_i?: number;
  /** Content-addressed stable handle. Returned on every shaped frame and
   *  on the RE nag's auto-pinned signal. Tools look up by hash first
   *  (pinned slots, then ring), so a pinned frame survives rotation. */
  ws_hash?: string;
  offset?: number;
  length?: number;
  format?: InspectFormat;
  /** If passed AND the frame matches the binary-WS starter gate, the
   *  response carries a `starter` field with a runnable iteration-1
   *  generator that splices the literal at its captured offset. Pair with
   *  `try_generator({code: starter.code, args: starter.args_for_iteration_1,
   *  verify_against: {ws_i | ws_hash}})` for a one-call ok:true confirming
   *  envelope shape — turning the rest of the work into
   *  refactor-not-discover. */
  text_contains?: string;
}

/**
 * Return a byte-level view of a captured WebSocket frame — hex dump,
 * escaped-utf8 text, or the classic mixed hex+ASCII-gutter format. Used by
 * agents composing `generated.frame.code` for binary envelopes: spotting
 * length-prefix bytes, topic strings, and JSON payload boundaries without
 * eyeballing a 1-KB raw-octet string in a tool response. Pair with
 * `findInWsFrame` to locate specific substrings (e.g. the user-variable text)
 * by byte offset.
 *
 * When `text_contains` is supplied AND the frame's payload is shaped like a
 * binary-WS write envelope (see `payloadMatchesBinaryWsStarterGate`), the
 * response also carries a `starter` field with a one-call iteration-1
 * generator. That single `try_generator` call returns ok:true against the
 * captured frame and confirms the envelope shape is correct — the agent then
 * refactors for dynamic fields (timestamps, sequence numbers, ids) rather than
 * committing to a 30-line generator from scratch before any feedback signal.
 */
export interface ExplainWsFrameStructureArgs {
  session_id: string;
  ws_i?: number;
  ws_hash?: string;
  text_anchor?: string;
}

/**
 * Structural explainer for a captured WS frame. One call returns wire-protocol
 * detection, parsed envelope tree, nested-JSON detection, and text-anchor
 * locations — replacing ~20 rounds of hand-walking `inspect_ws_frame`
 * offset+length slices. Pure byte-pattern heuristics; falls through to
 * `protocol.kind:'raw'` on sites whose frame format we can't classify.
 */
export async function explainWsFrameStructure(
  args: ExplainWsFrameStructureArgs,
): Promise<import('../response/ws-frame-explain').WsFrameExplanation | { error: string }> {
  if (!args.session_id) return { error: 'session_id is required' };
  const haveHash = typeof args.ws_hash === 'string' && args.ws_hash.length > 0;
  const haveIdx = typeof args.ws_i === 'number' && args.ws_i >= 0;
  if (!haveHash && !haveIdx) {
    return {
      error:
        'explain_ws_frame_structure requires ws_i or ws_hash (prefer ws_hash — survives ring rotation)',
    };
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  await driver.getInterceptedWebSocketFrames(session).catch(() => []);
  const { resolveWsFrame } = await import('../response/ws-pin');
  const resolved = resolveWsFrame(session, {
    ...(haveIdx ? { ws_i: args.ws_i } : {}),
    ...(haveHash ? { ws_hash: args.ws_hash } : {}),
  });
  if (!resolved) {
    return {
      error: haveHash
        ? `no ws frame matching hash "${args.ws_hash}" (not pinned, not in ring)`
        : `no ws frame at index ${args.ws_i} (session has ${(session.wsFrames ?? []).length} frames)`,
    };
  }
  const { explainWsFrame } = await import('../response/ws-frame-explain');
  return explainWsFrame(resolved.frame.payload, args.text_anchor);
}

// Caps for inspect_ws_frame's add-on fields. `data` is already bounded by
// INSPECT_MAX_LENGTH in ws-frame-inspect.ts; these cover the two other
// potentially-large fields on the response.
const INSPECT_STARTER_CODE_CAP = 5_000;
const INSPECT_CALLSTACK_FRAME_CAP = 20;

export async function inspectWsFrame(args: InspectWsFrameArgs): Promise<InspectWsFrameResult> {
  if (!args.session_id) throw new Error('session_id is required');
  const haveHash = typeof args.ws_hash === 'string' && args.ws_hash.length > 0;
  const haveIdx = typeof args.ws_i === 'number' && args.ws_i >= 0;
  if (!haveHash && !haveIdx) {
    throw new Error(
      'inspect_ws_frame requires ws_i (ring index) OR ws_hash (content-addressed handle). Prefer ws_hash — it survives ring rotation.',
    );
  }
  const session = pool.getSession(args.session_id);
  // Refresh the ring from the driver first so pinned-map lookups that fall back
  // to the ring see the latest.
  const driver = pool.driverFor(args.session_id);
  await driver.getInterceptedWebSocketFrames(session).catch(() => []);
  const { resolveWsFrame } = await import('../response/ws-pin');
  const resolved = resolveWsFrame(session, {
    ...(haveIdx ? { ws_i: args.ws_i } : {}),
    ...(haveHash ? { ws_hash: args.ws_hash } : {}),
  });
  if (!resolved) {
    throw new Error(
      haveHash
        ? `no ws frame matching hash "${args.ws_hash}" (not pinned, not in ring). If a previous pin aged out, call pin_ws_frame with a fresh ws_i or trigger_reference_send to capture a new reference frame.`
        : `no ws frame at index ${args.ws_i} (session has ${(session.wsFrames ?? []).length} frames captured)`,
    );
  }
  const frame = resolved.frame;
  // Report back the effective positional index so agents that still pass ws_i
  // can see whether the ring has rotated relative to the time they originally
  // captured the handle.
  const wsI = resolved.i ?? args.ws_i ?? -1;
  const result = inspectWsPayload(frame.payload, {
    offset: args.offset,
    length: args.length,
    format: args.format,
  });
  let starterPresent = false;
  if (typeof args.text_contains === 'string' && args.text_contains.length > 0) {
    const starter = buildBinaryWsStarter(frame.payload, args.text_contains);
    if (starter) {
      result.starter = starter;
      starterPresent = true;
      recordStarterIssued(args.session_id, wsI, args.text_contains, starter);
    }
  }
  // Discovery-artifact accumulator: record this inspect call so the next
  // session's agent sees "ws_i 493 already probed; starter was issued."
  ringPush(ensureAccumulator(session).inspectWsFrameCalls, {
    ws_i: wsI,
    args_digest: digestArgs({ ws_i: wsI, text_contains: args.text_contains ?? '' }),
    starter_present: starterPresent,
    at: new Date().toISOString(),
  });
  // Surface the stable handle on the response so the agent can pin / reuse.
  (result as { ws_hash?: string }).ws_hash = resolved.hash;
  // Truncate starter.code so a multi-KB generator template doesn't balloon the
  // response past the MCP budget.
  if (result.starter && typeof (result.starter as { code?: unknown }).code === 'string') {
    const code = (result.starter as { code: string }).code;
    if (code.length > INSPECT_STARTER_CODE_CAP) {
      (result.starter as { code: string; code_truncated?: true; code_total_chars?: number }).code =
        truncateString(code, INSPECT_STARTER_CODE_CAP);
      (result.starter as { code_truncated?: true }).code_truncated = true;
      (result.starter as { code_total_chars?: number }).code_total_chars = code.length;
    }
  }
  // For sent frames, point the agent at `get_send_encoder` — the runtime
  // captured a live handle to the WebSocket the page sent through, plus the
  // exact bytes the page passed to `.send()`. The agent can re-send through
  // the SAME already-authenticated socket via
  // `window.__kluraSendEncoders[<key>].ws.send(<bytes>)` without finding the
  // encoder function in the bundle. Fires on every sent frame because the
  // tool is uniformly cheap and most agents don't know about the page-side
  // cache by name.
  if (frame.direction === 'sent') {
    (result as { live_handle_hint?: unknown }).live_handle_hint = {
      tool: 'get_send_encoder',
      args: { session_id: args.session_id, ws_i: wsI },
      reason:
        'klura captured a live handle to the WebSocket that sent this frame and the exact bytes the page passed to `.send()`. ' +
        'Calling `get_send_encoder({ws_i})` returns `encoder_handle: window.__kluraSendEncoders[<key>]` plus structured advice. ' +
        "Use it to re-send through the page's already-authenticated socket — `<handle>.ws.send(<your_bytes>)` — without locating the encoder function in the bundle. " +
        'Faster than reading the bundle when you only need to verify byte layout against the captured `<handle>.sentArgs`.',
    };
  }
  // Surface the JS callstack captured by the page-side WebSocket.send wrapper,
  // when present. Lets the agent jump straight to the encoder source via
  // get_js_source instead of reverse-engineering output bytes.
  if (frame.js_callstack) {
    // Cap frames to keep the callstack under budget even when the page's
    // wrapper captured a deep stack. The top frames are what the agent actually
    // uses (WebSocket.send call site + first few internal frames); anything
    // past INSPECT_CALLSTACK_FRAME_CAP is ring-buffer noise.
    const rawFrames = frame.js_callstack.frames;
    if (rawFrames.length > INSPECT_CALLSTACK_FRAME_CAP) {
      result.js_callstack = {
        ...frame.js_callstack,
        frames: rawFrames.slice(0, INSPECT_CALLSTACK_FRAME_CAP),
        frames_total: rawFrames.length,
        frames_truncated: true,
      } as typeof frame.js_callstack;
    } else {
      result.js_callstack = frame.js_callstack;
    }
    // Pick the top non-anonymous frame with a real URL + line and pin it as the
    // `next_tool_hint`. Skips <anonymous> / blob: / eval-wrapped frames that
    // get_js_source can't fetch. When every frame is unreachable, omit the hint
    // (rare — usually the 2nd-3rd frame is the real encoder).
    const hintFrame = frame.js_callstack.frames.find(
      (f) =>
        typeof f.file === 'string' &&
        typeof f.line === 'number' &&
        (f.file.startsWith('http://') || f.file.startsWith('https://')),
    );
    if (hintFrame && typeof hintFrame.file === 'string' && typeof hintFrame.line === 'number') {
      result.next_tool_hint = {
        primary: 'get_js_source',
        args: {
          session_id: args.session_id,
          url: hintFrame.file,
          line: hintFrame.line,
          context_lines: 80,
        },
        reason:
          'Read the encoder source directly. The callstack above names the file:line where WebSocket.send was called from — `get_js_source` fetches those lines so you see the actual derivations (epoch_id, otid, signatures) in source instead of guessing them from output bytes. Iteration-loop on the starter is the fallback when source is unreadable.',
      };
    }
  }
  return result;
}

export interface FindInWsFrameArgs {
  session_id: string;
  ws_i?: number;
  ws_hash?: string;
  needle: string;
}

/**
 * Locate every byte offset where `needle` appears inside a captured WebSocket
 * frame (treated as raw octets). Returns `{offsets, total_length, truncated?}`.
 * Used by agents composing envelope code to find the byte offset of the
 * user-variable substring inside a length-prefixed binary frame — the anchor
 * for the slice-and-replace shape their `generated.frame.code` will take.
 */
export async function findInWsFrame(args: FindInWsFrameArgs): Promise<FindInWsFrameResult> {
  if (!args.session_id) throw new Error('session_id is required');
  const haveHash = typeof args.ws_hash === 'string' && args.ws_hash.length > 0;
  const haveIdx = typeof args.ws_i === 'number' && args.ws_i >= 0;
  if (!haveHash && !haveIdx) {
    throw new Error(
      'find_in_ws_frame requires ws_i or ws_hash (prefer ws_hash — survives ring rotation)',
    );
  }
  if (typeof args.needle !== 'string' || args.needle.length === 0) {
    throw new Error('needle is required (non-empty string)');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  await driver.getInterceptedWebSocketFrames(session).catch(() => []);
  const { resolveWsFrame } = await import('../response/ws-pin');
  const resolved = resolveWsFrame(session, {
    ...(haveIdx ? { ws_i: args.ws_i } : {}),
    ...(haveHash ? { ws_hash: args.ws_hash } : {}),
  });
  if (!resolved) {
    throw new Error(
      haveHash
        ? `no ws frame matching hash "${args.ws_hash}" (not pinned, not in ring)`
        : `no ws frame at index ${args.ws_i} (session has ${(session.wsFrames ?? []).length} frames captured)`,
    );
  }
  return findInWsPayload(resolved.frame.payload, args.needle);
}

export interface PinWsFrameArgs {
  session_id: string;
  /** Resolve-and-pin by positional ring index. */
  ws_i?: number;
  /** Or re-pin an existing hash (moves it to MRU position). */
  ws_hash?: string;
}

export interface PinWsFrameResult {
  ok: true;
  ws_hash: string;
  /** How many slots are currently occupied after this pin. */
  pinned_count: number;
  /** Hard cap on the session's pinned map. */
  pinned_cap: number;
  /** When present: the hash that was evicted by the LRU during this pin.
   *  Absent when the pin fit within the cap. */
  evicted_hash?: string;
}

/**
 * Explicitly pin a captured WebSocket frame so it survives the ring buffer's
 * FIFO rotation. Returns the stable content hash the agent can pass to every RE
 * tool (`inspect_ws_frame`, `find_in_ws_frame`,
 * `try_generator_in_page.verify_against`, `explain_ws_frame_structure`).
 *
 * Pins are capped at `WS_PINNED_FRAMES_CAP` per session (LRU on overflow). The
 * auto-pin on `end_drive`'s RE nag typically covers the main case; use this
 * tool when an agent wants to protect a frame before end_drive fires, or to
 * re-pin a frame the auto-pin couldn't know about (e.g. a companion ack frame).
 */
export async function pinWsFrame(
  args: PinWsFrameArgs,
): Promise<PinWsFrameResult | { error: string }> {
  if (!args.session_id) return { error: 'session_id is required' };
  const haveHash = typeof args.ws_hash === 'string' && args.ws_hash.length > 0;
  const haveIdx = typeof args.ws_i === 'number' && args.ws_i >= 0;
  if (!haveHash && !haveIdx) {
    return { error: 'pin_ws_frame requires ws_i or ws_hash' };
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  await driver.getInterceptedWebSocketFrames(session).catch(() => []);
  const {
    resolveWsFrame,
    pinWsFrame: pinImpl,
    WS_PINNED_FRAMES_CAP,
  } = await import('../response/ws-pin');
  const resolved = resolveWsFrame(session, {
    ...(haveIdx ? { ws_i: args.ws_i } : {}),
    ...(haveHash ? { ws_hash: args.ws_hash } : {}),
  });
  if (!resolved) {
    return {
      error: haveHash
        ? `no ws frame matching hash "${args.ws_hash}" (not pinned, not in ring)`
        : `no ws frame at index ${args.ws_i} (session has ${(session.wsFrames ?? []).length} frames captured)`,
    };
  }
  const sizeBefore = session.pinnedWsFrames?.size ?? 0;
  const keysBefore = new Set(session.pinnedWsFrames ? [...session.pinnedWsFrames.keys()] : []);
  const hash = pinImpl(session, resolved.frame);
  const sizeAfter = session.pinnedWsFrames?.size ?? 0;
  let evicted: string | undefined;
  if (
    sizeBefore === WS_PINNED_FRAMES_CAP &&
    sizeAfter === WS_PINNED_FRAMES_CAP &&
    !keysBefore.has(hash)
  ) {
    // Pin added a new entry while at cap → one eviction happened. Find which
    // previously-present key is now gone.
    const keysAfter = new Set([...(session.pinnedWsFrames?.keys() ?? [])]);
    for (const k of keysBefore) {
      if (!keysAfter.has(k)) {
        evicted = k;
        break;
      }
    }
  }
  return {
    ok: true,
    ws_hash: hash,
    pinned_count: sizeAfter,
    pinned_cap: WS_PINNED_FRAMES_CAP,
    ...(evicted ? { evicted_hash: evicted } : {}),
  };
}
