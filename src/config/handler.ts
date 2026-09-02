// Single source of truth for klura daemon config: schema, defaults, load, save
// (atomic), validate, describe, dot-path update. Every other module that needs
// config reads through `loadConfig()` here; secrets + remote are folded into
// DaemonConfig so they live in one file, one tree.

import fs from 'fs';
import path from 'path';
import { getKluraHome } from '../paths';
import { describeEnum, ValidationError } from '../validators';
import { resolveDriverClass } from '../pool/pool';
import { isStandaloneDaemon } from '../runtime-state/process-role';
import { withOwnerFileLock, writeTextAtomically } from '../utils/owner-file-lock';

export {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  type AbortEscalationConfig,
  type AgentConfig,
  type AuditConfig,
  type ConfigFieldSpec,
  type ConnectConfig,
  type DaemonConfig,
  type DriveConfig,
  type GraduationConfig,
  type HealConfig,
  type LiftConfig,
  type PoolConfig,
  type RemoteConfig,
  type RuntimeBootConfig,
  type TrafficConfig,
  type TriageConfig,
  type WarmPoolConfig,
} from './schema';
import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  type ConfigFieldSpec,
  type DaemonConfig,
  type PoolConfig,
} from './schema';
const CONFIG_PATH_REL = 'config.json';
const OWNER_ONLY_FILE_MODE = 0o600;

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
    traffic: { ...CONFIG_DEFAULTS.traffic, ...(src.traffic ?? {}) },
    drive: {
      ...CONFIG_DEFAULTS.drive,
      ...(src.drive ?? {}),
      abort_escalation: {
        ...CONFIG_DEFAULTS.drive.abort_escalation,
        ...(src.drive?.abort_escalation ?? {}),
      },
    },
    triage: { ...CONFIG_DEFAULTS.triage, ...(src.triage ?? {}) },
    lift: { ...CONFIG_DEFAULTS.lift, ...(src.lift ?? {}) },
    pool: {
      ...CONFIG_DEFAULTS.pool,
      ...loadedPool,
      warm: { ...CONFIG_DEFAULTS.pool.warm, ...(loadedPool.warm ?? {}) },
      heal: { ...CONFIG_DEFAULTS.pool.heal, ...(loadedPool.heal ?? {}) },
      connect: {
        enabled: false,
        ...(CONFIG_DEFAULTS.pool.connect ?? {}),
        ...(loadedPool.connect ?? {}),
      },
    },
    remote: { ...CONFIG_DEFAULTS.remote, ...(src.remote ?? {}) },
    audit: { ...CONFIG_DEFAULTS.audit, ...(src.audit ?? {}) },
    ...(src.secrets ? { secrets: { ...src.secrets } } : {}),
    ...(src.agent ? { agent: { ...src.agent } } : {}),
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

/** Atomic write: random-suffix tmp + rename, owner-only mode. */
export function saveConfig(cfg: DaemonConfig): void {
  const { ok, errors } = validateConfig(cfg);
  if (!ok) {
    throw new ValidationError('config', `rejected:\n${errors.join('\n')}`);
  }
  writeTextAtomically(configPath(), JSON.stringify(cfg, null, 2), {
    mode: OWNER_ONLY_FILE_MODE,
  });
}

/**
 * Serialize a load→mutate→save cycle over config.json against concurrent
 * writers (another CLI invocation, the daemon's configure tool). The write
 * inside stays `saveConfig` so validation always runs.
 */
function withConfigLock<Value>(operation: () => Value): Value {
  return withOwnerFileLock(`${configPath()}.lock`, operation);
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

  // The driver must be loadable before we persist it. Boot no longer crashes on
  // an unloadable driver, but every session would still fail — reject at write
  // time so a typo (e.g. "playwright-stealth" instead of the installed
  // "klura-driver-playwright-stealth") never lands in config.json. If you're
  // adding a BYO driver, install the package first, then set this.
  if (dotPath === 'pool.driver' && typeof coerced === 'string' && coerced) {
    try {
      resolveDriverClass(coerced);
    } catch (cause) {
      throw new ValidationError(
        'value',
        `driver "${coerced}" can't be loaded: ${String(cause)}. ` +
          `Use "playwright" (built-in), a BYO package name you've installed ` +
          `(e.g. "klura-driver-playwright-stealth"), or an absolute path.`,
      );
    }
  }

  const next = withConfigLock(() => {
    const current = loadConfig();
    // loadConfig shares nested refs with CONFIG_DEFAULTS via spread; round-trip
    // through JSON before mutating so we never write back into the defaults
    // literal.
    const updated = JSON.parse(JSON.stringify(current)) as DaemonConfig;
    setAtPath(updated as unknown as Record<string, unknown>, dotPath.split('.'), coerced);
    saveConfig(updated);
    return updated;
  });
  const restartFields = spec.needsRestart ? [dotPath] : [];
  return {
    config: next,
    changed: [dotPath],
    runtime_restart_required: spec.needsRestart,
    runtime_restart_fields: restartFields,
    suggested_user_prompt: restartPrompt(dotPath, spec.needsRestart),
  };
}

// Boot-time fields only take effect on a fresh runtime. When klura runs as a
// standalone daemon, `restart_runtime` can do that in-place — so ask. When it's
// embedded (klura chat / execute --agent / an MCP host), the process is shared
// with the caller's session and can't self-restart; `restart_runtime` refuses.
// Telling the agent to offer a restart there sends it into a dead-end loop
// (offer → user says yes → restart_runtime refuses), so instead tell the truth:
// the change is saved but inert until the host process is relaunched by hand.
function restartPrompt(dotPath: string, needsRestart: boolean): string {
  if (!needsRestart) return '';
  if (isStandaloneDaemon()) {
    return (
      `I updated ${dotPath} — that's a boot-time setting, so the runtime needs to restart ` +
      `before it takes effect. Want me to restart it now? (Any open sessions will be closed.)`
    );
  }
  return (
    `I updated ${dotPath} and saved it to config, but it's a boot-time setting and this runtime ` +
    `is embedded in the current process — it can't restart itself, so the change won't take effect ` +
    `until you exit and relaunch klura yourself. (Don't ask me to run restart_runtime; it will refuse.)`
  );
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
  withConfigLock(() => {
    const current = loadConfig();
    const next = JSON.parse(JSON.stringify(current)) as DaemonConfig;
    next.secrets = mutator(next.secrets ?? {});
    if (Object.keys(next.secrets).length === 0) delete next.secrets;
    saveConfig(next);
  });
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
