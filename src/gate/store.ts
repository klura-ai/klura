// In-process token store for Level-3 gates. One module, one map — two
// different gates (save-audit, consent-audit) cannot collide on the same
// token space because entries are namespaced by `kind`.
//
// Tokens are ephemeral: issued on a rejected first call, consumed on a
// successful commit, swept after TTL. The runtime never persists them —
// restarting the daemon invalidates all outstanding tokens, which is fine
// because the agent is expected to complete a gate within one conversation.

import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

interface StoredToken {
  kind: string;
  payloadHash: string;
  // The structured value that was hashed, retained so a `payload_changed`
  // rejection can diff old vs. new and tell the agent which fields shifted.
  // Deep-cloned at issue time to decouple from the caller's references.
  hashInput?: unknown;
  issuedAt: number;
  expiresAt: number;
}

const tokens = new Map<string, StoredToken>();

let sweepTimer: NodeJS.Timeout | null = null;
function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of tokens) {
      if (entry.expiresAt <= now) tokens.delete(token);
    }
  }, SWEEP_INTERVAL_MS);
  // Don't hold the process open on this timer.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

export function issueToken(args: {
  kind: string;
  payloadHash: string;
  hashInput?: unknown;
  ttlMs?: number;
}): string {
  ensureSweeper();
  const token = randomBytes(9).toString('base64url'); // 12-char url-safe
  const now = Date.now();
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS;
  tokens.set(token, {
    kind: args.kind,
    payloadHash: args.payloadHash,
    hashInput: args.hashInput === undefined ? undefined : cloneStructured(args.hashInput),
    issuedAt: now,
    expiresAt: now + ttl,
  });
  return token;
}

function cloneStructured(value: unknown): unknown {
  // JSON round-trip is sufficient for gate hash inputs (always JSON-shaped:
  // strings, numbers, booleans, plain objects, arrays). Decouples the
  // stored snapshot from caller-side mutation between issue and lookup.
  return JSON.parse(JSON.stringify(value));
}

export type { StoredToken };

export function lookupToken(token: string): StoredToken | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  return entry;
}

export function consumeToken(token: string): void {
  tokens.delete(token);
}

// Test helper — not exported from index. Tests import directly.
export function __resetStore(): void {
  tokens.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
