// WebSocket-frame pinning + content-addressed lookup.
//
// The session's `wsFrames` ring buffer is FIFO-capped to prevent unbounded
// memory growth on chatty sites. But that means any RE workflow that keeps
// referring back to a specific captured frame (`inspect_ws_frame` →
// `try_generator_in_page`'s `verify_against` → `find_in_ws_frame` to re-check)
// watches its target scroll past the eviction point as new frames arrive.
// Agents end up chasing indices through a moving window and eventually lose the
// reference entirely.
//
// Two primitives fix it:
//
// 1. **Content-hashed handle** — every shaped frame carries a `ws_hash` that is
// stable for the lifetime of the payload. Tools accept `ws_hash` anywhere they
// accept `ws_i`; hash wins when both are present.
//
// 2. **Pinned slots** — a small per-session map (cap 8) of `ws_hash → verbatim
// WebSocketFrame`. Frames land in the map via: - `end_drive`'s RE nag
// (auto-pin of `signal.ws_i`) - the explicit `pin_ws_frame` tool and stay
// available for lookup even after the ring has rotated past them. Resolver
// functions try the pinned map first, then the ring.
//
// The cap is enforced with a simple LRU: on overflow, the oldest entry (by
// insertion order; Map preserves it) gets evicted. 8 is arbitrary but matches
// the depth most RE sessions actually need to pin — the target frame, one or
// two ack frames, maybe a prior send to diff against. Agents that genuinely
// need more should save progress to the discovery artifact and start a fresh
// session.

import crypto from 'crypto';
import type { Session } from '../drivers/types/session';
import type { WebSocketFrame } from '../drivers/types/websocket';

export const WS_PINNED_FRAMES_CAP = 8;

/**
 * Elevated ring-buffer cap the runtime applies to the session's `wsFrames`
 * ring whenever a structurally interesting frame surfaces to the agent
 * (binary WS, signed body, etc. — labelled inline by
 * `envelope-advisories.ts` from `network-log-shape.ts` /
 * `ws-frame-starter.ts`). The driver's push-frame hook reads
 * `session.wsFramesCap` on every push, so simply writing this value onto
 * the session mid-flight takes effect on the next captured frame. 10k vs
 * the default 2k gives a typical 100-round RE session enough headroom that
 * probe sends don't evict un-pinned reference frames; pinning is still
 * the primary guarantee (see `pinWsFrame` above).
 */
export const WS_FRAMES_BUFFER_CAP_RE_MODE = 10_000;

/**
 * Content hash of a WebSocket frame. Stable across ring-buffer rotation, stable
 * across session restarts that see the same bytes, collision-safe enough for
 * single-session matching (SHA-256, 12 hex chars prefix = 48 bits of entropy,
 * roughly 1 in 280 trillion).
 *
 * Hashes `direction|url|payload` so a sent and a received frame with identical
 * bytes get distinct hashes (which is the intuitive behavior: the same JSON on
 * the wire in two directions represents two different events).
 */
export function hashWsFrame(frame: WebSocketFrame): string {
  const h = crypto.createHash('sha256');
  h.update(frame.direction);
  h.update('|');
  h.update(frame.url);
  h.update('|');
  h.update(frame.payload);
  return h.digest('hex').slice(0, 12);
}

/**
 * Add a frame to the session's pinned map. Idempotent on the same hash.
 * Enforces `WS_PINNED_FRAMES_CAP` via Map-insertion-order LRU: on overflow, the
 * oldest-inserted entry is dropped.
 *
 * Returns the hash so callers can log / return it to the agent.
 */
export function pinWsFrame(session: Session, frame: WebSocketFrame): string {
  const hash = hashWsFrame(frame);
  let map = session.pinnedWsFrames;
  if (!map) {
    map = new Map();
    session.pinnedWsFrames = map;
  }
  // Bump to MRU by re-inserting.
  if (map.has(hash)) {
    map.delete(hash);
  }
  map.set(hash, frame);
  // LRU eviction.
  while (map.size > WS_PINNED_FRAMES_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return hash;
}

/**
 * Unified lookup: find a frame by either positional index (ring buffer) or
 * content hash (pinned map first, ring fallback by hash scan). When both are
 * given, ws_hash wins because positional has already been demonstrated to be
 * unreliable at session-scale.
 *
 * Returns `{ frame, from: 'pinned' | 'ring', i? }` so callers can surface
 * `from` in responses for diagnostic clarity and the original ring index when
 * available.
 */
interface ResolvedFrame {
  frame: WebSocketFrame;
  hash: string;
  from: 'pinned' | 'ring';
  /** Ring-buffer index when the frame is still live in the ring. Absent
   *  for pinned frames that rotated past the eviction point. */
  i?: number;
  /** Set when the agent passed ws_i but the runtime detected that the
   *  frame at that index has changed since ws_i was last resolved
   *  (ring rotated). The runtime auto-upgrades to the previous hash
   *  if found in the ring or pinned map; this note describes what
   *  happened so tool callers can surface it in the response. */
  stale_upgrade_note?: string;
}

export function resolveWsFrame(
  session: Session,
  opts: { ws_i?: number; ws_hash?: string },
): ResolvedFrame | null {
  const ring = session.wsFrames ?? [];
  const pinned = session.pinnedWsFrames;

  // Hash takes precedence — positional is fragile.
  if (typeof opts.ws_hash === 'string' && opts.ws_hash.length > 0) {
    const pinnedFrame = pinned?.get(opts.ws_hash);
    if (pinned && pinnedFrame) {
      const frame = pinnedFrame;
      // Bump MRU.
      pinned.delete(opts.ws_hash);
      pinned.set(opts.ws_hash, frame);
      // Is this hash also present in the live ring? Surface its current index
      // for callers that want to emit stale-index warnings.
      const ringIdx = ring.findIndex((f) => hashWsFrame(f) === opts.ws_hash);
      if (ringIdx >= 0) recordWsIndexResolution(session, ringIdx, opts.ws_hash);
      return {
        frame,
        hash: opts.ws_hash,
        from: 'pinned',
        ...(ringIdx >= 0 ? { i: ringIdx } : {}),
      };
    }
    // Hash not pinned — scan the ring. Slower but not expected to be hot
    // (hashes are produced by shaping, agents typically pass back what they
    // just received).
    for (let i = 0; i < ring.length; i += 1) {
      const f = ring[i];
      if (!f) continue;
      if (hashWsFrame(f) === opts.ws_hash) {
        recordWsIndexResolution(session, i, opts.ws_hash);
        return { frame: f, hash: opts.ws_hash, from: 'ring', i };
      }
    }
    return null;
  }

  if (typeof opts.ws_i === 'number' && opts.ws_i >= 0 && opts.ws_i < ring.length) {
    const frame = ring[opts.ws_i];
    if (!frame) return null;
    const currentHash = hashWsFrame(frame);
    const priorHash = session.wsIndexLog?.get(opts.ws_i);
    // Staleness check: the agent passed a ws_i we resolved previously, but the
    // current frame at that index has a different content hash. The ring has
    // rotated — ws_i now points at a different frame.
    if (priorHash && priorHash !== currentHash) {
      // Try to auto-upgrade by finding the prior hash elsewhere in the ring or
      // pinned map.
      const priorPinned = pinned?.get(priorHash);
      if (priorPinned) {
        const ringIdx = ring.findIndex((f) => hashWsFrame(f) === priorHash);
        const currentRingIndex = ringIdx >= 0 ? `, current ring index ${ringIdx}` : '';
        return {
          frame: priorPinned,
          hash: priorHash,
          from: 'pinned',
          ...(ringIdx >= 0 ? { i: ringIdx } : {}),
          stale_upgrade_note:
            `ws_i=${opts.ws_i} is stale: the ring rotated since that index was last resolved. ` +
            `Auto-upgraded to the frame previously seen at that position (ws_hash=${priorHash}, now pinned${currentRingIndex}). ` +
            `Prefer ws_hash over ws_i in RE loops to avoid the round-trip.`,
        };
      }
      const ringIdx = ring.findIndex((f) => hashWsFrame(f) === priorHash);
      const upgradedFrame = ringIdx >= 0 ? ring[ringIdx] : undefined;
      if (upgradedFrame) {
        recordWsIndexResolution(session, ringIdx, priorHash);
        return {
          frame: upgradedFrame,
          hash: priorHash,
          from: 'ring',
          i: ringIdx,
          stale_upgrade_note:
            `ws_i=${opts.ws_i} is stale: the ring rotated and a different frame sits at that index now. ` +
            `Auto-upgraded to the frame previously seen at that position (ws_hash=${priorHash}, now at ring index ${ringIdx}). ` +
            `Prefer ws_hash over ws_i in RE loops to avoid the round-trip.`,
        };
      }
      // Prior hash not in ring or pinned — it rotated out entirely. Fall
      // through to the current-frame resolve, but flag the drift.
      recordWsIndexResolution(session, opts.ws_i, currentHash);
      return {
        frame,
        hash: currentHash,
        from: 'ring',
        i: opts.ws_i,
        stale_upgrade_note:
          `ws_i=${opts.ws_i} may be stale: the frame previously at this index (ws_hash=${priorHash}) ` +
          `has rotated out of the ring and is not pinned; the current frame here has a different hash (${currentHash}). ` +
          `If this isn't the frame you wanted, re-run inspect_ws_frame with the ws_hash you recorded earlier.`,
      };
    }
    recordWsIndexResolution(session, opts.ws_i, currentHash);
    return { frame, hash: currentHash, from: 'ring', i: opts.ws_i };
  }

  return null;
}

// Bounded-size per-session memoization of the most recent ws_i → ws_hash
// resolutions. Consumed by the staleness check above. Size cap keeps the map
// from growing unboundedly on chatty sessions; LRU-ish via rekey on update.
const WS_INDEX_LOG_CAP = 256;

function recordWsIndexResolution(session: Session, wsI: number, wsHash: string): void {
  if (!session.wsIndexLog) session.wsIndexLog = new Map();
  const log = session.wsIndexLog;
  log.delete(wsI);
  log.set(wsI, wsHash);
  if (log.size > WS_INDEX_LOG_CAP) {
    const oldest = log.keys().next();
    if (!oldest.done) log.delete(oldest.value);
  }
}
