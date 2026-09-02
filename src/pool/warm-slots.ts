// Warm-slot bookkeeping primitives: the per-`(platform, identity)` slot
// record and the pure key / device-fingerprint derivations the Pool's
// checkout protocol compares against. Stateless by design — the slot map
// and its lifecycle (claim, restash, evict, sweep) live on the Pool.

import type { BrowserLease, SessionOptions } from '../drivers/types/session';

/**
 * One per-`(platform, identity)` warm slot. While idle, the slot holds an
 * opaque `BrowserLease` — the driver-side browser-resource bundle (context,
 * pages, capture plumbing) detached from the session that released it. The
 * Session object itself dies at release: every checkout mints a FRESH
 * Session and binds the lease onto it via `driver.attachLease`, so no
 * logical field (phase bookkeeping, consent flags, action history, save
 * records) can survive from one klura session into the next.
 */
export interface WarmEntry {
  platform: string;
  /** Account name on the platform — see `Session.identity`. Default-when-omitted
   *  is `"default"`. The warm-slot key composes `platform + identity` so two
   *  accounts on the same platform never share a slot. */
  identity: string;
  /** Detached browser resources while the slot is idle; null while a live
   *  session has them checked out. */
  lease: BrowserLease | null;
  /** Id of the live session currently holding the slot's resources; null
   *  while idle. Rotates on every checkout. */
  sessionId: string | null;
  /** Device profile the slot's BrowserContext was created with (UA, viewport,
   *  touch, mobile emulation — all context-creation-time settings). A checkout
   *  whose requested profile differs evicts the lease and cold-spawns: a
   *  desktop-warmed context must never serve a mobile-emulated request. */
  deviceFingerprint: string;
  lastUsedAt: number;
  inUse: boolean;
}

/**
 * Serialize the context-creation-time device settings from SessionOptions for
 * warm-slot compatibility checks. Deliberately excludes `deviceScaleFactor`:
 * it only affects rendering density, not what a reused context can serve, and
 * not every checkout path threads it — including it would evict perfectly
 * good leases on discovery→execute alternation.
 */
export function deviceFingerprintOf(opts: SessionOptions): string {
  return JSON.stringify({
    userAgent: opts.userAgent ?? null,
    viewport: opts.viewport ? { width: opts.viewport.width, height: opts.viewport.height } : null,
    hasTouch: opts.hasTouch === true,
    isMobile: opts.isMobile === true,
  });
}

/** Default identity slug for sessions that supply none — the slot for a
 *  no-identity-supplied session is `"<platform>::default"`, distinct from
 *  any named identity. See klura://reference#identities. */
export const DEFAULT_IDENTITY = 'default';

/** Compose the warm-slot map key from a `(platform, identity)` tuple. The
 *  `::` separator is unambiguous: platform slug and identity slug are both
 *  defined to exclude colons, so the joined key parses cleanly even if the
 *  platform contains dashes. */
export function warmKey(platform: string, identity?: string): string {
  return `${platform}::${identity || DEFAULT_IDENTITY}`;
}
