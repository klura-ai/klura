import fs from 'fs';
import path from 'path';
import { KLURA_DIR } from '../paths';

const USER_DATA_DIR = path.join(KLURA_DIR, 'user-data');
const SKILLS_DIR = path.join(KLURA_DIR, 'skills');

type TtlStrategy = 'min_observed' | 'p90' | 'fixed';

interface TokenEntry {
  value: string;
  obtainedAt: number;
  ttl: number | null; // effective TTL in seconds, null = unknown
}

interface TokenMeta {
  ttlStrategy: TtlStrategy;
  observations: number[];
  effectiveTtl: number | null;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export class TokenCache {
  private cache = new Map<string, TokenEntry>();
  private meta = new Map<string, TokenMeta>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshCallbacks: Array<(platform: string, tokenName: string) => void> = [];

  private key(platform: string, tokenName: string): string {
    return `${platform}:${tokenName}`;
  }

  /** Store a token with optional known TTL */
  set(
    platform: string,
    tokenName: string,
    value: string,
    opts: { ttl?: number; ttlStrategy?: TtlStrategy } = {},
  ): void {
    const k = this.key(platform, tokenName);

    let effectiveTtl: number | null = opts.ttl ?? null;

    // If no explicit TTL, check if we've learned one
    if (effectiveTtl === null) {
      const m = this.meta.get(k);
      if (m?.effectiveTtl) {
        effectiveTtl = m.effectiveTtl;
      }
    }

    this.cache.set(k, {
      value,
      obtainedAt: Date.now(),
      ttl: effectiveTtl,
    });

    // Set TTL strategy if provided
    if (opts.ttlStrategy) {
      const existing = this.meta.get(k);
      if (existing) {
        existing.ttlStrategy = opts.ttlStrategy;
        if (opts.ttlStrategy === 'fixed' && opts.ttl) {
          existing.effectiveTtl = opts.ttl;
        }
      } else {
        this.meta.set(k, {
          ttlStrategy: opts.ttlStrategy,
          observations: [],
          effectiveTtl: opts.ttl ?? null,
        });
      }
    }

    this.persistTokenValue(platform, tokenName, value);
  }

  /** Get a token, returns null if expired or not found */
  get(platform: string, tokenName: string): string | null {
    const k = this.key(platform, tokenName);
    const entry = this.cache.get(k);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.cache.delete(k);
      return null;
    }

    return entry.value;
  }

  /** Check if a token needs refresh soon (< 10% TTL remaining or < 60s) */
  needsRefresh(platform: string, tokenName: string): boolean {
    const k = this.key(platform, tokenName);
    const entry = this.cache.get(k);
    if (!entry) return true;
    if (!entry.ttl) return false; // unknown TTL — can't predict

    const elapsed = (Date.now() - entry.obtainedAt) / 1000;
    const remaining = entry.ttl - elapsed;
    const threshold = Math.min(entry.ttl * 0.1, 60);

    return remaining < threshold;
  }

  /** Record that a token expired after a certain lifetime (for TTL learning) */
  recordExpiry(platform: string, tokenName: string, observedLifetime: number): void {
    const k = this.key(platform, tokenName);
    let m = this.meta.get(k);

    if (!m) {
      m = { ttlStrategy: 'min_observed', observations: [], effectiveTtl: null };
      this.meta.set(k, m);
    }

    m.observations.push(observedLifetime);

    // Keep last 10 observations
    if (m.observations.length > 10) {
      m.observations = m.observations.slice(-10);
    }

    // Recalculate effective TTL
    m.effectiveTtl = this.calculateTtl(m);

    // Update the cached entry's TTL if it exists
    const entry = this.cache.get(k);
    if (entry) {
      entry.ttl = m.effectiveTtl;
    }

    this.persistMeta(platform, tokenName, m);
  }

  /** Get all tokens for a platform */
  getAllForPlatform(platform: string): Array<{ name: string; needsRefresh: boolean }> {
    const results: Array<{ name: string; needsRefresh: boolean }> = [];
    const prefix = `${platform}:`;

    for (const [k] of this.cache) {
      if (k.startsWith(prefix)) {
        const name = k.slice(prefix.length);
        results.push({ name, needsRefresh: this.needsRefresh(platform, name) });
      }
    }

    return results;
  }

  /** Invalidate a token (e.g. after 401) */
  invalidate(platform: string, tokenName: string): void {
    this.cache.delete(this.key(platform, tokenName));
  }

  /** Load persisted token metadata from disk */
  loadMeta(platform: string, tokenName: string): void {
    const metaPath = path.join(SKILLS_DIR, platform, 'tokens.json');
    try {
      const allMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, TokenMeta>;
      const m = allMeta[tokenName];
      if (m) {
        this.meta.set(this.key(platform, tokenName), m);
      }
    } catch {
      // No meta file yet
    }
  }

  /** Load persisted token value from disk */
  loadValue(platform: string, tokenName: string): void {
    const cachePath = path.join(USER_DATA_DIR, platform, 'token-cache.json');
    try {
      const allValues = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<
        string,
        { value: string; obtainedAt: number; ttl: number | null }
      >;
      const entry = allValues[tokenName];
      if (entry) {
        this.cache.set(this.key(platform, tokenName), entry);
      }
    } catch {
      // No cache file yet
    }
  }

  private isExpired(entry: TokenEntry): boolean {
    if (!entry.ttl) return false; // unknown TTL — assume valid
    const elapsed = (Date.now() - entry.obtainedAt) / 1000;
    return elapsed >= entry.ttl;
  }

  private calculateTtl(m: TokenMeta): number | null {
    if (m.observations.length === 0) return null;

    switch (m.ttlStrategy) {
      case 'fixed':
        return m.effectiveTtl;

      case 'min_observed':
        return Math.min(...m.observations);

      case 'p90': {
        const sorted = [...m.observations].sort((a, b) => a - b);
        const idx = Math.floor(sorted.length * 0.9);
        return sorted[Math.min(idx, sorted.length - 1)] ?? null;
      }
    }
  }

  private persistTokenValue(platform: string, tokenName: string, value: string): void {
    const dir = path.join(USER_DATA_DIR, platform);
    ensureDir(dir);
    const cachePath = path.join(dir, 'token-cache.json');

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Fresh file
    }

    const entry = this.cache.get(this.key(platform, tokenName));
    if (entry) {
      existing[tokenName] = { value, obtainedAt: entry.obtainedAt, ttl: entry.ttl };
    }

    fs.writeFileSync(cachePath, JSON.stringify(existing, null, 2));
  }

  private persistMeta(platform: string, tokenName: string, m: TokenMeta): void {
    const dir = path.join(SKILLS_DIR, platform);
    ensureDir(dir);
    const metaPath = path.join(dir, 'tokens.json');

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Fresh file
    }

    existing[tokenName] = m;
    fs.writeFileSync(metaPath, JSON.stringify(existing, null, 2));
  }

  // --- Proactive refresh loop ---

  /** Register a callback invoked when a token needs refresh */
  onNeedsRefresh(cb: (platform: string, tokenName: string) => void): void {
    this.refreshCallbacks.push(cb);
  }

  /**
   * Start background loop that checks tokens every `intervalMs` (default 30s)
   */
  startRefreshLoop(intervalMs = 30_000): void {
    if (this.refreshTimer) return; // already running
    this.refreshTimer = setInterval(() => {
      this.checkRefresh();
    }, intervalMs);
    // Don't keep process alive just for token refresh
    this.refreshTimer.unref();
  }

  /** Stop the background refresh loop */
  stopRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private checkRefresh(): void {
    for (const [k, entry] of this.cache) {
      if (!entry.ttl) continue;
      const [platform, tokenName] = k.split(':');
      if (!platform || !tokenName) continue;

      if (this.needsRefresh(platform, tokenName)) {
        for (const cb of this.refreshCallbacks) {
          try {
            cb(platform, tokenName);
          } catch {
            /* callback errors are non-fatal */
          }
        }
      }
    }
  }
}
