// Pool construction surface: the driver registry (built-in short names +
// BYO require() resolution) and the `createPool` factory that reads
// `~/.klura/config.json`. The `Pool` class itself lives in ./pool; this
// module owns everything that turns a config or driver name into a
// constructed pool.

import type { BrowserDriver } from '../drivers/interface';
import type { BrowserPool } from '../drivers/types/session';
import { loadConfig, type ConnectConfig } from '../config/handler';
import { Pool } from './pool';

export interface PoolOptions {
  idleTimeout?: number; // seconds, default 300
  /** Driver name or path. Overrides `config.pool.driver`. */
  driver?: string;
  /** Launch a visible browser window. Overrides `config.pool.headful`. */
  headful?: boolean;
  /** Chromium channel preference. Overrides `config.pool.channel`. */
  channel?: 'auto' | 'chrome' | 'chromium';
  /** Opaque per-driver config — passed verbatim as `opts.config` to the
   *  driver constructor. Shape is the driver's contract. */
  driverConfig?: Record<string, unknown>;
  /** Connect-mode settings. Overrides `config.pool.connect`. */
  connect?: ConnectConfig;
  /**
   * Warm-pool settings. When `enabled`, `endDrive` detaches the underlying
   * browser resources as a `BrowserLease` into a per-platform idle slot
   * instead of tearing them down; the next `createSession` for the same
   * platform mints a fresh Session, binds the lease onto it, and resets via
   * `driver.resetSession` — cutting warm execute from ~10-20s to ~1-2s.
   */
  warm?: {
    enabled?: boolean;
    maxContexts?: number;
    idleTtlSeconds?: number;
  };
}

export interface DriverConstructorOptions {
  headful?: boolean;
  channel?: 'auto' | 'chrome' | 'chromium';
  config?: Record<string, unknown>;
  connect?: ConnectConfig;
}

export type DriverCtor = new (opts?: DriverConstructorOptions) => BrowserDriver;

// Built-in driver names. `pool.driver` picks one of these short names, or
// alternatively passes an absolute path / bare npm package name to require()
// for BYO (e.g. `@klura/driver-playwright-stealth`). Each entry is lazy so only
// the driver we actually use gets loaded.
const BUILTIN_DRIVERS: Record<string, () => DriverCtor> = {
  playwright: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../drivers/playwright') as { PlaywrightDriver: DriverCtor };
    return mod.PlaywrightDriver;
  },
};

/**
 * Resolve a driver name or path to a constructor:
 * - The `'playwright'` short name loads the bundled class via lazy require.
 * - Anything else goes through `require()` as a BYO driver — absolute path,
 *   relative path from cwd, or a bare npm module name. Accepts either a default
 *   or named export.
 *
 * Returns null for undefined input so callers can chain `??` fallbacks.
 */
export function resolveDriverClass(nameOrPath: string | undefined): DriverCtor | null {
  if (!nameOrPath) return null;
  const builtin = BUILTIN_DRIVERS[nameOrPath];
  if (builtin) return builtin();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(nameOrPath) as { default?: DriverCtor } | DriverCtor;
  const resolved = (mod as { default?: DriverCtor }).default ?? (mod as DriverCtor);
  if (typeof resolved !== 'function') {
    throw new Error(
      `pool.driver "${nameOrPath}" did not export a BrowserDriver constructor ` +
        `(expected default export or named class extending BrowserDriver)`,
    );
  }
  return resolved;
}

/**
 * Create a Pool by reading `~/.klura/config.json` directly. Returns a
 * `BrowserPool` implementation; callers should depend on the interface, not
 * the concrete class.
 *
 * `opts` override the corresponding config fields for programmatic callers
 * (tests, benchmarks, embedded use) that want to bypass config.json without
 * having to write it first.
 */
export function createPool(opts: PoolOptions = {}): BrowserPool {
  const config = loadConfig();
  return new Pool(undefined, {
    idleTimeout: opts.idleTimeout ?? config.pool.idleTimeout,
    driver: opts.driver ?? config.pool.driver,
    headful: opts.headful ?? config.pool.headful,
    channel: opts.channel ?? config.pool.channel,
    driverConfig: opts.driverConfig ?? config.pool.driver_config,
    connect: opts.connect ?? config.pool.connect,
    warm: {
      enabled: config.pool.warm.enabled,
      maxContexts: config.pool.warm.max_contexts,
      idleTtlSeconds: config.pool.warm.idle_ttl_seconds,
    },
  });
}
