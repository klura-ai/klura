import { pool } from './runtime-state';
import * as skills from './strategies/skills';
import * as health from './strategies/health';
import { readStrategyEvents } from './working-dir/logbook';
import { resolveSecret } from './identity/secrets';

export { getHealth } from './strategies/health';
export type { HealthStatus } from './strategies/health';

export function resetHealth(platform: string, capability: string, strategyType: string): void {
  skills.unarchiveStrategy(platform, capability, strategyType);
  health.resetHealth(platform, capability, strategyType);
}

export function patchStep(
  platform: string,
  capability: string,
  strategyType: string,
  stepId: string,
  patch: Record<string, unknown>,
): { ok: true; path: string } | { error: string } {
  return skills.patchStep(platform, capability, strategyType, stepId, patch);
}

export function markHealed(platform: string, capability: string, strategyType: string): void {
  health.markHealed(platform, capability, strategyType);
}

export function getStrategyEvents(
  platform: string,
  capability?: string,
  limit?: number,
): import('./working-dir/logbook').StrategyEventRecord[] {
  return readStrategyEvents(platform, capability, limit);
}

const _pool = pool;
export { _pool };

// Generic content block for LLM messages. Harnesses convert these to the wire
// format their LLM expects (Claude, OpenAI, etc.).
export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ImageBlock {
  type: 'image';
  data: string;
  mediaType: string;
}
export type ContentBlock = TextBlock | ImageBlock;

/**
 * Pull `_session_obligation` off a result object and return both the
 * standalone block (so the model reads it as a top-level directive
 * rather than buried in the JSON-stringified payload) and the cleaned
 * rest. Object-only — strings don't carry obligations. The obligation
 * sub-field is mcp-attached at `mcp/index.js`.
 */
function extractObligation(result: unknown): { block: TextBlock | null; rest: unknown } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { block: null, rest: result };
  }
  const obj = result as Record<string, unknown>;
  const obligation = obj._session_obligation as { message?: string } | undefined;
  if (!obligation || typeof obligation.message !== 'string') {
    return { block: null, rest: result };
  }
  const rest = { ...obj };
  delete rest._session_obligation;
  return {
    block: { type: 'text', text: `[klura obligation]: ${obligation.message}` },
    rest,
  };
}

/**
 * Pull `_render_verbatim_block` off a result object and return it as a
 * standalone text block before the JSON payload. Used by tools that
 * emit content the agent must surface to the user without modification —
 * specifically `start_remote_session`'s viewer URL, which carries an
 * HMAC-signed JWT that breaks on any retype/edit/abbreviation.
 *
 * Field shape: `{ preface?: string, content: string }`. The preface
 * names the verbatim contract; the content is the literal text the
 * agent must paste.
 */
function extractRenderVerbatim(result: unknown): { block: TextBlock | null; rest: unknown } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { block: null, rest: result };
  }
  const obj = result as Record<string, unknown>;
  const blockSpec = obj._render_verbatim_block as
    | { preface?: string; content?: string }
    | undefined;
  if (!blockSpec || typeof blockSpec.content !== 'string') {
    return { block: null, rest: result };
  }
  const rest = { ...obj };
  delete rest._render_verbatim_block;
  const preface =
    blockSpec.preface ??
    'Render the following to the user verbatim — do not retype, edit, summarize, or omit any part:';
  return {
    block: { type: 'text', text: `${preface}\n\n${blockSpec.content}` },
    rest,
  };
}

/**
 * Convert a raw tool result into LLM-ready content blocks. Screenshots become
 * image blocks so vision-capable models can actually see them.
 *
 * When the result carries `_session_obligation` (mcp-attached when a
 * mutating session has not yet saved or end_drive'd), that message
 * is hoisted into a leading `[klura obligation]: <message>` text block
 * and stripped from the JSON-stringified rest. Surfacing it as a
 * top-level directive ahead of the tool's payload prevents it from
 * being skimmed past inside a long JSON blob.
 */
export function formatToolResult(toolName: string, result: unknown): ContentBlock[] {
  // get_screenshot returning a raw string carries no obligation — strings
  // can't hold sub-fields. Handle first and short-circuit.
  if (toolName === 'get_screenshot' && typeof result === 'string' && result.length > 100) {
    return [
      { type: 'text', text: '[Screenshot from get_screenshot]:' },
      { type: 'image', data: result, mediaType: 'image/png' },
    ];
  }

  const { block: obligationBlock, rest: afterObligation } = extractObligation(result);
  const { block: renderBlock, rest } = extractRenderVerbatim(afterObligation);
  const prefix: ContentBlock[] = [
    ...(obligationBlock ? [obligationBlock] : []),
    ...(renderBlock ? [renderBlock] : []),
  ];

  // Tool result with embedded screenshot
  if (rest && typeof rest === 'object' && 'screenshot' in (rest as Record<string, unknown>)) {
    const obj = rest as Record<string, unknown>;
    const screenshot = obj.screenshot as string;
    const restNoScreenshot = { ...obj };
    delete restNoScreenshot.screenshot;
    return [
      ...prefix,
      { type: 'text', text: `[Tool result for ${toolName}]:\n${JSON.stringify(restNoScreenshot)}` },
      { type: 'image', data: screenshot, mediaType: 'image/png' },
    ];
  }

  // Everything else → plain text
  const str = typeof rest === 'string' ? rest : JSON.stringify(rest);
  return [...prefix, { type: 'text', text: `[Tool result for ${toolName}]:\n${str}` }];
}

export type { ExecuteResult } from './execution/types';
export type { Strategy, SkillInfo, ParamDoc } from './strategies/skills';
export type { ListenerEvent } from './listeners';
export type { StrategyEventRecord } from './working-dir/logbook';
export { SCHEMA_VERSION } from './strategies/skills';

// Driver base class and default implementation — exported so custom drivers can
// extend PlaywrightDriver instead of reimplementing all 25+ abstract methods.
export { BrowserDriver } from './drivers/interface';
export type { Capability } from './drivers/interface';
export type { SessionOptions, Session } from './drivers/types/session';
export { PlaywrightDriver } from './drivers/playwright';
export type { PlaywrightDriverOptions } from './drivers/playwright';

// Device profile (single profile per daemon)
export {
  getDeviceProfile,
  setDeviceProfile,
  resetDeviceProfile,
  startDeviceProbe,
  DEVICE_PRESETS,
} from './identity/devices';
export type { DeviceProfile } from './identity/devices';

// Platform policy
export {
  loadPolicy,
  savePolicy,
  clearPolicy,
  getEffectivePolicy,
  isTierAllowed,
  isCapabilityForbidden,
  setCapabilityPolicy,
} from './strategies/policy';
export type { PlatformPolicy, StrategyTier } from './strategies/policy';

// Identities
export {
  getIdentity,
  setIdentity,
  setIdentityFields,
  listIdentities,
  clearIdentity,
} from './identity/identities';

// Secret resolvers
export { listSecretResolvers, addSecretResolver, removeSecretResolver } from './identity/secrets';

/**
 * Fetch a secret from a configured resolver. Used by the agent during discovery
 * to fill login forms without asking the user for a password in chat or opening
 * a remote viewer. The resolved value is returned verbatim — callers must never
 * log, persist, or echo it. Pass it directly to the next
 * `perform_action({action:'type', ...})`.
 *
 * `scheme` selects which shell-command resolver to run (keychain, 1password
 * CLI, pass, etc.) and `ref` is the per-scheme key. Errors bubble up: unknown
 * scheme → setup hint; resolver command failure → redacted error with no
 * ref/output leakage. Both are recoverable by falling back to the remote
 * viewer.
 */
export function getSecret(scheme: string, ref: string): { value: string } {
  return { value: resolveSecret(scheme, ref) };
}
