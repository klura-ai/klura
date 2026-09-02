// Strategy health tracking — monitors success/failure and degrades broken
// strategies. Health state is persisted per-platform to
// `~/.klura/workdir/<platform>/health.json` so it survives daemon restarts.

import fs from 'fs';
import { appendStrategyEvent } from '../working-dir/logbook';
import { healthPath } from '../working-dir/layout';
import { loadConfig } from '../config/handler';
import { looseJsonCodec, updateJsonFile } from '../utils/owner-file-lock';
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
   * (CDN/edge refusals, TLS, HTTP/2 protocol errors, ws handshake drops), not normal
   * API errors. After NODE_TRANSPORT_FAIL_THRESHOLD consecutive failures within
   * a single protocol, the runtime demotes the strategy from `fetch` to
   * `page-script` so future warm runs skip the Node attempt entirely. A
   * successful Node execute on that protocol resets the counter.
   */
  nodeTransportFailureCounts?: Record<string, number>;
  /** Per-protocol last-signal string (same keys as the counter map). */
  lastNodeTransportSignals?: Record<string, string>;
  /**
   * Unix-ms of the most recent probation probe against a `broken` tier,
   * stamped by `markProbeAttempted` immediately BEFORE the probe runs. The
   * probation clock is `max(lastFailure, lastProbeAt)`: an outcome that
   * returns without touching health (`not_run`, `delivery_unknown`) leaves
   * `lastFailure` untouched, so without this stamp the probe would re-fire on
   * every subsequent call.
   */
  lastProbeAt?: number;
}

const BROKEN_THRESHOLD = 5;
/** Milliseconds in an hour — probation arithmetic. */
const HOUR_MS = 3_600_000;
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

const healthCodec = looseJsonCodec<PlatformHealthFile>(() => ({}));

function loadPlatformHealth(platform: string): PlatformHealthFile {
  try {
    return healthCodec.read(fs.readFileSync(healthPath(platform), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Serialized best-effort read-modify-write over the platform health file.
 * Concurrent processes take `<health.json>.lock` so updates never overwrite
 * each other, and the write is atomic so a crash cannot leave a torn file.
 * Contention or write failure drops the update silently — a health update
 * must never fail the surrounding execute.
 */
function updatePlatformHealth(
  platform: string,
  mutate: (data: PlatformHealthFile) => PlatformHealthFile | null,
): void {
  try {
    updateJsonFile(healthPath(platform), healthCodec, mutate);
  } catch {
    // Best-effort — don't crash on lock contention or write failure.
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
  updatePlatformHealth(platform, (data) => {
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
    return data;
  });
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
  let updatedCount = 0;
  updatePlatformHealth(platform, (data) => {
    const prev = getStatus(data, k) || { status: 'healthy' as const, failureCount: 0 };
    const counts = { ...(prev.nodeTransportFailureCounts ?? {}) };
    counts[protocol] = (counts[protocol] ?? 0) + 1;
    updatedCount = counts[protocol];
    const signals = { ...(prev.lastNodeTransportSignals ?? {}) };
    signals[protocol] = signal;
    data[k] = {
      ...prev,
      nodeTransportFailureCounts: counts,
      lastNodeTransportSignals: signals,
    };
    return data;
  });
  return updatedCount;
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
  updatePlatformHealth(platform, (data) => {
    const prev = getStatus(data, k);
    if (!prev?.nodeTransportFailureCounts?.[protocol]) return null;
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
    return data;
  });
}

export function markFailed(
  platform: string,
  capability: string,
  strategyType: string,
  error: string,
): void {
  const k = innerKey(capability, strategyType);
  updatePlatformHealth(platform, (data) => {
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
    return data;
  });
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

/**
 * What the executor should do with one tier of a capability.
 *
 *  - `run`   — the tier isn't broken; execute it normally.
 *  - `probe` — the tier is broken but its probation window has elapsed. Run it
 *              once; the outcome re-decides its health. The caller stamps
 *              `markProbeAttempted` first so the clock resets even when the
 *              outcome carries no health signal.
 *  - `skip`  — the tier is broken and still inside probation. `nextProbeAt` is
 *              the unix-ms it becomes probe-eligible, or `null` when probation
 *              is disabled (`pool.brokenProbationHours = 0`) and the tier stays
 *              skipped until something else heals it.
 */
export type BrokenTierDecision =
  | { action: 'run' }
  | { action: 'probe'; sinceLastFailureMs: number }
  | { action: 'skip'; nextProbeAt: number | null };

/**
 * Pure probation policy over an already-loaded status. `probationHours` of 0
 * disables probation entirely — a broken tier is skipped until a heal, a
 * candidate promotion, or `resetHealth` clears the record.
 */
export function evaluateBrokenTierProbation(
  status: HealthStatus,
  probationHours: number,
  now: number = Date.now(),
): BrokenTierDecision {
  if (status.status !== 'broken') return { action: 'run' };
  if (probationHours <= 0) return { action: 'skip', nextProbeAt: null };
  const since = Math.max(status.lastFailure ?? 0, status.lastProbeAt ?? 0);
  const nextProbeAt = since + probationHours * HOUR_MS;
  if (now >= nextProbeAt) return { action: 'probe', sinceLastFailureMs: now - since };
  return { action: 'skip', nextProbeAt };
}

/**
 * Probation decision for one saved tier, read from disk + config. Called at
 * execute time, lazily — a broken tier unfreezes because someone tried to use
 * it, never because a timer fired.
 */
export function shouldSkipBrokenTier(
  platform: string,
  capability: string,
  strategyType: string,
  opts: { probationHours?: number; now?: number } = {},
): BrokenTierDecision {
  const status = getHealth(platform, capability, strategyType);
  if (status.status !== 'broken') return { action: 'run' };
  const probationHours = opts.probationHours ?? loadConfig().pool.brokenProbationHours;
  return evaluateBrokenTierProbation(status, probationHours, opts.now);
}

/** Cascade-trail tail for a tier the probation policy skipped. Names when the
 *  tier next gets a shot so the failure string is legible instead of a dead
 *  end. */
export function describeBrokenTierSkip(
  decision: Extract<BrokenTierDecision, { action: 'skip' }>,
): string {
  if (decision.nextProbeAt === null) {
    return 'probation disabled (pool.brokenProbationHours = 0), so it will not re-run on its own';
  }
  return `next probation probe at ${new Date(decision.nextProbeAt).toISOString()}`;
}

/**
 * Stamp the probation clock immediately before a `broken` tier runs as a
 * probe. No-op when the tier has no health record (nothing to probe).
 */
export function markProbeAttempted(
  platform: string,
  capability: string,
  strategyType: string,
): void {
  const k = innerKey(capability, strategyType);
  updatePlatformHealth(platform, (data) => {
    const prev = getStatus(data, k);
    if (!prev) return null;
    data[k] = { ...prev, lastProbeAt: Date.now() };
    return data;
  });
}

/** True when the user has chosen "don't ask again" for this capability's
 *  rediscover gate. Persists across daemon restarts; cleared by
 *  `unsilenceCapability`, `markHealed`, or `resetHealth`. */
export function isSilenced(platform: string, capability: string): boolean {
  const data = loadPlatformHealth(platform);
  return (data._dontAskRediscover ?? []).includes(capability);
}

export function silenceCapability(platform: string, capability: string): void {
  updatePlatformHealth(platform, (data) => {
    const list = data._dontAskRediscover ?? [];
    if (list.includes(capability)) return null;
    data._dontAskRediscover = [...list, capability];
    return data;
  });
}

export function unsilenceCapability(platform: string, capability: string): void {
  updatePlatformHealth(platform, (data) => {
    const list = data._dontAskRediscover ?? [];
    if (!list.includes(capability)) return null;
    data._dontAskRediscover = list.filter((c) => c !== capability);
    return data;
  });
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

/**
 * Most recent successful execute across every saved tier of `capability`,
 * derived from the per-tier `lastSuccess` timestamps in `health.json`. Returns
 * the ISO timestamp + the tier that produced it, or `undefined` when no tier
 * has ever executed cleanly. The logbook flush folds this into
 * `CapabilityLogbookEntry.last_verified_at` so downstream consumers read one
 * "last re-verified on <date>" signal without walking per-tier health.
 */
export function lastVerified(
  platform: string,
  capability: string,
): { at: string; tier: string } | undefined {
  let bestMs = -Infinity;
  let bestTier = '';
  for (const e of listPlatformHealth(platform)) {
    if (e.capability !== capability) continue;
    const ts = e.status.lastSuccess;
    if (ts === undefined || ts <= bestMs) continue;
    bestMs = ts;
    bestTier = e.strategyType;
  }
  if (bestTier === '') return undefined;
  return { at: new Date(bestMs).toISOString(), tier: bestTier };
}

export function markHealed(platform: string, capability: string, strategyType: string): void {
  const k = innerKey(capability, strategyType);
  let healCount = 1;
  updatePlatformHealth(platform, (data) => {
    const prev = getStatus(data, k) || { status: 'healthy' as const, failureCount: 0 };
    healCount = (prev.healCount ?? 0) + 1;
    data[k] = {
      status: 'healthy',
      lastSuccess: Date.now(),
      lastFailure: prev.lastFailure,
      failureCount: 0,
      lastError: prev.lastError,
      recent: pushOutcome(prev, true),
      healCount,
      lastHeal: Date.now(),
      // Same reason markHealthy/markFailed carry these: a heal says nothing
      // about which Node protocol works, so the per-protocol counters survive
      // and only `recordNodeTransportSuccess(protocol)` resets them.
      nodeTransportFailureCounts: prev.nodeTransportFailureCounts,
      lastNodeTransportSignals: prev.lastNodeTransportSignals,
      // The probation clock only means something for a broken tier; a healed
      // one starts clean if it ever breaks again.
      lastProbeAt: undefined,
    };
    return data;
  });
  // Both calls below sit OUTSIDE updatePlatformHealth: appendStrategyEvent
  // takes the logbook lock and unsilenceCapability re-takes the health lock —
  // holding either inside the mutate callback deadlocks.
  //
  // A heal is proof the capability works again, which retires the "don't ask
  // me about rediscovering this" answer the user gave about a strategy that
  // was failing. Leaving it set silences the gate for a future, different rot.
  unsilenceCapability(platform, capability);
  appendStrategyEvent(platform, capability, {
    strategy: strategyType,
    kind: 'healed',
    detail: `healed (count: ${healCount})`,
  });
}

export function resetHealth(platform: string, capability: string, strategyType: string): void {
  const k = innerKey(capability, strategyType);
  updatePlatformHealth(platform, (data) => {
    Reflect.deleteProperty(data, k);
    return data;
  });
  // Outside the health lock (unsilenceCapability takes it again). Clearing the
  // record and leaving the silence flag would keep the rediscover gate muted
  // for a capability with no history at all.
  unsilenceCapability(platform, capability);
}
