// In-memory cache + refresh scheduler for js-eval prereqs.
//
// A js-eval prereq can opt into background refresh via `refresh.enabled`. When
// enabled, the pool schedules a timer to re-run the expression on
// `interval_seconds ± jitter_seconds` and stashes the latest minted value.
// Execute reads from the cache first so warm calls skip the per-request round
// trip through `page.evaluate`.
//
// Key design rules: 1. Cache + timers are per-platform. A pool entry-eviction
// (LRU, TTL, shutdown) cancels every timer for that platform so we never tick
// refreshes against a dead session. 2. We don't persist to disk. The whole
// point is "amortize cost while warm is alive" — once warm goes away, there's
// no context to run the expression against, so a stale token on disk would be
// worse than nothing. 3. Refresh failures never crash the pool. A failed mint
// leaves the previous cached value alone; execute falls back to a sync mint on
// the next call if the cache has gone stale.

import { randomInt } from 'crypto';

interface JsEvalCacheEntry {
  value: string;
  expiresAt: number | null;
  mintedAt: number;
}

interface ScheduleOpts {
  platform: string;
  bindsTo: string;
  intervalMs: number;
  jitterMs: number;
  refresh: () => Promise<string>;
}

interface TimerEntry {
  handle: ReturnType<typeof setTimeout>;
  opts: ScheduleOpts;
}

/**
 * Shared cache + scheduler implementation. {@link Pool} exposes an instance of
 * this class via its `jsEvalCache` field — the execution layer reads/writes
 * through the {@link JsEvalCache} structural interface in `execution.ts` and
 * never touches a pool-specific type.
 */
export class JsEvalCacheImpl {
  // platform -> bindsTo -> entry
  private _cache = new Map<string, Map<string, JsEvalCacheEntry>>();
  // platform -> bindsTo -> timer
  private _timers = new Map<string, Map<string, TimerEntry>>();

  get(platform: string, bindsTo: string): JsEvalCacheEntry | null {
    const platMap = this._cache.get(platform);
    if (!platMap) return null;
    return platMap.get(bindsTo) ?? null;
  }

  set(platform: string, bindsTo: string, value: string, expiresAt: number | null): void {
    let platMap = this._cache.get(platform);
    if (!platMap) {
      platMap = new Map<string, JsEvalCacheEntry>();
      this._cache.set(platform, platMap);
    }
    platMap.set(bindsTo, { value, expiresAt, mintedAt: Date.now() });
  }

  /**
   * Schedule a background refresh for this prereq. If a schedule is already
   * registered under the same `{platform, bindsTo}` key, this is a no-op — the
   * existing timer keeps running. That keeps the pool's timer count flat even
   * when execute() is called in a hot loop.
   */
  schedule(opts: ScheduleOpts): void {
    const existing = this._timers.get(opts.platform)?.get(opts.bindsTo);
    if (existing) return;
    const delayMs = this._jitteredDelay(opts.intervalMs, opts.jitterMs);
    const handle = setTimeout(() => {
      void this._tick(opts);
    }, delayMs);
    (handle as unknown as { unref?: () => void }).unref?.();
    let platTimers = this._timers.get(opts.platform);
    if (!platTimers) {
      platTimers = new Map<string, TimerEntry>();
      this._timers.set(opts.platform, platTimers);
    }
    platTimers.set(opts.bindsTo, { handle, opts });
  }

  /**
   * Cancel refreshes for a platform. With no `bindsTo`, every timer for the
   * platform is cancelled and the platform's cache is dropped — this is the
   * eviction path. With a specific `bindsTo`, only that one is cancelled +
   * removed.
   */
  cancel(platform: string, bindsTo?: string): void {
    if (bindsTo === undefined) {
      const platTimers = this._timers.get(platform);
      if (platTimers) {
        for (const entry of platTimers.values()) {
          clearTimeout(entry.handle);
        }
        this._timers.delete(platform);
      }
      this._cache.delete(platform);
      return;
    }
    const platTimers = this._timers.get(platform);
    if (platTimers) {
      const entry = platTimers.get(bindsTo);
      if (entry) {
        clearTimeout(entry.handle);
        platTimers.delete(bindsTo);
      }
      if (platTimers.size === 0) this._timers.delete(platform);
    }
    const platCache = this._cache.get(platform);
    if (platCache) {
      platCache.delete(bindsTo);
      if (platCache.size === 0) this._cache.delete(platform);
    }
  }

  /** Cancel every registered refresh. Called from pool.shutdown(). */
  shutdown(): void {
    for (const platTimers of this._timers.values()) {
      for (const entry of platTimers.values()) {
        clearTimeout(entry.handle);
      }
    }
    this._timers.clear();
    this._cache.clear();
  }

  private async _tick(opts: ScheduleOpts): Promise<void> {
    let nextValue: string | null = null;
    try {
      nextValue = await opts.refresh();
    } catch (err) {
      console.warn(
        `[js-eval-cache] refresh for platform=${opts.platform} bindsTo=${opts.bindsTo} failed: ${
          err instanceof Error ? err.message : String(err)
        }. Keeping previous cached value; execute will re-mint synchronously if needed.`,
      );
    }

    if (nextValue !== null) {
      const expiresAt = opts.intervalMs > 0 ? Date.now() + opts.intervalMs : null;
      this.set(opts.platform, opts.bindsTo, nextValue, expiresAt);
    }

    // Re-arm only if the schedule is still active (the platform hasn't been
    // evicted while we were running). A cancel() while the tick was in flight
    // removes the entry from _timers, and we respect that.
    const stillActive = this._timers.get(opts.platform)?.get(opts.bindsTo);
    if (!stillActive) return;
    const delayMs = this._jitteredDelay(opts.intervalMs, opts.jitterMs);
    const handle = setTimeout(() => {
      void this._tick(opts);
    }, delayMs);
    (handle as unknown as { unref?: () => void }).unref?.();
    stillActive.handle = handle;
  }

  private _jitteredDelay(intervalMs: number, jitterMs: number): number {
    if (jitterMs <= 0) return intervalMs;
    const span = Math.max(1, Math.floor(jitterMs));
    const offset = randomInt(-span, span + 1);
    return Math.max(1, intervalMs + offset);
  }
}
