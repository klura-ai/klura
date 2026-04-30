// Strategy health tracking — monitors success/failure and degrades broken
// strategies. Health state is persisted per-platform to
// `~/.klura/workdir/<platform>/health.json` so it survives daemon restarts.

import fs from 'fs';
import path from 'path';
import { appendStrategyEvent } from '../working-dir/logbook';
import { healthPath } from '../working-dir/layout';
import type { WireProtocol } from './validate';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'broken';
  lastSuccess?: number;
  lastFailure?: number;
  failureCount: number;
  lastError?: string;
  healCount?: number;
  lastHeal?: number;
  /**
   * Rolling window of the last RECENT_WINDOW execution outcomes (true = success).
   * Used to compute a success rate independent of consecutive-failure semantics
   * — a strategy that flaps 4-fail-1-pass-4-fail forever stays healthy by
   * `failureCount` but its rolling rate exposes the rot. Pre-execute
   * rediscover gate reads this; threshold lives in pool.rediscoverThreshold.
   */
  recent?: boolean[];
  /**
   * Node transport failure counters, keyed by protocol ('http' | 'websocket').
   * Separate counters so a flaky HTTP-Node site doesn't carry over to its ws
   * strategies and vice versa. Counts only transport-shaped failures
   * (Cloudflare, TLS, HTTP/2 protocol errors, ws handshake drops), not normal
   * API errors. After NODE_TRANSPORT_FAIL_THRESHOLD consecutive failures within
   * a single protocol, the runtime demotes the strategy from `fetch` to
   * `page-script` so future warm runs skip the Node attempt entirely. A
   * successful Node execute on that protocol resets the counter.
   */
  nodeTransportFailureCounts?: Record<string, number>;
  /** Per-protocol last-signal string (same keys as the counter map). */
  lastNodeTransportSignals?: Record<string, string>;
}

const BROKEN_THRESHOLD = 5;
export const RECENT_WINDOW = 20;
export const MIN_SAMPLES_FOR_RATE = 5;
// Number of consecutive Node-transport-shaped failures before we demote the
// strategy from `fetch` to `page-script` and stop trying the fast path. 3
// survives a single transient flake; catches a real incompatibility within a
// couple of warm runs.
export const NODE_TRANSPORT_FAIL_THRESHOLD = 3;

function innerKey(capability: string, strategyType: string): string {
  return `${capability}/${strategyType}`;
}

// On-disk shape for the health file. The strategy-level entries are keyed
// by `${capability}/${strategyType}`; the underscore-prefixed keys are
// reserved for file-level metadata (silenced capabilities for the
// rediscover gate, etc.) — collisions with capability names are excluded
// by the validator slug rules.
interface PlatformHealthFile {
  [key: string]: HealthStatus | string[] | undefined;
  _dontAskRediscover?: string[];
}

function loadPlatformHealth(platform: string): PlatformHealthFile {
  const p = healthPath(platform);
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as PlatformHealthFile;
    }
  } catch {
    // Corrupt file — start fresh.
  }
  return {};
}

function writePlatformHealth(platform: string, data: PlatformHealthFile): void {
  const p = healthPath(platform);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch {
    // Best-effort — don't crash on write failure
  }
}

function getStatus(data: PlatformHealthFile, key: string): HealthStatus | undefined {
  const v = data[key];
  if (v && !Array.isArray(v) && typeof v === 'object') return v;
  return undefined;
}

function pushOutcome(prev: HealthStatus | undefined, success: boolean): boolean[] {
  const recent = [...(prev?.recent ?? []), success];
  return recent.length > RECENT_WINDOW ? recent.slice(-RECENT_WINDOW) : recent;
}

export function markHealthy(platform: string, capability: string, strategyType: string): void {
  const k = innerKey(capability, strategyType);
  const data = loadPlatformHealth(platform);
  const prev = getStatus(data, k);
  data[k] = {
    status: 'healthy',
    lastSuccess: Date.now(),
    failureCount: 0,
    recent: pushOutcome(prev, true),
    // Preserve heal history across recoveries — a strategy that naturally
    // recovers after a transient failure shouldn't forget it was ever healed.
    healCount: prev?.healCount,
    lastHeal: prev?.lastHeal,
    // Preserve the Node transport counters across normal health resets — a
    // `markHealthy` caller doesn't know WHICH protocol just succeeded, so
    // `recordNodeTransportSuccess(protocol)` is the dedicated reset path.
    nodeTransportFailureCounts: prev?.nodeTransportFailureCounts,
    lastNodeTransportSignals: prev?.lastNodeTransportSignals,
  };
  writePlatformHealth(platform, data);
}

/**
 * Record a transport-shaped Node failure (HTTP fetch throw, or ws handshake
 * drop) against a specific protocol. Independent counters per protocol so a
 * flaky HTTP-Node site doesn't pollute the ws bucket and vice versa. Returns
 * the new counter value for the caller to compare against
 * NODE_TRANSPORT_FAIL_THRESHOLD.
 */
export function recordNodeTransportFailure(
  platform: string,
  capability: string,
  strategyType: string,
  protocol: WireProtocol,
  signal: string,
): number {
  const k = innerKey(capability, strategyType);
  const data = loadPlatformHealth(platform);
  const prev = getStatus(data, k) || { status: 'healthy' as const, failureCount: 0 };
  const counts = { ...(prev.nodeTransportFailureCounts ?? {}) };
  counts[protocol] = (counts[protocol] ?? 0) + 1;
  const signals = { ...(prev.lastNodeTransportSignals ?? {}) };
  signals[protocol] = signal;
  data[k] = {
    ...prev,
    nodeTransportFailureCounts: counts,
    lastNodeTransportSignals: signals,
  };
  writePlatformHealth(platform, data);
  return counts[protocol];
}

/** Reset the per-protocol Node transport counter. Called on a clean
 * execute over that same protocol so a transient spell doesn't
 *  permanently demote the strategy. */
export function recordNodeTransportSuccess(
  platform: string,
  capability: string,
  strategyType: string,
  protocol: WireProtocol,
): void {
  const k = innerKey(capability, strategyType);
  const data = loadPlatformHealth(platform);
  const prev = getStatus(data, k);
  if (!prev?.nodeTransportFailureCounts?.[protocol]) return;
  const counts: Record<string, number> = {};
  for (const [ck, cv] of Object.entries(prev.nodeTransportFailureCounts ?? {})) {
    if (ck !== protocol) counts[ck] = cv;
  }
  const signals: Record<string, string> = {};
  for (const [sk, sv] of Object.entries(prev.lastNodeTransportSignals ?? {})) {
    if (sk !== protocol) signals[sk] = sv;
  }
  data[k] = {
    ...prev,
    nodeTransportFailureCounts: counts,
    lastNodeTransportSignals: signals,
  };
  writePlatformHealth(platform, data);
}

export function markFailed(
  platform: string,
  capability: string,
  strategyType: string,
  error: string,
): void {
  const k = innerKey(capability, strategyType);
  const data = loadPlatformHealth(platform);
  const prev = getStatus(data, k) || { status: 'healthy' as const, failureCount: 0 };
  const failureCount = prev.failureCount + 1;
  data[k] = {
    status: failureCount >= BROKEN_THRESHOLD ? 'broken' : 'degraded',
    lastFailure: Date.now(),
    lastSuccess: prev.lastSuccess,
    failureCount,
    lastError: error,
    recent: pushOutcome(prev, false),
    // Preserve heal history across failure cycles so repeated heal/break pairs
    // keep accumulating instead of resetting healCount back to 1 each time.
    healCount: prev.healCount,
    lastHeal: prev.lastHeal,
    nodeTransportFailureCounts: prev.nodeTransportFailureCounts,
    lastNodeTransportSignals: prev.lastNodeTransportSignals,
  };
  writePlatformHealth(platform, data);
}

export function getHealth(
  platform: string,
  capability: string,
  strategyType: string,
): HealthStatus {
  const data = loadPlatformHealth(platform);
  return (
    getStatus(data, innerKey(capability, strategyType)) || {
      status: 'healthy',
      failureCount: 0,
    }
  );
}

/** Compute success rate over the rolling window. Returns null when the
 *  sample size is below MIN_SAMPLES_FOR_RATE — callers must treat that as
 *  "not enough signal" rather than "100%". */
export function successRate(status: HealthStatus): number | null {
  const recent = status.recent ?? [];
  if (recent.length < MIN_SAMPLES_FOR_RATE) return null;
  const ok = recent.filter((b) => b).length;
  return ok / recent.length;
}

export function isBroken(platform: string, capability: string, strategyType: string): boolean {
  return getHealth(platform, capability, strategyType).status === 'broken';
}

/** True when the user has chosen "don't ask again" for this capability's
 *  rediscover gate. Persists across daemon restarts; cleared by
 *  `unsilenceCapability` or `resetHealth`. */
export function isSilenced(platform: string, capability: string): boolean {
  const data = loadPlatformHealth(platform);
  return (data._dontAskRediscover ?? []).includes(capability);
}

export function silenceCapability(platform: string, capability: string): void {
  const data = loadPlatformHealth(platform);
  const list = data._dontAskRediscover ?? [];
  if (list.includes(capability)) return;
  data._dontAskRediscover = [...list, capability];
  writePlatformHealth(platform, data);
}

export function unsilenceCapability(platform: string, capability: string): void {
  const data = loadPlatformHealth(platform);
  const list = data._dontAskRediscover ?? [];
  if (!list.includes(capability)) return;
  data._dontAskRediscover = list.filter((c) => c !== capability);
  writePlatformHealth(platform, data);
}

/** List every per-strategy health entry for a platform. The underscore-
 *  prefixed file-level keys (silence list) are filtered out. */
export function listPlatformHealth(
  platform: string,
): Array<{ capability: string; strategyType: string; status: HealthStatus }> {
  const data = loadPlatformHealth(platform);
  const out: Array<{ capability: string; strategyType: string; status: HealthStatus }> = [];
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('_')) continue;
    if (!v || Array.isArray(v) || typeof v !== 'object') continue;
    const slash = k.indexOf('/');
    if (slash < 0) continue;
    out.push({
      capability: k.slice(0, slash),
      strategyType: k.slice(slash + 1),
      status: v,
    });
  }
  return out;
}

export function markHealed(platform: string, capability: string, strategyType: string): void {
  const k = innerKey(capability, strategyType);
  const data = loadPlatformHealth(platform);
  const prev = getStatus(data, k) || { status: 'healthy' as const, failureCount: 0 };
  const healCount = (prev.healCount ?? 0) + 1;
  data[k] = {
    status: 'healthy',
    lastSuccess: Date.now(),
    lastFailure: prev.lastFailure,
    failureCount: 0,
    lastError: prev.lastError,
    recent: pushOutcome(prev, true),
    healCount,
    lastHeal: Date.now(),
  };
  writePlatformHealth(platform, data);
  appendStrategyEvent(platform, capability, {
    strategy: strategyType,
    kind: 'healed',
    detail: `healed (count: ${healCount})`,
  });
}

export function resetHealth(platform: string, capability: string, strategyType: string): void {
  const k = innerKey(capability, strategyType);
  const data = loadPlatformHealth(platform);
  Reflect.deleteProperty(data, k);
  writePlatformHealth(platform, data);
}
