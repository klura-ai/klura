// Node-side WebSocket client for `protocol:'websocket'` on the fetch tier (Node
// dial) strategies. Opens a single WebSocket connection, sends a single frame,
// optionally waits for a matching ack, closes.
//
// Driver-agnostic on purpose — no Session, no page, no browser context. The
// executor resolves `wsUrl` and `wsHeaders` via the same `interpolateVars`
// helper the HTTP-Node path uses for headers, then hands them here.
//
// Fingerprint-bound sites will reject Node-originated WS handshakes even with
// the right cookies (TLS JA3, h2 frame ordering, sec-ch-ua* presence). Runtime
// handles that via the transport-demotion path — consecutive failures flip the
// strategy's transport to 'browser'.

import { WebSocket } from 'ws';
import type { WebSocket as WebSocketType } from 'ws';

interface SendNodeWebSocketFrameOptions {
  /** Substring that must appear in a received message for success.
   *  Absent = fire-and-forget. */
  ackMatch?: string;
  /** Upper bound on waiting for the ackMatch frame. Default 5000. */
  ackTimeoutMs?: number;
  /** Upper bound on the WebSocket handshake. Default 5000. */
  openTimeoutMs?: number;
  /** Upper bound on the complete handshake, send, and optional ack. */
  timeoutMs?: number;
}

type NodeWebSocketFailureCode =
  | 'ack_timeout'
  | 'closed_before_ack'
  | 'connection_error'
  | 'construct_failed'
  | 'open_timeout'
  | 'request_timeout'
  | 'send_failed'
  | 'send_threw';

type SendNodeWebSocketFrameResult =
  | { ok: true; ackPayload?: string }
  | { ok: false; code: NodeWebSocketFailureCode; error: string; sent: boolean };

/**
 * Open a WebSocket to `url`, send `payload`, optionally wait for an ack
 * matching `opts.ackMatch`, then close. All timeouts are bounded so a hung
 * server can't leak a connection. `payload` can be a string (text frame) or
 * Uint8Array (binary frame).
 *
 * Headers are passed verbatim to the upgrade request. Caller is responsible for
 * only passing safe headers — the save-time probe rejects entries in the
 * runtime's UNSAFE_HEADERS set before a strategy that uses Node transport can
 * be saved.
 */
export async function sendNodeWebSocketFrame(
  url: string,
  headers: Record<string, string>,
  payload: string | Uint8Array,
  opts: SendNodeWebSocketFrameOptions = {},
): Promise<SendNodeWebSocketFrameResult> {
  const ackTimeoutMs = opts.ackTimeoutMs ?? 5000;
  const openTimeoutMs = opts.openTimeoutMs ?? 5000;
  const timeoutMs = opts.timeoutMs;

  return await new Promise<SendNodeWebSocketFrameResult>((resolve) => {
    let ws: WebSocketType | null = null;
    let settled = false;
    let sent = false;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    let requestTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: SendNodeWebSocketFrameResult): void => {
      if (settled) return;
      settled = true;
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      if (ackTimer) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    const onAckTimeout = (): void => {
      settle({
        ok: false,
        code: 'ack_timeout',
        error: `ack_timeout: ${ackTimeoutMs}ms`,
        sent: true,
      });
    };

    const onSendComplete = (err?: Error): void => {
      if (err) {
        settle({
          ok: false,
          code: 'send_failed',
          error: `ws_send_failed: ${err.message}`,
          sent: true,
        });
        return;
      }
      if (settled) return;
      if (!opts.ackMatch) {
        settle({ ok: true });
        return;
      }
      ackTimer = setTimeout(onAckTimeout, ackTimeoutMs);
      (ackTimer as unknown as { unref?: () => void }).unref?.();
    };

    if (timeoutMs !== undefined) {
      requestTimer = setTimeout(() => {
        settle({
          ok: false,
          code: 'request_timeout',
          error: `ws_request_timeout: ${timeoutMs}ms`,
          sent,
        });
      }, timeoutMs);
      (requestTimer as unknown as { unref?: () => void }).unref?.();
    }

    try {
      ws = new WebSocket(url, { headers });
    } catch (e) {
      settle({
        ok: false,
        code: 'construct_failed',
        error: `ws_construct_failed: ${e instanceof Error ? e.message : String(e)}`,
        sent: false,
      });
      return;
    }

    openTimer = setTimeout(() => {
      settle({
        ok: false,
        code: 'open_timeout',
        error: `ws_open_timeout: ${openTimeoutMs}ms`,
        sent: false,
      });
    }, openTimeoutMs);
    (openTimer as unknown as { unref?: () => void }).unref?.();

    ws.on('open', () => {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      // Fire-and-forget path: no ack expected — send, resolve success. Listener
      // for incoming frames still attached below, so a racing inbound frame
      // before we close doesn't crash.
      try {
        // Once ws.send is invoked, remote delivery is conservatively unknown
        // until an acknowledgement proves success. Callback errors, closes,
        // and total timeouts must not make the caller replay a possible write.
        sent = true;
        ws.send(payload, onSendComplete);
      } catch (e) {
        sent = false;
        settle({
          ok: false,
          code: 'send_threw',
          error: `ws_send_threw: ${e instanceof Error ? e.message : String(e)}`,
          sent: false,
        });
        return;
      }
    });

    ws.on('message', (data) => {
      if (!opts.ackMatch || settled) return;
      let str = '';
      if (typeof data === 'string') {
        str = data;
      } else if (Buffer.isBuffer(data)) {
        str = data.toString();
      }
      if (str.includes(opts.ackMatch)) {
        settle({ ok: true, ackPayload: str });
      }
    });

    ws.on('error', (err) => {
      settle({
        ok: false,
        code: 'connection_error',
        error: `ws_error: ${err.message}`,
        sent,
      });
    });

    ws.on('close', (code, reason) => {
      if (settled) return;
      // A close before we got an ack or sent-and-fire-and-forget is treated as
      // a failure — the server hung up on us.
      const reasonStr = reason.toString();
      const reasonPart = reasonStr ? ` reason=${reasonStr}` : '';
      settle({
        ok: false,
        code: 'closed_before_ack',
        error: `ws_closed_before_ack: code=${code}${reasonPart}`,
        sent,
      });
    });
  });
}
