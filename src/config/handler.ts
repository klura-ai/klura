// Single source of truth for klura daemon config: schema, defaults, load, save
// (atomic), validate, describe, dot-path update. Every other module that needs
// config reads through `loadConfig()` here; secrets + remote are folded into
// DaemonConfig so they live in one file, one tree.

import fs from 'fs';
import path from 'path';
import { getKluraHome } from '../paths';
import { describeEnum, ValidationError } from '../validators';

export interface WarmPoolConfig {
  enabled: boolean;
  max_contexts: number;
  idle_ttl_seconds: number;
}

export interface GraduationConfig {
  observation_threshold: number;
}

export interface LiftConfig {
  /** Per-phase round budget. 0 = unlimited (default). When >0, the
   *  middleware soft-blocks tools outside `allowedToolsWhenExhausted` once
   *  the counter crosses this. */
  max_rounds: number;
}

export interface DriveConfig {
  /** Per-phase round budget for drive (UI-driving). 0 = unlimited (default). */
  max_rounds: number;
}

export interface TriageConfig {
  /** Per-phase round budget for triage. Default 10 — triage should be tight. */
  max_rounds: number;
}

export interface SessionDefaultsConfig {
  lift_mode: 'explicit_learn' | 'skip';
}

export interface RemoteConfig {
  mode: 'auto' | 'direct' | 'cloudflared' | 'local';
  publicUrl?: string;
  timeout?: number;
  prompt?: string;
  /**
   * Auto-open the viewer URL in the user's default browser at session
   * start. Bypasses the LLM-relay channel — the URL goes from the runtime
   * to the OS's URL-handler directly, so single-char corruption can't
   * happen in transit. `'on_local'` (default) opens only when the URL is
   * reachable from the runtime host (`exposure === 'local'`); a public
   * tunnel viewer is meant for a different device and shouldn't trigger
   * a popup on the runtime's machine. `'always'` opens regardless;
   * `'never'` disables.
   */
  auto_open: 'always' | 'on_local' | 'never';
  /**
   * Mint a short single-use redirect URL alongside the long JWT URL and
   * surface the short one to the agent. The short URL (16-char base32
   * ≈ 80 bits entropy, 60s TTL, single-use) survives LLM relay where
   * the 250-400-char JWT does not. The full JWT URL is still served
   * directly for callers who already hold it.
   */
  short_url: boolean;
}

export interface HealConfig {
  /** Auto-heal recorded-path step failures via structural a11y rescan (same
   *  role with tolerant name match, then role-only with uniqueness) before
   *  emitting the `recorded_step_failed` checkpoint to the agent. Default
   *  true. */
  structural: boolean;
}

export interface PoolConfig {
  idleTimeout: number;
  maxSessions: number;
  headful: boolean;
  channel: 'auto' | 'chrome' | 'chromium';
  driver?: string;
  /**
   * Opaque per-driver config passed verbatim to the driver constructor as
   * `opts.config`. The runtime treats this as a black box; drivers that care
   * declare and validate their own shape (e.g. a remote-CDP driver reads
   * `{ apiKey, region, project }`). Built-in PlaywrightDriver ignores it.
   */
  driver_config?: Record<string, unknown>;
  warm: WarmPoolConfig;
  heal: HealConfig;
  /**
   * Rolling success-rate threshold below which `execute` raises the
   * rediscover ack-gate. Only fires when the saved strategy has accumulated
   * at least MIN_SAMPLES_FOR_RATE outcomes (see strategies/health.ts), so
   * fresh strategies are never gated. 0 disables the gate. Range [0, 1].
   */
  rediscoverThreshold: number;
}

export interface RuntimeBootConfig {
  idleTimeout: number;
  listen: string;
}

export interface DaemonConfig {
  runtime: RuntimeBootConfig;
  graduation: GraduationConfig;
  drive: DriveConfig;
  triage: TriageConfig;
  lift: LiftConfig;
  defaults: SessionDefaultsConfig;
  pool: PoolConfig;
  remote: RemoteConfig;
  /** Map of scheme → shell command template. Managed via addSecretResolver /
   *  removeSecretResolver (which validate scheme + shell metachars). The
   *  configure tool treats this as opaque — use the dedicated helpers. */
  secrets?: Record<string, string>;
}

export const CONFIG_DEFAULTS: DaemonConfig = {
  runtime: { idleTimeout: 1800, listen: 'unix' },
  graduation: { observation_threshold: 3 },
  drive: { max_rounds: 0 },
  triage: { max_rounds: 10 },
  lift: { max_rounds: 0 },
  defaults: { lift_mode: 'explicit_learn' },
  pool: {
    idleTimeout: 300,
    maxSessions: 8,
    headful: false,
    channel: 'auto',
    warm: {
      enabled: false,
      max_contexts: 3,
      idle_ttl_seconds: 600,
    },
    heal: {
      structural: true,
    },
    rediscoverThreshold: 0.7,
  },
  remote: { mode: 'auto', timeout: 600, auto_open: 'on_local', short_url: true },
};

/** Describes one leaf config field. Drives validation, describe_config,
 * and the configure-tool input hint. Add a new entry here when you add a
 *  new config field — nowhere else. */
export interface ConfigFieldSpec {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object';
  enum?: readonly string[];
  range?: [number, number];
  optional?: boolean;
  default: unknown;
  description: string;
  needsRestart: boolean;
}

// runtime.* fields are read once at boot and need a restart_runtime call to
// take effect; everything else reloads per-session via loadConfig() call sites
// (pool/pool.ts, index.ts, strategies/strategy-graduation.ts).
export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  {
    path: 'runtime.idleTimeout',
    type: 'number',
    range: [0, 86_400],
    default: CONFIG_DEFAULTS.runtime.idleTimeout,
    description:
      'Seconds the runtime stays alive with no active sessions before self-exit. 0 disables.',
    needsRestart: true,
  },
  {
    path: 'runtime.listen',
    type: 'string',
    default: CONFIG_DEFAULTS.runtime.listen,
    description: '"unix" (default) → ~/.klura/klura.sock; "host:port" → TCP.',
    needsRestart: true,
  },
  {
    path: 'graduation.observation_threshold',
    type: 'number',
    range: [2, 50],
    default: CONFIG_DEFAULTS.graduation.observation_threshold,
    description:
      'Consecutive recorded-path runs with the same POST shape before synthesizing a fetch strategy.',
    needsRestart: false,
  },
  {
    path: 'drive.max_rounds',
    type: 'number',
    range: [0, 10_000],
    default: CONFIG_DEFAULTS.drive.max_rounds,
    description:
      'Round budget for the drive phase (agent driving the UI to the goal). ' +
      '0 = unlimited (default). When >0, tools outside the drive exhausted-set are hard-blocked once the counter crosses this.',
    needsRestart: false,
  },
  {
    path: 'triage.max_rounds',
    type: 'number',
    range: [0, 10_000],
    default: CONFIG_DEFAULTS.triage.max_rounds,
    description:
      'Round budget for the triage phase (agent reads captures and writes a plan). ' +
      'Default 10 — triage should be tight. 0 = unlimited.',
    needsRestart: false,
  },
  {
    path: 'lift.max_rounds',
    type: 'number',
    range: [0, 10_000],
    default: CONFIG_DEFAULTS.lift.max_rounds,
    description:
      'Round budget for the lift phase (agent executes the RE playbook). ' +
      '0 = unlimited (default). When >0, tools outside the lift exhausted-set are hard-blocked once the counter crosses this.',
    needsRestart: false,
  },
  {
    path: 'defaults.lift_mode',
    type: 'enum',
    enum: ['explicit_learn', 'skip'] as const,
    default: CONFIG_DEFAULTS.defaults.lift_mode,
    description:
      'Fallback lift_mode when start_session does not supply one. ' +
      '"explicit_learn" (default) asks the user before spending rounds on a lift; ' +
      '"skip" disables the RE handoff entirely.',
    needsRestart: false,
  },
  {
    path: 'pool.idleTimeout',
    type: 'number',
    range: [0, 86_400],
    default: CONFIG_DEFAULTS.pool.idleTimeout,
    description: 'Seconds a session may sit idle before the pool tears it down.',
    needsRestart: false,
  },
  {
    path: 'pool.maxSessions',
    type: 'number',
    range: [1, 128],
    default: CONFIG_DEFAULTS.pool.maxSessions,
    description: 'Maximum concurrent browser sessions the pool will hold.',
    needsRestart: false,
  },
  {
    path: 'pool.headful',
    type: 'boolean',
    default: CONFIG_DEFAULTS.pool.headful,
    description: 'Show a visible browser window. Default false (headless).',
    needsRestart: false,
  },
  {
    path: 'pool.channel',
    type: 'enum',
    enum: ['auto', 'chrome', 'chromium'] as const,
    default: CONFIG_DEFAULTS.pool.channel,
    description:
      'Chromium channel. "chrome" = installed Google Chrome (real TLS); "chromium" = Playwright bundled; "auto" tries chrome first.',
    needsRestart: false,
  },
  {
    path: 'pool.driver',
    type: 'string',
    optional: true,
    default: undefined,
    description:
      'Driver. "playwright" (default), "@klura/driver-playwright-stealth", or a BYO path / package name.',
    needsRestart: false,
  },
  {
    path: 'pool.driver_config',
    type: 'object',
    optional: true,
    default: undefined,
    description:
      "Opaque config object passed to the driver constructor as `opts.config`. Shape is the driver's contract — klura validates that this is a JSON object and otherwise leaves it alone. Use for per-driver settings the runtime doesn't know about (API keys, project IDs, vendor-specific stealth toggles).",
    needsRestart: false,
  },
  {
    path: 'pool.warm.enabled',
    type: 'boolean',
    default: CONFIG_DEFAULTS.pool.warm.enabled,
    description: 'Keep browser backends alive across klura sessions (~2-3s warm vs ~10-20s cold).',
    needsRestart: false,
  },
  {
    path: 'pool.warm.max_contexts',
    type: 'number',
    range: [0, 64],
    default: CONFIG_DEFAULTS.pool.warm.max_contexts,
    description: 'Max idle warm backends (LRU-evicted). 0 = unlimited (bounded by TTL only).',
    needsRestart: false,
  },
  {
    path: 'pool.warm.idle_ttl_seconds',
    type: 'number',
    range: [0, 86_400],
    default: CONFIG_DEFAULTS.pool.warm.idle_ttl_seconds,
    description: 'Seconds a warm backend may sit idle before eviction.',
    needsRestart: false,
  },
  {
    path: 'pool.heal.structural',
    type: 'boolean',
    default: CONFIG_DEFAULTS.pool.heal.structural,
    description:
      'Auto-heal recorded-path step failures via structural a11y rescan ' +
      '(same role + tolerant name match, then role-only with uniqueness) ' +
      'before emitting recorded_step_failed checkpoint. Disable to force ' +
      'agent-driven patch_step on every drift.',
    needsRestart: false,
  },
  {
    path: 'pool.rediscoverThreshold',
    type: 'number',
    range: [0, 1],
    default: CONFIG_DEFAULTS.pool.rediscoverThreshold,
    description:
      'Rolling success-rate floor for the rediscover ack-gate. When a saved ' +
      'strategy has accumulated at least 5 outcomes and its rate over the last ' +
      '20 calls drops below this, `execute` raises the gate so the user can ' +
      'choose to rediscover, proceed anyway, or silence permanently. 0 disables.',
    needsRestart: false,
  },
  {
    path: 'remote.mode',
    type: 'enum',
    enum: ['auto', 'direct', 'cloudflared', 'local'] as const,
    default: CONFIG_DEFAULTS.remote.mode,
    description:
      'How the viewer URL is exposed. "auto" tries cloudflared then falls back to localhost.',
    needsRestart: false,
  },
  {
    path: 'remote.publicUrl',
    type: 'string',
    optional: true,
    default: undefined,
    description: 'Externally-reachable host for remote.mode = "direct" (e.g. a reverse proxy).',
    needsRestart: false,
  },
  {
    path: 'remote.timeout',
    type: 'number',
    range: [10, 86_400],
    optional: true,
    default: CONFIG_DEFAULTS.remote.timeout,
    description: 'Seconds a remote viewer session may stay open.',
    needsRestart: false,
  },
  {
    path: 'remote.prompt',
    type: 'string',
    optional: true,
    default: undefined,
    description: 'Default prompt shown above the viewer.',
    needsRestart: false,
  },
  {
    path: 'remote.auto_open',
    type: 'enum',
    enum: ['always', 'on_local', 'never'] as const,
    default: CONFIG_DEFAULTS.remote.auto_open,
    description:
      "Auto-open the viewer URL in the user's default browser. " +
      '"on_local" (default) opens only when the URL is reachable from the runtime host (skips public-tunnel URLs meant for a different device). ' +
      '"always" opens regardless; "never" disables. Bypasses the LLM-relay channel where long JWT URLs are prone to single-char corruption.',
    needsRestart: false,
  },
  {
    path: 'remote.short_url',
    type: 'boolean',
    default: CONFIG_DEFAULTS.remote.short_url,
    description:
      'Surface a short single-use redirect URL to the agent instead of the full JWT URL. ' +
      'Short URLs (16-char base32, 60s TTL, single-use) survive LLM relay where the 250-400-char JWT does not.',
    needsRestart: false,
  },
];

const CONFIG_PATH_REL = 'config.json';

function configPath(): string {
  return path.join(getKluraHome(), CONFIG_PATH_REL);
}

// Deep-merge loaded JSON onto defaults. Every branch is spelled out rather than
// done via a generic recursive merge so the type system catches missing /
// renamed fields when the schema changes.
function mergeWithDefaults(loaded: unknown): DaemonConfig {
  const src = (loaded ?? {}) as Partial<DaemonConfig>;
  const loadedPool = (src.pool ?? {}) as Partial<PoolConfig>;
  return {
    runtime: { ...CONFIG_DEFAULTS.runtime, ...(src.runtime ?? {}) },
    graduation: { ...CONFIG_DEFAULTS.graduation, ...(src.graduation ?? {}) },
    drive: { ...CONFIG_DEFAULTS.drive, ...(src.drive ?? {}) },
    triage: { ...CONFIG_DEFAULTS.triage, ...(src.triage ?? {}) },
    lift: { ...CONFIG_DEFAULTS.lift, ...(src.lift ?? {}) },
    defaults: { ...CONFIG_DEFAULTS.defaults, ...(src.defaults ?? {}) },
    pool: {
      ...CONFIG_DEFAULTS.pool,
      ...loadedPool,
      warm: { ...CONFIG_DEFAULTS.pool.warm, ...(loadedPool.warm ?? {}) },
      heal: { ...CONFIG_DEFAULTS.pool.heal, ...(loadedPool.heal ?? {}) },
    },
    remote: { ...CONFIG_DEFAULTS.remote, ...(src.remote ?? {}) },
    ...(src.secrets ? { secrets: { ...src.secrets } } : {}),
  };
}

export function loadConfig(): DaemonConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return mergeWithDefaults(JSON.parse(raw));
  } catch {
    return mergeWithDefaults(undefined);
  }
}

/** Atomic write: tmp + rename. Mirrors working-dir/logbook.ts. */
export function saveConfig(cfg: DaemonConfig): void {
  const { ok, errors } = validateConfig(cfg);
  if (!ok) {
    throw new ValidationError('config', `rejected:\n${errors.join('\n')}`);
  }
  fs.mkdirSync(getKluraHome(), { recursive: true });
  const p = configPath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, p);
}

function getAtPath(obj: unknown, parts: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setAtPath(obj: Record<string, unknown>, parts: readonly string[], value: unknown): void {
  if (parts.length === 0) return;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) return;
    const next = cur[key];
    if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const leaf = parts.at(-1);
  if (leaf === undefined) return;
  cur[leaf] = value;
}

/** Validate a coerced value against a field spec. Returns null on success or
 *  a human-readable error message on failure. */
function validateLeaf(spec: ConfigFieldSpec, value: unknown): string | null {
  if (value === undefined || value === null) {
    if (spec.optional) return null;
    return `${spec.path} is required`;
  }
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return `${spec.path} must be a boolean (got ${typeof value})`;
      return null;
    case 'string':
      if (typeof value !== 'string') return `${spec.path} must be a string (got ${typeof value})`;
      if (value.length === 0 && !spec.optional) return `${spec.path} must be a non-empty string`;
      if (value.length > 10_000) return `${spec.path} exceeds 10000 chars`;
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `${spec.path} must be a finite number (got ${typeof value})`;
      if (spec.range) {
        const [lo, hi] = spec.range;
        if (value < lo || value > hi)
          return `${spec.path} must be in [${lo}, ${hi}] (got ${value})`;
      }
      return null;
    case 'enum':
      if (typeof value !== 'string' || !spec.enum?.includes(value))
        return `${spec.path} must be ${describeEnum(spec.enum ?? [])} (got ${JSON.stringify(value)})`;
      return null;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value))
        return `${spec.path} must be a JSON object (got ${Array.isArray(value) ? 'array' : typeof value})`;
      return null;
  }
}

export function validateConfig(cfg: unknown): { ok: boolean; errors: string[] } {
  if (cfg === null || cfg === undefined || typeof cfg !== 'object') {
    return { ok: false, errors: ['config must be an object'] };
  }
  const errors: string[] = [];
  for (const spec of CONFIG_FIELDS) {
    const value = getAtPath(cfg, spec.path.split('.'));
    const err = validateLeaf(spec, value);
    if (err) errors.push(err);
  }
  // Secrets map: values must be non-empty strings if present. Deep validation
  // (scheme regex, shell-metachar guard) lives in identity/secrets.ts and fires
  // when callers go through addSecretResolver.
  const secrets = (cfg as { secrets?: unknown }).secrets;
  if (secrets !== undefined) {
    if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) {
      errors.push('secrets must be an object of scheme → command');
    } else {
      for (const [k, v] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof v !== 'string' || v.length === 0) {
          errors.push(`secrets.${k} must be a non-empty string`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function findSpec(p: string): ConfigFieldSpec | undefined {
  return CONFIG_FIELDS.find((s) => s.path === p);
}

/** Set a single leaf by dot-path. Looks up the spec, coerces JSON-string
 * inputs where sensible ("true" → true, "3" → 3 for numeric fields), and
 * validates. Returns the new merged config + a `needsRestart` flag for the
 *  field that changed. Throws ValidationError on bad path or bad value. */
export interface ConfigureResult {
  config: DaemonConfig;
  changed: string[];
  runtime_restart_required: boolean;
  runtime_restart_fields: string[];
  /** Fire-this-at-the-user prompt when a restart is needed, empty otherwise. */
  suggested_user_prompt: string;
}

export function configureOne(dotPath: string, value: unknown): ConfigureResult {
  // Secret resolvers live under the dynamic `secrets.<scheme>` path. They get
  // their own code path because a secret "scheme" is a map key (not a fixed
  // config field), and the value (a shell command template) needs the scheme
  // regex + shell-metachar guards that addSecretResolver applies. Passing
  // value=null/undefined removes the entry.
  if (dotPath.startsWith('secrets.')) {
    return configureSecret(dotPath, value);
  }
  const spec = findSpec(dotPath);
  if (!spec) {
    throw new ValidationError(
      'path',
      `= ${JSON.stringify(dotPath)} is not a known config field. Call describe_config for the list.`,
    );
  }
  const coerced = coerceValue(spec, value);
  const err = validateLeaf(spec, coerced);
  if (err) throw new ValidationError('value', err);

  const current = loadConfig();
  // loadConfig shares nested refs with CONFIG_DEFAULTS via spread; round-trip
  // through JSON before mutating so we never write back into the defaults
  // literal.
  const next = JSON.parse(JSON.stringify(current)) as DaemonConfig;
  setAtPath(next as unknown as Record<string, unknown>, dotPath.split('.'), coerced);
  saveConfig(next);
  const restartFields = spec.needsRestart ? [dotPath] : [];
  return {
    config: next,
    changed: [dotPath],
    runtime_restart_required: spec.needsRestart,
    runtime_restart_fields: restartFields,
    suggested_user_prompt: spec.needsRestart
      ? `I updated ${dotPath} — that's a boot-time setting, so the runtime needs to restart before it takes effect. Want me to restart it now? (Any open sessions will be closed.)`
      : '',
  };
}

function coerceValue(spec: ConfigFieldSpec, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (spec.type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if (spec.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/** Agent-facing schema description. */
export interface ConfigSchemaDescription {
  fields: Array<{
    path: string;
    type: string;
    enum?: readonly string[];
    range?: [number, number];
    optional: boolean;
    default: unknown;
    description: string;
    needsRestart: boolean;
  }>;
  current: DaemonConfig;
  /** Paths where the suffix is user-supplied rather than a fixed field name.
   *  The agent writes values from its own knowledge — no template library. */
  dynamic_paths: Record<string, string>;
}

export function describeConfig(): ConfigSchemaDescription {
  return {
    fields: CONFIG_FIELDS.map((s) => ({
      path: s.path,
      type: s.type,
      enum: s.enum,
      range: s.range,
      optional: !!s.optional,
      default: s.default,
      description: s.description,
      needsRestart: s.needsRestart,
    })),
    current: loadConfig(),
    dynamic_paths: {
      'secrets.<scheme>':
        'Shell command template for a password-manager resolver. Scheme is a name you pick (e.g. "op", "bw", "keychain"). Value is the command with "{{ref}}" as the per-secret placeholder. Pass value=null (or empty string) to remove. If the user gives you the exact command line, pass it through verbatim — do not rewrite or "fix" it. Otherwise craft it from your own knowledge of the manager\'s CLI; no template list is shipped. Example: configure({path: "secrets.op", value: "op read \\"op://Personal/{{ref}}/password\\""}).',
    },
  };
}

/** Write the full config back — used by secrets helpers that mutate the
 *  secrets map and need to persist alongside other fields. */
export function updateSecrets(
  mutator: (secrets: Record<string, string>) => Record<string, string>,
): void {
  const current = loadConfig();
  const next = JSON.parse(JSON.stringify(current)) as DaemonConfig;
  next.secrets = mutator(next.secrets ?? {});
  if (Object.keys(next.secrets).length === 0) delete next.secrets;
  saveConfig(next);
}

function configureSecret(dotPath: string, value: unknown): ConfigureResult {
  const scheme = dotPath.slice('secrets.'.length);
  // Lazy require avoids a circular module load: identity/secrets.ts imports
  // from this handler, so we can't import it at the top.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const secretsMod = require('../identity/secrets') as {
    addSecretResolver: (scheme: string, command: string) => void;
    removeSecretResolver: (scheme: string) => void;
  };
  if (value === null || value === undefined || value === '') {
    secretsMod.removeSecretResolver(scheme);
  } else {
    if (typeof value !== 'string') {
      throw new ValidationError('value', 'secret resolver command must be a string');
    }
    secretsMod.addSecretResolver(scheme, value);
  }
  return {
    config: loadConfig(),
    changed: [dotPath],
    runtime_restart_required: false,
    runtime_restart_fields: [],
    suggested_user_prompt: '',
  };
}
