// Klura daemon config schema: the config tree's TypeScript shape
// (DaemonConfig and its section interfaces), the canonical defaults, and the
// per-leaf field-spec catalog that drives validation, describe_config, and
// the configure-tool input hint. Pure data — no I/O; load/save/update logic
// lives in handler.ts, which re-exports everything here so consumers import
// from one place.

export interface WarmPoolConfig {
  enabled: boolean;
  max_contexts: number;
  idle_ttl_seconds: number;
}

export interface GraduationConfig {
  observation_threshold: number;
}

/** Limits applied to trusted local HTTP(S) execution outside signed packages. */
export interface TrafficConfig {
  request_timeout_ms: number;
  max_concurrency: number;
  requests_per_second: number;
  burst: number;
  min_delay_ms: number;
  transient_failure_threshold: number;
  transient_window_ms: number;
  cooldown_ms: number;
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
  abort_escalation: AbortEscalationConfig;
}

/**
 * Weighting for the `must_escalate` signal start_session computes from the
 * platform's abort ledger. The ledger mixes two kinds of entry — an agent's
 * classification and one the runtime's own detector corroborated — and
 * counting them equally is what let three guesses read as a proven wall.
 * Both knobs are here so the weighting can be swept from config.
 */
export interface AbortEscalationConfig {
  /**
   * Score multiplier for an `agent_asserted` abort event. A runtime-observed
   * entry always weighs 1.0. Default 0.4: three agent claims score 1.2 and do
   * not reach the escalation threshold on their own, while three
   * runtime-observed aborts still escalate at full strength.
   */
  agent_asserted_weight: number;
  /**
   * Hours of age at which an abort event's weight halves. Applied in whole
   * half-lives (`0.5 ** floor(hours / half_life)`), so a fresh entry counts at
   * full strength and the arithmetic stays legible in the advisory.
   */
  half_life_hours: number;
}

export interface TriageConfig {
  /** Per-phase round budget for triage. Default 10 — triage should be tight. */
  max_rounds: number;
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

export interface ConnectConfig {
  /**
   * When true, drive a normally-launched Chrome over CDP instead of letting
   * Playwright launch the browser. A normally-launched Chrome clears managed
   * browser challenges that a
   * Playwright-launched one fails — the distinguishing signal is Playwright's
   * launch profile, not the CDP connection itself. Default false.
   */
  enabled: boolean;
  /**
   * 'spawn' — klura launches a real Chrome with a dedicated persistent profile
   * and attaches over CDP. 'attach' — connect to a Chrome you started yourself
   * with `--remote-debugging-port`. Default 'spawn'.
   */
  mode?: 'spawn' | 'attach';
  /** CDP endpoint for mode 'attach', e.g. "http://localhost:9222". */
  endpoint?: string;
  /** Override the Chrome binary path (mode 'spawn'). Defaults to the platform's
   *  Google Chrome install. */
  chromePath?: string;
  /** Persistent user-data-dir (mode 'spawn'). Defaults to
   *  {KLURA_HOME}/connect-profile. */
  profileDir?: string;
}

export interface PoolConfig {
  idleTimeout: number;
  maxSessions: number;
  headful: boolean;
  channel: 'auto' | 'chrome' | 'chromium';
  driver?: string;
  /** Drive a normally-launched real Chrome over CDP (managed-challenge bypass
   *  via a genuine browser). Off by default; see ConnectConfig. */
  connect?: ConnectConfig;
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
  /**
   * Hours a `broken` strategy tier sits out before `execute` runs it once as
   * a probation probe instead of skipping it. Without a probe a broken tier
   * never appends another outcome, so its record freezes and the tier is
   * quarantined forever — even after the site heals. The probe is lazy (it
   * fires on the next execute that reaches the tier, never on a timer) and
   * the clock is `max(lastFailure, lastProbeAt)`. `0` disables probation:
   * broken tiers stay skipped until a heal, candidate promotion, or
   * `resetHealth`.
   */
  brokenProbationHours: number;
}

export interface RuntimeBootConfig {
  idleTimeout: number;
  listen: string;
}

/**
 * Optional LLM agent settings, consumed only by the CLI agent shim
 * (`klura chat`, `klura execute --agent`) and the CI harnesses — never by the
 * runtime core. Absent by default; the whole block is opt-in. See
 * runtime/ARCHITECTURE.md "The CLI agent".
 */
export interface AgentConfig {
  /** Built-in provider id (`"openai"`, `"claude-code"`), or an npm package
   *  name / filesystem path resolving to a module that exports a `Provider`. */
  provider: string;
  /** Model id. Defaults to the resolved provider's own default when omitted. */
  model?: string;
  /** Base URL for OpenAI-compatible endpoints (NVIDIA, Together, vLLM, ...). */
  base_url?: string;
  /** Agent-loop round budget. Defaults to 40 when omitted. */
  max_rounds?: number;
  /**
   * Provider API key, for OpenAI-compatible providers. May also be supplied
   * via the `KLURA_AGENT_API_KEY` env var (which takes a config-free path —
   * handy for CI). The `claude-code` provider needs no key; it reuses your
   * Claude Code login.
   */
  api_key?: string;
}

export interface DaemonConfig {
  runtime: RuntimeBootConfig;
  graduation: GraduationConfig;
  traffic: TrafficConfig;
  drive: DriveConfig;
  triage: TriageConfig;
  lift: LiftConfig;
  pool: PoolConfig;
  remote: RemoteConfig;
  /** Map of scheme → shell command template. Managed via addSecretResolver /
   *  removeSecretResolver (which validate scheme + shell metachars). The
   *  configure tool treats this as opaque — use the dedicated helpers. */
  secrets?: Record<string, string>;
  /** Optional LLM agent settings — opt-in, absent from CONFIG_DEFAULTS. */
  agent?: AgentConfig;
}

export const CONFIG_DEFAULTS: DaemonConfig = {
  runtime: { idleTimeout: 1800, listen: 'unix' },
  graduation: { observation_threshold: 3 },
  traffic: {
    request_timeout_ms: 30_000,
    max_concurrency: 4,
    requests_per_second: 5,
    burst: 4,
    min_delay_ms: 0,
    transient_failure_threshold: 5,
    transient_window_ms: 60_000,
    cooldown_ms: 60_000,
  },
  drive: {
    max_rounds: 0,
    abort_escalation: { agent_asserted_weight: 0.4, half_life_hours: 12 },
  },
  triage: { max_rounds: 10 },
  lift: { max_rounds: 0 },
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
    brokenProbationHours: 6,
    connect: { enabled: false, mode: 'spawn' },
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
    path: 'traffic.request_timeout_ms',
    type: 'number',
    range: [1_000, 120_000],
    default: CONFIG_DEFAULTS.traffic.request_timeout_ms,
    description:
      'Deadline in milliseconds for one trusted local HTTP(S) request, including response body.',
    needsRestart: false,
  },
  {
    path: 'traffic.max_concurrency',
    type: 'number',
    range: [1, 4],
    default: CONFIG_DEFAULTS.traffic.max_concurrency,
    description: 'Maximum concurrent trusted local HTTP(S) requests to one origin.',
    needsRestart: false,
  },
  {
    path: 'traffic.requests_per_second',
    type: 'number',
    range: [0.1, 5],
    default: CONFIG_DEFAULTS.traffic.requests_per_second,
    description: 'Maximum trusted local HTTP(S) request admissions per second to one origin.',
    needsRestart: false,
  },
  {
    path: 'traffic.burst',
    type: 'number',
    range: [1, 4],
    default: CONFIG_DEFAULTS.traffic.burst,
    description: 'Maximum initial trusted local HTTP(S) request burst to one origin.',
    needsRestart: false,
  },
  {
    path: 'traffic.min_delay_ms',
    type: 'number',
    range: [0, 60_000],
    default: CONFIG_DEFAULTS.traffic.min_delay_ms,
    description:
      'Minimum delay in milliseconds between trusted local HTTP(S) admissions to one origin.',
    needsRestart: false,
  },
  {
    path: 'traffic.transient_failure_threshold',
    type: 'number',
    range: [1, 10],
    default: CONFIG_DEFAULTS.traffic.transient_failure_threshold,
    description:
      'Transient failures at one origin before trusted local HTTP(S) execution opens its circuit.',
    needsRestart: false,
  },
  {
    path: 'traffic.transient_window_ms',
    type: 'number',
    range: [1_000, 300_000],
    default: CONFIG_DEFAULTS.traffic.transient_window_ms,
    description: 'Rolling window in milliseconds for trusted local HTTP(S) transient failures.',
    needsRestart: false,
  },
  {
    path: 'traffic.cooldown_ms',
    type: 'number',
    range: [1_000, 900_000],
    default: CONFIG_DEFAULTS.traffic.cooldown_ms,
    description: 'Circuit-open cooldown in milliseconds for trusted local HTTP(S) execution.',
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
    path: 'drive.abort_escalation.agent_asserted_weight',
    type: 'number',
    range: [0, 1],
    default: CONFIG_DEFAULTS.drive.abort_escalation.agent_asserted_weight,
    description:
      'Weight of an agent-asserted abort event when start_session scores the platform ' +
      "abort ledger for `must_escalate`. An entry the runtime's own origin-blocked " +
      'detector corroborated always weighs 1.0; an agent-supplied classification is a ' +
      'claim, not an observation. Default 0.4 — three agent-asserted aborts score 1.2 ' +
      'and do not escalate; three runtime-observed ones still do. 0 ignores agent claims.',
    needsRestart: false,
  },
  {
    path: 'drive.abort_escalation.half_life_hours',
    type: 'number',
    range: [1, 8_760],
    default: CONFIG_DEFAULTS.drive.abort_escalation.half_life_hours,
    description:
      'Hours of age at which an abort event halves in weight for `must_escalate` ' +
      'scoring, applied in whole half-lives. Default 12 — an abort from earlier today ' +
      'counts fully, yesterday morning at half.',
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
  // Driver + warm-pool fields are captured when the Pool constructs its driver
  // (`Pool._makeDriver` closes over headful/channel/driver/driver_config; the
  // constructor freezes `_warmEnabled/_warmMax/_warmTtlMs`) and the driver
  // instance is cached for the pool's life. A running daemon can't apply a new
  // value, so these need a restart — reporting `needsRestart: false` would tell
  // the agent a change took effect when it silently did not.
  {
    path: 'pool.headful',
    type: 'boolean',
    default: CONFIG_DEFAULTS.pool.headful,
    description: 'Show a visible browser window. Default false (headless).',
    needsRestart: true,
  },
  {
    path: 'pool.channel',
    type: 'enum',
    enum: ['auto', 'chrome', 'chromium'] as const,
    default: CONFIG_DEFAULTS.pool.channel,
    description:
      'Chromium channel. "chrome" = installed Google Chrome (real TLS); "chromium" = Playwright bundled; "auto" tries chrome first.',
    needsRestart: true,
  },
  {
    path: 'pool.driver',
    type: 'string',
    optional: true,
    default: undefined,
    description:
      'Driver. "playwright" (default), "@klura/driver-playwright-stealth", or a BYO path / package name.',
    needsRestart: true,
  },
  {
    path: 'pool.driver_config',
    type: 'object',
    optional: true,
    default: undefined,
    description:
      "Opaque config object passed to the driver constructor as `opts.config`. Shape is the driver's contract — klura validates that this is a JSON object and otherwise leaves it alone. Use for per-driver settings the runtime doesn't know about (API keys, project IDs, vendor-specific stealth toggles).",
    needsRestart: true,
  },
  {
    path: 'pool.warm.enabled',
    type: 'boolean',
    default: CONFIG_DEFAULTS.pool.warm.enabled,
    description: 'Keep browser backends alive across klura sessions (~2-3s warm vs ~10-20s cold).',
    needsRestart: true,
  },
  {
    path: 'pool.warm.max_contexts',
    type: 'number',
    range: [0, 64],
    default: CONFIG_DEFAULTS.pool.warm.max_contexts,
    description: 'Max idle warm backends (LRU-evicted). 0 = unlimited (bounded by TTL only).',
    needsRestart: true,
  },
  {
    path: 'pool.warm.idle_ttl_seconds',
    type: 'number',
    range: [0, 86_400],
    default: CONFIG_DEFAULTS.pool.warm.idle_ttl_seconds,
    description: 'Seconds a warm backend may sit idle before eviction.',
    needsRestart: true,
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
    path: 'pool.connect.enabled',
    type: 'boolean',
    default: CONFIG_DEFAULTS.pool.connect?.enabled ?? false,
    description:
      'Drive a normally-launched real Chrome over CDP instead of ' +
      'Playwright-launching the browser. Clears managed browser challenges ' +
      'that fail an automation-launched ' +
      'browser — the tell is the launch profile, not the CDP connection.',
    needsRestart: true,
  },
  {
    path: 'pool.connect.mode',
    type: 'enum',
    enum: ['spawn', 'attach'] as const,
    default: CONFIG_DEFAULTS.pool.connect?.mode ?? 'spawn',
    description:
      'spawn = klura launches a real Chrome with a dedicated persistent ' +
      'profile; attach = connect to a Chrome you started with ' +
      '--remote-debugging-port.',
    needsRestart: true,
  },
  {
    path: 'pool.connect.endpoint',
    type: 'string',
    optional: true,
    default: undefined,
    description: "CDP endpoint for mode 'attach', e.g. http://localhost:9222.",
    needsRestart: true,
  },
  {
    path: 'pool.connect.chromePath',
    type: 'string',
    optional: true,
    default: undefined,
    description: "Chrome binary path override (mode 'spawn'). Defaults to the platform install.",
    needsRestart: true,
  },
  {
    path: 'pool.connect.profileDir',
    type: 'string',
    optional: true,
    default: undefined,
    description:
      "Persistent user-data-dir (mode 'spawn'). Defaults to {KLURA_HOME}/connect-profile.",
    needsRestart: true,
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
    path: 'pool.brokenProbationHours',
    type: 'number',
    range: [0, 8_760],
    default: CONFIG_DEFAULTS.pool.brokenProbationHours,
    description:
      'Hours a `broken` strategy tier sits out before `execute` runs it once as a ' +
      'probation probe instead of skipping it. The probe re-opens a frozen record: a ' +
      'skipped tier never appends another outcome, so without it a tier that broke ' +
      'during a site outage stays quarantined after the site recovers. Lazy — the probe ' +
      'fires on the next execute that reaches the tier, never on a timer. 0 disables ' +
      'probation (broken tiers stay skipped until a heal or health reset).',
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
  {
    path: 'agent.provider',
    type: 'string',
    optional: true,
    default: undefined,
    description:
      'LLM provider for `klura chat` / `klura execute --agent`. Built-in id ' +
      '("openai", "claude-code") or a BYO npm package name / path exporting a Provider. ' +
      'Never used when klura is driven by an external MCP host.',
    needsRestart: false,
  },
  {
    path: 'agent.model',
    type: 'string',
    optional: true,
    default: undefined,
    description: "Model id for the CLI agent. Defaults to the provider's own default when unset.",
    needsRestart: false,
  },
  {
    path: 'agent.base_url',
    type: 'string',
    optional: true,
    default: undefined,
    description: 'Base URL for OpenAI-compatible endpoints (NVIDIA, Together, vLLM, ...).',
    needsRestart: false,
  },
  {
    path: 'agent.max_rounds',
    type: 'number',
    range: [1, 10_000],
    optional: true,
    default: undefined,
    description: 'Round budget for the CLI agent loop. Defaults to 40 when unset.',
    needsRestart: false,
  },
  {
    path: 'agent.api_key',
    type: 'string',
    optional: true,
    default: undefined,
    description:
      'Provider API key for OpenAI-compatible providers. Or set the ' +
      'KLURA_AGENT_API_KEY env var. The claude-code provider needs no key.',
    needsRestart: false,
  },
];
