import * as skills from '../strategies/skills';
import type { BrowserDriver } from '../drivers/interface';
import type { Session, SessionOptions } from '../drivers/types/session';
import type {
  AnyPool,
  FetchStrategy,
  PageScriptStrategy,
  Prerequisite,
  RecordedPathStrategy,
  ExecuteResult,
  WebSocketStrategy,
} from './types';
import { TokenCache } from '../strategies/tokens';
import {
  markHealthy,
  markFailed,
  shouldSkipBrokenTier,
  describeBrokenTierSkip,
  markProbeAttempted,
  getHealth,
  recordNodeTransportSuccess,
} from '../strategies/health';
import { getDeviceProfile } from '../identity/devices';
import { isTierAllowed, isCapabilityForbidden, loadCapabilityPolicy } from '../strategies/policy';
import { isLoginWallUrl } from '../response/auth-wall';
import type { StrategyNotes } from '../strategies/skills';
import { evaluatePredicate as registryEvaluatePredicate } from '../strategies/predicate-registry';
import { dispatchWebSocket } from './websocket';
import { mergeWithIdentity, resolveBody } from './vars';
export { joinBaseAndPath } from './vars';
import {
  TransportFailureError,
  recordNodeTransportFailure,
  executeFetchNode as executeFetchNodeRaw,
} from './fetch-node';
import { executeFetchInBrowser } from './fetch-browser';
export { runPrerequisites, executeFetchInBrowser } from './fetch-browser';
import { executeRecordedPath, replayRecordedPathToAnchor } from './recorded-path';
export { resumeRecordedPath } from './recorded-path';
import { defaultCapabilityCache, getCachedOrExecute, parseTtl } from '../cache/capability-cache';
import {
  classifyFactoryExecutionResult,
  describeFactoryExecutionFailure,
  FactoryExecutionStateError,
  factoryExecutionWasAccepted,
} from './result-classification';
import { assessDeclaredCollectionEmptiness } from './collection-emptiness';
import { createPostSaveVerificationProof } from '../strategies/post-save-verification-proof';

// False positives are harmless — the DOMParser walker handles non-HTML input by
// emitting an empty tree.
export function looksLikeHtml(s: string): boolean {
  const head = s.slice(0, 1024).trimStart();
  if (/^<!doctype\s+html/i.test(head)) return true;
  if (/^<html[\s>]/i.test(head)) return true;
  if (/^<(body|head|main|nav|header|footer|article|section|div)[\s>]/i.test(head)) return true;
  return false;
}

function isWebSocketStrategy(s: skills.Strategy): s is skills.Strategy & WebSocketStrategy {
  return (s as { protocol?: unknown }).protocol === 'websocket';
}

// Status-only check. 404/410/405 are unambiguous "endpoint retired" signals.
// 400 used to fall through a body-text keyword bank (`invalid|missing|...`)
// which misclassified internationalized error prose; the narrowed form
// defers ambiguous 400s to the auth path / generic failure (reauth is
// cheap, re-discovery isn't).
export function looksLikeStaleEndpoint(result: ExecuteResult): boolean {
  return result.status === 404 || result.status === 410 || result.status === 405;
}

// Canonical machine-readable auth-failure codes used across REST + GraphQL
// APIs. Exact-match (case-insensitive) against `error`, `code`, `type`, or
// `extensions.code` fields — these are well-defined enum constants, not
// human prose. Matching against `message` (free text) is intentionally
// dropped: it misclassified internationalized error strings and forced a
// keyword-regex bank, exactly the anti-pattern principles.md §"Crisp vs
// fuzzy" forbids.
const AUTH_FAILURE_CODES = new Set([
  'unauthorized',
  'unauthenticated',
  'forbidden',
  'authentication',
  'authenticationerror',
  'not_authorized',
  'not_authenticated',
  'auth_required',
  'authentication_required',
  'authentication_failed',
  'login_required',
  'session_expired',
  'token_expired',
  'token_invalid',
  'invalid_token',
  'missing_token',
  'permission_denied',
]);

function isAuthCodeField(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return AUTH_FAILURE_CODES.has(normalized);
}

// Per-call token-rotation codes: the saved token-bearing field (nonce / csrf)
// rotated server-side but the ACCOUNT session is intact. Distinct from
// AUTH_FAILURE_CODES — these are agent-recoverable (re-derive the token), not
// human-reauth. Exact-match (case-insensitive), same crisp-not-fuzzy discipline
// as isAuthCodeField — never matched against free-text `message`.
const STALE_NONCE_CODES = new Set([
  'stale_nonce',
  'nonce_expired',
  'nonce_invalid',
  'invalid_nonce',
  'nonce_mismatch',
  'csrf_invalid',
  'invalid_csrf',
  'csrf_token_mismatch',
  'xsrf_invalid',
]);

function isStaleNonceCodeField(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return STALE_NONCE_CODES.has(normalized);
}

// True when the response body's machine-readable code field names a token
// rotation (vs a genuine auth failure). REST {error|code} + GraphQL
// {errors:[{type,extensions:{code}}]} shapes, mirroring looksLikeAuthFailure.
function bodyHasStaleNonceCode(result: ExecuteResult): boolean {
  const body = result.body;
  if (!body || typeof body !== 'object') return false;
  const bodyObj = body as Record<string, unknown>;
  if (isStaleNonceCodeField(bodyObj.error)) return true;
  if (isStaleNonceCodeField(bodyObj.code)) return true;
  if (Array.isArray(bodyObj.errors)) {
    for (const raw of bodyObj.errors) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (isStaleNonceCodeField(entry.type)) return true;
      if (entry.extensions && typeof entry.extensions === 'object') {
        const ext = entry.extensions as Record<string, unknown>;
        if (isStaleNonceCodeField(ext.code)) return true;
      }
    }
  }
  return false;
}

// Deliberately generous on inputs (status, login-wall URL, machine-readable
// code fields) — reauth is cheap, re-discovery is not. Handles REST
// {error|code} and GraphQL {errors:[{type,extensions:{code}}]} shapes.
export function looksLikeAuthFailure(result: ExecuteResult, finalUrl: string): boolean {
  if (result.status === 401) return true;
  if (result.status === 403) return true;
  if (finalUrl && isLoginWallUrl(finalUrl)) {
    return true;
  }

  const body = result.body;
  if (!body || typeof body !== 'object') return false;
  const bodyObj = body as Record<string, unknown>;

  if (isAuthCodeField(bodyObj.error)) return true;
  if (isAuthCodeField(bodyObj.code)) return true;

  if (Array.isArray(bodyObj.errors)) {
    for (const raw of bodyObj.errors) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (isAuthCodeField(entry.type)) return true;
      if (entry.extensions && typeof entry.extensions === 'object') {
        const ext = entry.extensions as Record<string, unknown>;
        if (isAuthCodeField(ext.code)) return true;
      }
    }
  }

  return false;
}

// The daemon has exactly one device profile; every session inherits it. No
// per-call selection, no fallback chain — device.json is the source of truth.
export function currentDeviceSessionOpts(): { opts: SessionOptions; device: string } {
  const profile = getDeviceProfile();
  const opts: SessionOptions = { viewport: profile.viewport };
  if (profile.userAgent) opts.userAgent = profile.userAgent;
  if (profile.hasTouch) opts.hasTouch = true;
  if (profile.isMobile) opts.isMobile = true;
  return { opts, device: profile.name ?? 'default' };
}

// 5 is deeper than any realistic chain (typical 1-2, worst case 3: send_message
// → lookup_thread_by_name → auth_token).
export const MAX_PREREQ_DEPTH = 5;

/**
 * Lookup the cache TTL declared on the target capability's saved strategies.
 * Mirrors the helper in `runtime/src/tools/execute.ts` so both surfaces
 * resolve the same TTL for a `(platform, capability)` tuple. Returns 0
 * when no saved strategy declares a hint, which short-circuits the cache
 * pipeline. See klura://reference#capability-cache.
 */
function resolveCapabilityCacheTtlMs(platform: string, capability: string): number {
  const saved = skills.loadStrategies(platform, capability);
  for (const s of saved) {
    const ttl = (s as { cache?: { ttl?: unknown } }).cache?.ttl;
    if (typeof ttl === 'string' && ttl.length > 0) {
      try {
        return parseTtl(ttl);
      } catch {
        return 0;
      }
    }
  }
  return 0;
}

export async function resolveCapabilityPrereq(
  prereq: Prerequisite,
  callerPlatform: string,
  callerArgs: Record<string, unknown>,
  callerTokens: Record<string, unknown>,
  pool: AnyPool | null,
  tokenCache: TokenCache | null,
  depth: number,
  parentIdentity?: string,
  omittedOptionalParams: ReadonlySet<string> = new Set(),
  suppressStrategyState = false,
): Promise<Record<string, unknown> | null> {
  const targetPlatform =
    typeof prereq.platform === 'string' && prereq.platform.length > 0
      ? prereq.platform
      : callerPlatform;
  let targetCap: string;
  if (prereq.kind === 'tag') {
    const tag = prereq.tag;
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new Error(
        `prereq "${prereq.name}": kind:"tag" requires a "tag" field (save-time validation should have caught this)`,
      );
    }
    const providers = skills.findCapabilitiesProviding(targetPlatform, tag);
    if (providers.length === 0) {
      throw new Error(
        `prereq "${prereq.name}" (kind:"tag", tag="${tag}", platform=${targetPlatform}): ` +
          `no saved capability on this platform declares \`provides: ["${tag}"]\`. ` +
          `Either save such a capability, or change this prereq to ` +
          `\`{kind: "capability", capability: "<slug>"}\` pointing at the specific capability you want.`,
      );
    }
    if (providers.length > 1) {
      const list = providers.map((s) => `"${s}"`).join(', ');
      throw new Error(
        `prereq "${prereq.name}" (kind:"tag", tag="${tag}", platform=${targetPlatform}): ` +
          `multiple saved capabilities advertise this tag — ${list}. ` +
          `The runtime won't pick one arbitrarily. Disambiguate by changing this prereq to ` +
          `\`{kind: "capability", capability: "<slug>"}\` naming the specific capability the caller depends on.`,
      );
    }
    const [first] = providers;
    if (!first) {
      // Unreachable: handled by the length === 0 throw above. Belt-and-braces
      // for the type narrower so we don't ship a non-null assertion.
      throw new Error('unreachable: tag prereq resolution returned empty after length check');
    }
    targetCap = first;
  } else {
    const cap = prereq.capability;
    if (typeof cap !== 'string') {
      throw new Error(
        `prereq "${prereq.name}": kind:"capability" requires a "capability" field (save-time validation should have caught this)`,
      );
    }
    targetCap = cap;
  }
  const rawVars = prereq.vars;
  // `vars` is optional on capability prereqs. Omitted / null / empty object →
  // side-effect-only: run the sub-execute for its shared BrowserContext
  // effects (e.g. a login capability leaving an auth cookie on the warm
  // slot) and discard the return value. Each entry in a non-empty vars map
  // pairs {<name>: "<dot.path>"} — the agent-facing bind name + a dotted
  // accessor into the sub-execute's response body.
  const varsMap: Record<string, string> =
    rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)
      ? (rawVars as Record<string, string>)
      : {};
  const sideEffectOnly = Object.keys(varsMap).length === 0;
  const nullBindings = (): Record<string, null> =>
    Object.fromEntries(Object.keys(varsMap).map((name) => [name, null]));

  // Caller args take priority over tokens on name collision.
  const substitutionScope: Record<string, unknown> = {
    ...callerTokens,
    ...callerArgs,
  };
  const subArgs = interpolateCapabilityArgs(
    prereq.args ?? {},
    substitutionScope,
    omittedOptionalParams,
  );

  // Capability cache for prereq calls — the `search_contact → thread_id`
  // pattern. When the target capability's saved strategy declares
  // `cache: {ttl: ...}`, memoize the prereq result so the next caller
  // (typical pattern: another `send_message` with the same recipient)
  // skips the lookup entirely. Errors are never cached. The sub-execute
  // inherits the caller's identity so cookies/profile match the calling
  // context. Same singleton as tools/execute.ts so a direct
  // `execute("acme", "search_contact", ...)` shares the cache with the
  // prereq call.
  // Runtime-owned verification must observe the prerequisite itself and must
  // not replace a caller-visible cached value with grading traffic.
  const ttlMs = suppressStrategyState ? 0 : resolveCapabilityCacheTtlMs(targetPlatform, targetCap);
  const subResult = await getCachedOrExecute(
    defaultCapabilityCache,
    targetPlatform,
    parentIdentity,
    targetCap,
    subArgs,
    ttlMs,
    () =>
      execute(targetPlatform, targetCap, subArgs, pool, tokenCache, {
        _depth: depth + 1,
        identity: parentIdentity,
        _suppressStrategyState: suppressStrategyState,
      }),
  );

  const subResultClassification = classifyFactoryExecutionResult(subResult);
  if (subResultClassification === 'not_run') {
    if (prereq.optional) {
      return sideEffectOnly ? null : nullBindings();
    }
    throw new FactoryExecutionStateError(
      'not_run',
      'capability_prerequisite_not_run',
      `prerequisite ${JSON.stringify(prereq.name)} returned not_run; parent request not sent`,
      {
        prerequisite: prereq.name,
        target_platform: targetPlatform,
        target_capability: targetCap,
        prerequisite_result: subResult.body,
      },
    );
  }
  if (subResultClassification === 'delivery_unknown') {
    throw new FactoryExecutionStateError(
      'sent_unconfirmed',
      'capability_prerequisite_delivery_unknown',
      `prerequisite ${JSON.stringify(prereq.name)} returned delivery_unknown; parent request not sent`,
      {
        prerequisite: prereq.name,
        target_platform: targetPlatform,
        target_capability: targetCap,
        prerequisite_result: subResult.body,
      },
    );
  }
  if (
    typeof subResult.status !== 'number' ||
    subResult.status < 200 ||
    subResult.status >= 300 ||
    subResultClassification === 'explicit_failure'
  ) {
    if (prereq.optional) {
      if (sideEffectOnly) return null;
      return nullBindings();
    }
    const bodyPreview =
      typeof subResult.body === 'string'
        ? subResult.body.slice(0, 200)
        : JSON.stringify(subResult.body ?? {}).slice(0, 200);
    throw new Error(
      `prereq "${prereq.name}" (kind:"capability", target=${targetPlatform}/${targetCap}) ` +
        `failed with status ${subResult.status}. Response body: ${bodyPreview}. ` +
        `Diagnose the target capability's warm execute directly, then retry this caller.`,
    );
  }

  // Side-effect-only — the sub-execute's shared-context effects (cookies,
  // auth state on the warm BrowserContext) are what the caller depends on.
  // Drop the return value; no token to bind.
  if (sideEffectOnly) return null;

  const bound: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(varsMap)) {
    if (path.length === 0) {
      bound[name] = subResult.body;
      continue;
    }
    const extracted = walkJsonPath(subResult.body, path);
    // A non-optional prereq var that resolves to undefined means the dot-path is
    // wrong (or the field is absent this run). Binding it would stringify to ''
    // and silently fire the request with an empty value — e.g. a recipient id
    // dropping to `/conversations//messages`, delivering to the wrong target.
    // Fail loud and name the available keys so the path gets fixed.
    if (extracted === undefined && !prereq.optional) {
      const keys =
        subResult.body && typeof subResult.body === 'object'
          ? Object.keys(subResult.body as Record<string, unknown>).slice(0, 12)
          : [];
      const bodyPreview = JSON.stringify(subResult.body ?? {}).slice(0, 200);
      throw new Error(
        `prereq "${prereq.name}" (kind:"capability", target=${targetPlatform}/${targetCap}): ` +
          `var "${name}" path "${path}" resolved to undefined against the prereq response — the ` +
          `request would fire with an empty value and silently hit the wrong endpoint. ` +
          `Top-level response keys: [${keys.join(', ')}]. Body: ${bodyPreview}. ` +
          `Fix the dot-path (array indices accept results.0.id or results[0].id).`,
      );
    }
    if (extracted === undefined) {
      bound[name] = null;
      continue;
    }
    bound[name] = extracted;
  }
  return bound;
}

// Null/undefined → empty; objects → JSON; scalars → String(). Centralized so
// the LLM never sees an "[object Object]" leak from interpolating a structured
// prereq result.
export function stringifyScope(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

// Substitute {{placeholder}} tokens in every string value of rawArgs against
// scope. Non-string values pass through.
function interpolateCapabilityArgs(
  rawArgs: Record<string, unknown>,
  scope: Record<string, unknown>,
  omittedOptionalParams: ReadonlySet<string>,
): Record<string, unknown> {
  return resolveBody(rawArgs, scope, omittedOptionalParams);
}

export function walkJsonPath(root: unknown, path: string): unknown {
  if (typeof path !== 'string' || path.length === 0) return root;
  // Accept numeric bracket indexing (`results[0].id`) in addition to pure dot
  // segments (`results.0.id`) — the same idiomatic JS accessor syntax that
  // fetch-extract's `extractByPath` already supports. Normalizing here keeps
  // capability-prereq `vars` paths consistent with fetch-extract paths so the
  // LLM's natural `[0]` doesn't silently resolve to undefined.
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    const asArr = cur as unknown[];
    const asObj = cur as Record<string, unknown>;
    // Integer index on array OR string key on object
    const asInt = /^\d+$/.test(seg) ? Number(seg) : null;
    if (Array.isArray(cur) && asInt !== null) {
      cur = asArr[asInt];
    } else {
      cur = asObj[seg];
    }
  }
  return cur;
}

interface ExecuteOpts {
  // Recursion depth for capability prereqs. Not set by external callers.
  _depth?: number;
  /**
   * Account name on the platform. Default-when-omitted is the platform-only
   * historical path. Threaded into every per-tier executor (fetch, page-
   * script, recorded-path) so the right cookie jar + identity profile load
   * for the warm session. See klura://reference#identities.
   */
  identity?: string;
  /**
   * Session id of the start_session caller, when execute is invoked as part
   * of an auto-execute path. The recorded-path executor cold-spawns its own
   * inner session for replay; when the inner session pauses on a
   * `recorded_step_failed` checkpoint, the executor registers an
   * outer→inner alias so `resume_execution(outerId)` and
   * `ack_checkpoint(outerId)` resolve to the inner-keyed registry entries
   * without forcing the agent to read `session_id` out of the failure
   * envelope. See `runtime/src/execution/auto-execute-alias.ts` and
   * `runtime/docs/run-lifecycle.md#auto-execute-session-topology`.
   */
  ownerSessionId?: string;
  /**
   * Internal flag — set by the auth-wall lazy-retry path to prevent infinite
   * loops if the auth prereq itself returns 2xx but the cookies it sets
   * still don't authenticate the sibling call. One retry max per top-level
   * execute(); the second auth-wall hit returns `needs_reauth: true` to the
   * LLM as before. Not set by external callers.
   */
  _authRetryAttempted?: boolean;
  /**
   * Exact strategy set for runtime-owned verification. Ordinary callers load
   * the active tier cascade from disk. Candidate verification supplies one
   * validated inactive strategy so a working sibling cannot mask it.
   */
  _strategyOverride?: skills.Strategy[];
  /**
   * Candidate verification exercises transport without changing active
   * health, archive, node-transport, or partial-replay state.
   */
  _suppressStrategyState?: boolean;
  /**
   * Fire the Node transport without the persisted cookie jar, and without
   * writing Set-Cookie back into it.
   *
   * `withFreshVerificationPool` strips persisted storage so cookies left by
   * discovery are not implicit inputs to a verification run. That stripping
   * reaches the browser context; the Node fire path reads the jar straight off
   * disk, so without this flag a strategy that only works because discovery
   * warmed the jar verifies clean and then fails for every consumer that does
   * not share it. A capability that genuinely needs a session declares a prereq
   * that establishes one inside the run.
   */
  _suppressPersistedCookies?: boolean;
}

function notRunResult(body: Record<string, unknown>): ExecuteResult {
  return { status: 0, executionState: 'not_run', body };
}

function policyTierCapResult(platform: string, capability: string): ExecuteResult {
  // Surface the policy reason so the agent sees WHY the tier is capped, not
  // just the mechanical rejection.
  const prior = loadCapabilityPolicy(platform, capability);
  const policyReason = prior?.reason ? ` (reason: "${prior.reason}")` : '';
  return notRunResult({
    error: 'policy_violation',
    message: `all strategies for ${platform}/${capability} are above the allowed tier (${prior?.max_strategy_tier ?? 'unknown'})`,
    policy_max_tier: prior?.max_strategy_tier ?? null,
    policy_reason: prior?.reason ?? null,
    retry_hint:
      `The capability is capped at "${prior?.max_strategy_tier ?? '(unknown)'}" by USER POLICY${policyReason}. ` +
      `Policy is user-owned (ToS / compliance / operator rule) and the agent has no write path to modify it. ` +
      `To change this cap, the user must edit ~/.klura/skills/${platform}/policy.json directly or run \`klura policy clear ${platform} ${capability}\`.`,
  });
}

// Tier cascade, auth recovery, health, and isolated candidate execution share
// one ordered state machine so each transport result is classified once.
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function execute(
  platform: string,
  capability: string,
  args: Record<string, unknown> = {},
  pool: AnyPool | null = null,
  tokenCache: TokenCache | null = null,
  opts: ExecuteOpts = {},
): Promise<ExecuteResult> {
  const depth = opts._depth ?? 0;
  // Bind the caller's identity so capability prereqs (sub-executes) inherit
  // it without threading identity through every per-tier executor. The
  // wrapper also forwards each strategy's optional-parameter omission policy.
  const boundResolveCapabilityPrereq = (
    prereq: Prerequisite,
    callerPlatform: string,
    callerArgs: Record<string, unknown>,
    callerTokens: Record<string, unknown>,
    p: AnyPool | null,
    tc: TokenCache | null,
    d: number,
    omittedOptionalParams?: ReadonlySet<string>,
  ): Promise<Record<string, unknown> | null> =>
    resolveCapabilityPrereq(
      prereq,
      callerPlatform,
      callerArgs,
      callerTokens,
      p,
      tc,
      d,
      opts.identity,
      omittedOptionalParams,
      opts._suppressStrategyState,
    );
  if (depth > MAX_PREREQ_DEPTH) {
    return notRunResult({
      error: 'capability_prereq_depth_exceeded',
      message:
        `capability prereq chain exceeds max depth ${MAX_PREREQ_DEPTH} at ${platform}/${capability}. ` +
        `Likely a cycle in your saved strategies' {kind: "capability"} prereqs. ` +
        `Trace each capability prereq back to its target and check whether any target transitively references the root.`,
      depth,
    });
  }
  const startedAt = Date.now();

  const mergedArgs = mergeWithIdentity(args, platform, opts.identity);

  if (isCapabilityForbidden(platform, capability)) {
    return notRunResult({
      error: 'policy_violation',
      message: `capability "${capability}" is forbidden for platform "${platform}"`,
    });
  }

  // Priority order: fetch → page-script → recorded-path. Cheapest first — fetch
  // fires from Node (self-retries in-browser if TLS blocks it), page-script
  // always pays for a page load, recorded-path replays the DOM.
  const allStrategies = opts._strategyOverride ?? skills.loadStrategies(platform, capability);
  const strategies = allStrategies.filter((s) => isTierAllowed(platform, capability, s.strategy));
  if (strategies.length === 0) {
    if (allStrategies.length > 0) {
      return policyTierCapResult(platform, capability);
    }
    throw new Error(`No strategy found for ${platform}/${capability}`);
  }

  const errors: string[] = [];
  let lastFailedResult: ExecuteResult | null = null;
  let lastFailedStrategy: skills.Strategy | null = null;
  // Track whether the revisit-fallback partial-replay has already fired
  // for this execute() call so we don't double-invoke it if both the
  // fetch and page-script tiers miss. Partial replay is expensive (spins
  // up a browser session); one attempt per call is enough.
  let partialReplayAttempted = false;

  for (const strategy of strategies) {
    const type = strategy.strategy;

    if (!opts._suppressStrategyState) {
      const probation = shouldSkipBrokenTier(platform, capability, type);
      if (probation.action === 'skip') {
        errors.push(`${type}: broken (skipped — ${describeBrokenTierSkip(probation)})`);
        continue;
      }
      if (probation.action === 'probe') {
        // Stamp the clock BEFORE the probe fires. `not_run` / `delivery_unknown`
        // outcomes return early without touching health by design, so the
        // stamp is the only thing that stops the probe re-firing on every call.
        markProbeAttempted(platform, capability, type);
      }
    }

    // Preflight against notes.params. Without it, a caller passing {repo:
    // "org/name"} against a strategy expecting {owner, repo} burns a full
    // browser session on a URL with a literal `{{owner}}` in it, then times out
    // at step 1. Cheaper to short-circuit with params_doc so the caller can
    // retry with the right shape.
    const missing = findMissingParams(strategy, mergedArgs);
    if (missing.length > 0) {
      errors.push(`${type}: missing args ${missing.join(', ')}`);
      // Retain the richest params_doc across cascaded skips so the final error
      // tells the caller exactly what the next retry needs.
      const paramsDoc = (strategy.notes as { params?: unknown } | undefined)?.params;
      if (paramsDoc) {
        lastFailedResult ??= {
          status: 0,
          executionState: 'not_run',
          body: {
            error: 'missing_args',
            missing,
            params_used: Object.keys(mergedArgs).filter((k) => !k.startsWith('_')),
            params_doc: paramsDoc,
            retry_with:
              'Add the missing params to your execute() args and re-call. See params_doc for kind/example of each field.',
          },
        };
      }
      continue;
    }

    // Enum-arg grounding: enum params with inline observed_values must
    // receive a value the discovery session actually observed. Catches the
    // warm-execute hallucination where the agent copies user intent verbatim
    // (`category="pizza"`) instead of fuzzy-matching against observed labels
    // (`{value:"italian", label:"Taste the pride of Napoli"}`). Per
    // principles.md §"Prefer runtime enforcement over prompt reminders" — a
    // SKILL.md nudge to "match observed_values" was bypassed; the runtime
    // surfaces the option set so the caller cannot proceed without picking
    // from it (or asking the user to disambiguate).
    // Normalize case-only enum-arg drift ("Italian" → observed "italian") so
    // the request carries the API's exact value and the check below matches.
    normalizeEnumArgCasing(strategy, mergedArgs);
    const unobserved = findUnobservedEnumArgs(strategy, mergedArgs);
    if (unobserved.length > 0) {
      const argList = unobserved.map((u) => `${u.param}="${u.value}"`).join(', ');
      errors.push(`${type}: unobserved enum arg(s) ${argList}`);
      lastFailedResult ??= {
        status: 0,
        executionState: 'not_run',
        body: {
          error: 'unobserved_enum_arg',
          issues: unobserved,
          retry_with:
            'For each issue, pick a `value` from `observed_values` whose `label` best matches user intent. ' +
            'On no clear winner / tie, end the turn with a disambiguation question rather than guessing.',
        },
      };
      continue;
    }

    try {
      // Dynamic-enum grounding refreshes enum params with
      // `source: "capability:<slug>"` from the listing capability at execute
      // time. The listing fires as a sub-execute (counts against the prereq
      // depth), its response is parsed for the first array of `{value, ...}`
      // objects, and the caller's value must be in that fresh list. Static
      // observed_values take precedence when the caller's value is already
      // grounded, so the listing only fires on cache miss.
      const dynamicUnobserved = await validateEnumArgsAgainstSourceCapability(
        strategy,
        mergedArgs,
        platform,
        pool,
        tokenCache,
        opts.identity,
        depth,
        opts._suppressStrategyState,
      );
      if (dynamicUnobserved.length > 0) {
        const argList = dynamicUnobserved.map((u) => `${u.param}="${u.value}"`).join(', ');
        errors.push(`${type}: unobserved dynamic-enum arg(s) ${argList}`);
        lastFailedResult ??= {
          status: 0,
          executionState: 'not_run',
          body: {
            error: 'unobserved_enum_arg',
            issues: dynamicUnobserved,
            retry_with:
              'Each issue lists the fresh value set fetched from the source capability. Pick a `value` whose `label` best matches user intent and re-call execute.',
          },
        };
        continue;
      }

      let result: ExecuteResult;

      switch (type) {
        case 'fetch': {
          if (isWebSocketStrategy(strategy)) {
            const ws = await dispatchWebSocket(
              strategy,
              'fetch',
              mergedArgs,
              platform,
              capability,
              pool,
              tokenCache,
              depth,
              errors,
              opts.identity,
              opts._suppressStrategyState,
            );
            if (!ws) continue;
            result = ws.result;
            result.transport = ws.transport;
            result.protocol = 'websocket';
            break;
          }
          const apiStrategy = strategy as FetchStrategy;
          // Fires from Node by default. TLS / bot-check failures throw
          // TransportFailureError — retry the same fetch in-browser and record
          // the failure; enough failures demote the strategy to page-script for
          // future runs.
          try {
            result = await executeFetchNodeRaw(
              apiStrategy,
              mergedArgs,
              platform,
              capability,
              tokenCache,
              pool,
              depth,
              boundResolveCapabilityPrereq,
              stringifyScope,
              opts.identity,
              opts._suppressPersistedCookies,
            );
            result.transport = 'node';
          } catch (err) {
            if (err instanceof TransportFailureError) {
              if (!pool) {
                errors.push(`fetch/node: ${err.signal} and no pool for browser fallback`);
                continue;
              }
              if (!opts._suppressStrategyState) {
                recordNodeTransportFailure(platform, capability, 'fetch', 'http', err.signal);
              }
              result = await executeFetchInBrowser(
                apiStrategy,
                mergedArgs,
                platform,
                capability,
                pool,
                tokenCache,
                depth,
                opts.identity,
              );
              result.transport = 'browser';
            } else {
              throw err;
            }
          }
          break;
        }
        case 'page-script': {
          if (isWebSocketStrategy(strategy)) {
            const ws = await dispatchWebSocket(
              strategy,
              'page-script',
              mergedArgs,
              platform,
              capability,
              pool,
              tokenCache,
              depth,
              errors,
              opts.identity,
              opts._suppressStrategyState,
            );
            if (!ws) continue;
            result = ws.result;
            result.transport = ws.transport;
            result.protocol = 'websocket';
            break;
          }
          if (!pool) {
            errors.push('page-script: requires browser pool');
            continue;
          }
          result = await executeFetchInBrowser(
            strategy as PageScriptStrategy,
            mergedArgs,
            platform,
            capability,
            pool,
            tokenCache,
            depth,
            opts.identity,
          );
          result.transport = 'browser';
          break;
        }
        case 'recorded-path':
          if (!pool) {
            errors.push('recorded-path: requires browser pool');
            continue;
          }
          result = await executeRecordedPath(
            strategy as RecordedPathStrategy,
            mergedArgs,
            platform,
            capability,
            pool,
            tokenCache,
            opts.identity,
            opts.ownerSessionId,
          );
          result.transport = 'browser';
          break;
        default: {
          errors.push(`${String(type)}: unsupported`);
          continue;
        }
      }

      const body = result.body as Record<string, unknown> | null | undefined;
      if (body?.blocker && body.healable) {
        return result;
      }

      const classification = classifyFactoryExecutionResult(result);
      if (classification === 'explicit_failure') {
        result.elapsedMs = Date.now() - startedAt;
        result.tier = type;
        return result;
      }
      if (classification === 'not_run' || classification === 'delivery_unknown') {
        // Neither state is evidence about strategy health. A not-run request
        // needs caller input; an unconfirmed delivery may already have changed
        // remote state. Returning directly prevents health mutation, sibling
        // cascade, partial replay, and duplicate writes.
        result.elapsedMs = Date.now() - startedAt;
        result.tier = type;
        return result;
      }

      // Cascade on every transport failure. Auth check runs AFTER all tiers
      // are exhausted, so a 403 from fetch falls through to page-script before
      // we signal needs_reauth. Status 0 and non-2xx redirects are failures too;
      // only the classifier's accepted states may reach markHealthy below.
      if (classification === 'transport_failure') {
        const errorDetail = describeFactoryExecutionFailure(classification, result.status);
        if (!opts._suppressStrategyState) {
          markFailed(platform, capability, type, errorDetail);
          if (getHealth(platform, capability, type).status === 'broken') {
            skills.archiveStrategy(platform, capability, type, errorDetail);
          }
        }
        errors.push(`${type}: ${errorDetail}`);
        lastFailedResult = result;
        lastFailedStrategy = strategy;
        // Revisit-fallback ladder: primary (fetch / page-script) missed.
        // Before falling through to the next tier, try partial-replaying the
        // sibling recorded-path up to `notes.discovered_at_step_id` and then
        // re-firing the primary. If it sticks, return the retry's result.
        // If the partial replay or the retry fails, the loop continues to
        // the next tier (which may be the full recorded-path) as usual.
        if (
          !opts._suppressStrategyState &&
          !partialReplayAttempted &&
          (type === 'fetch' || type === 'page-script')
        ) {
          partialReplayAttempted = true;
          const retry = await tryRevisitPartialReplay(
            strategy,
            type,
            mergedArgs,
            platform,
            capability,
            strategies,
            pool,
            tokenCache,
            depth,
            errors,
            opts.identity,
            opts._suppressPersistedCookies,
          );
          if (retry) {
            retry.elapsedMs = Date.now() - startedAt;
            retry.tier = type;
            return retry;
          }
        }
        continue;
      }

      if (!opts._suppressStrategyState) {
        // markHealthy is unconditional: an empty read is a transport success,
        // and the tier stays usable. Only the "verified working" proof stamp is
        // withheld — a declared collection that returned zero rows has not
        // shown the strategy reads anything.
        markHealthy(platform, capability, type);
        if (
          classification === 'explicit_success' &&
          (type === 'fetch' || type === 'page-script') &&
          !assessDeclaredCollectionEmptiness(strategy, result.body)
        ) {
          const proof = createPostSaveVerificationProof(platform, capability, strategy);
          skills.stampPostSaveValidationProof(proof, 'passed', true);
        }
      }
      // Reset the Node-fire failure counter on a clean success so a slow spell
      // doesn't accumulate toward demotion. Keyed by protocol so a successful
      // ws run doesn't reset the http counter.
      if (!opts._suppressStrategyState && type === 'fetch') {
        recordNodeTransportSuccess(platform, capability, type, result.protocol ?? 'http');
      }
      result.elapsedMs = Date.now() - startedAt;
      result.tier = type;
      return result;
    } catch (err) {
      if (err instanceof FactoryExecutionStateError) {
        return {
          status: 0,
          executionState: err.executionState,
          body: {
            error: err.code,
            message: err.message,
            ...err.details,
          },
          elapsedMs: Date.now() - startedAt,
          tier: type,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts._suppressStrategyState) {
        markFailed(platform, capability, type, msg);
        if (getHealth(platform, capability, type).status === 'broken') {
          skills.archiveStrategy(platform, capability, type, msg);
        }
      }
      errors.push(`${type}: ${msg}`);
      continue;
    }
  }

  if (lastFailedResult) {
    const finalClassification = classifyFactoryExecutionResult(lastFailedResult);
    if (finalClassification === 'not_run' || finalClassification === 'delivery_unknown') {
      lastFailedResult.elapsedMs = Date.now() - startedAt;
      return lastFailedResult;
    }
  }

  // Auth-wall lazy retry. Extracted into a helper so the cascade body stays
  // under the cognitive-complexity ceiling.
  const retried = await maybeRetryAfterAuthWall({
    opts,
    lastFailedResult,
    strategies,
    platform,
    capability,
    args,
    pool,
    tokenCache,
  });
  if (retried) return retried;
  return finalizeCascadeFailure(args, errors, lastFailedResult, lastFailedStrategy);
}

// One-retry-on-auth-wall path. When the cascade fails on auth (401 / 403 /
// login-wall redirect / structural auth-error in the body) AND the strategies
// declared an auth-providing prereq, evict the prereq's cached result and
// re-run execute() once. The cache hit is the typical reason a sibling
// strategy would silently rely on stale cookies — invalidating it forces the
// next pass to re-run the auth flow before the main call.
//
// Bound to one retry per top-level execute() via `_authRetryAttempted` so a
// broken auth capability (returns 2xx but the cookies don't actually
// authenticate) can't loop. Second auth-wall falls through to
// finalizeCascadeFailure → `needs_reauth: true`, the LLM-driven recovery.
async function maybeRetryAfterAuthWall(input: {
  opts: ExecuteOpts;
  lastFailedResult: ExecuteResult | null;
  strategies: skills.Strategy[];
  platform: string;
  capability: string;
  args: Record<string, unknown>;
  pool: AnyPool | null;
  tokenCache: TokenCache | null;
}): Promise<ExecuteResult | null> {
  const { opts, lastFailedResult, strategies, platform, capability, args, pool, tokenCache } =
    input;
  if (opts._authRetryAttempted) return null;
  if (!lastFailedResult) return null;
  if (!looksLikeAuthFailure(lastFailedResult, lastFailedResult.finalUrl ?? '')) return null;
  const authCapabilities = collectAuthProvidingPrereqCapabilities(strategies, platform);
  if (authCapabilities.length === 0) return null;
  if (!opts._suppressStrategyState) {
    for (const c of authCapabilities) {
      defaultCapabilityCache.evictForCapability(c.platform, opts.identity, c.capability);
    }
  }
  const retried = await execute(platform, capability, args, pool, tokenCache, {
    ...opts,
    _authRetryAttempted: true,
  });
  // Only swallow the retry result if it cleared the auth wall. If the retry
  // hit auth again, prefer the original failure envelope (richer diagnosis
  // from the first cascade) over a duplicate one.
  const retryFailedAuth =
    retried.status >= 400 &&
    retried.body &&
    typeof retried.body === 'object' &&
    (retried.body as Record<string, unknown>).needs_reauth === true;
  return retryFailedAuth ? null : retried;
}

// Walk the prereqs on every strategy in the cascade and return the
// (platform, capability) pairs whose cache should be invalidated when the
// cascade hits an auth wall. Two shapes match:
//   - {kind: "tag", tag: "auth"} — resolve the tag against the platform's
//     saved capabilities, evict each provider.
//   - {kind: "capability", capability: "<slug>"} — load the target's
//     strategy, evict only when its top-level `provides` includes "auth".
function collectAuthProvidingPrereqCapabilities(
  strategies: skills.Strategy[],
  callerPlatform: string,
): Array<{ platform: string; capability: string }> {
  const seen = new Set<string>();
  const out: Array<{ platform: string; capability: string }> = [];
  const add = (platform: string, capability: string): void => {
    const key = `${platform}::${capability}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ platform, capability });
  };
  for (const strategy of strategies) {
    const prereqs = (strategy as { prerequisites?: unknown[] }).prerequisites;
    if (!Array.isArray(prereqs)) continue;
    for (const raw of prereqs) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const targetPlatform =
        typeof p.platform === 'string' && p.platform.length > 0 ? p.platform : callerPlatform;
      if (p.kind === 'tag' && typeof p.tag === 'string') {
        for (const slug of skills.findCapabilitiesProviding(targetPlatform, p.tag)) {
          add(targetPlatform, slug);
        }
      } else if (p.kind === 'capability' && typeof p.capability === 'string') {
        const target = skills.loadStrategy(targetPlatform, p.capability);
        const provides = (target as { provides?: unknown } | null)?.provides;
        if (Array.isArray(provides) && provides.includes('auth')) {
          add(targetPlatform, p.capability);
        }
      }
    }
  }
  return out;
}

/**
 * Revisit-fallback partial-replay helper. Called from `execute()`'s primary
 * (fetch / page-script) miss branch. Looks up the anchor id on the failing
 * strategy's notes, finds a sibling recorded-path with that id, partial-
 * replays it, then re-runs the primary executor. Returns the retry's result
 * on success, `null` when partial replay doesn't apply (no anchor, no
 * recorded-path, anchor missing) or when the retry still misses.
 *
 * When to skip (returns null, cascade continues):
 *   - primary's notes lack `discovered_at_step_id`
 *   - no recorded-path saved for the capability
 *   - anchor id doesn't exist in the recorded-path (renamed / deleted)
 *   - partial-replay step fails mid-flow
 *   - primary-retry still misses (4xx / throws)
 *
 * Logging: each tier transition writes to `errors[]` so bench can
 * read the cascade trail in `finalizeCascadeFailure`'s `details`.
 */
async function tryRevisitPartialReplay(
  failingStrategy: skills.Strategy,
  type: 'fetch' | 'page-script',
  args: Record<string, unknown>,
  platform: string,
  capability: string,
  strategies: skills.Strategy[],
  pool: AnyPool | null,
  tokenCache: TokenCache | null,
  depth: number,
  errors: string[],
  identity?: string,
  suppressPersistedCookies?: boolean,
): Promise<ExecuteResult | null> {
  if (!pool) {
    errors.push(`revisit-fallback: skipped (no pool for partial replay)`);
    return null;
  }
  // Same identity-bind as the parent execute() call so capability prereqs
  // re-issued during the revisit retry inherit the caller's identity.
  const boundResolveCapabilityPrereq = (
    prereq: Prerequisite,
    callerPlatform: string,
    callerArgs: Record<string, unknown>,
    callerTokens: Record<string, unknown>,
    p: AnyPool | null,
    tc: TokenCache | null,
    d: number,
    omittedOptionalParams?: ReadonlySet<string>,
  ): Promise<Record<string, unknown> | null> =>
    resolveCapabilityPrereq(
      prereq,
      callerPlatform,
      callerArgs,
      callerTokens,
      p,
      tc,
      d,
      identity,
      omittedOptionalParams,
    );
  const runtimeMeta = (failingStrategy as { runtime_meta?: Record<string, unknown> }).runtime_meta;
  const anchorId = runtimeMeta?.discovered_at_step_id;
  if (typeof anchorId !== 'string' || anchorId.length === 0) {
    errors.push(`revisit-fallback: skipped (no discovered_at_step_id on ${type})`);
    return null;
  }
  const recorded = strategies.find((s) => s.strategy === 'recorded-path') as
    | RecordedPathStrategy
    | undefined;
  if (!recorded) {
    errors.push(`revisit-fallback: skipped (no sibling recorded-path)`);
    return null;
  }
  const replay = await replayRecordedPathToAnchor(
    recorded,
    anchorId,
    args,
    platform,
    capability,
    pool,
    identity,
  );
  if (!replay.ok) {
    errors.push(`revisit-fallback: partial-replay-failed (${replay.reason})`);
    return null;
  }
  errors.push(`revisit-fallback: partial replay to "${anchorId}" succeeded; retrying ${type}`);
  try {
    let retryResult: ExecuteResult;
    if (type === 'fetch') {
      if (isWebSocketStrategy(failingStrategy)) {
        // Websocket fetch retries go through the same dispatch path — but
        // partial replay's value is limited for pure-Node ws dials. Keep
        // the branch for completeness; in practice the caller will usually
        // fall through to full recorded-path.
        await pool.endDrive(replay.session.id).catch(() => {});
        errors.push(
          `revisit-fallback: ws primary retry is not partial-replay-gated; falling through`,
        );
        return null;
      }
      try {
        retryResult = await executeFetchNodeRaw(
          failingStrategy as FetchStrategy,
          args,
          platform,
          capability,
          tokenCache,
          pool,
          depth,
          boundResolveCapabilityPrereq,
          stringifyScope,
          identity,
          suppressPersistedCookies,
        );
        retryResult.transport = 'node';
      } catch (err) {
        if (err instanceof TransportFailureError) {
          retryResult = await executeFetchInBrowser(
            failingStrategy as FetchStrategy,
            args,
            platform,
            capability,
            pool,
            tokenCache,
            depth,
            identity,
          );
          retryResult.transport = 'browser';
        } else {
          throw err;
        }
      }
    } else {
      // page-script retry runs in-browser — close the partial-replay
      // session first so the in-browser fetcher gets a clean page with
      // the restored cookies from storageState.
      await pool.endDrive(replay.session.id).catch(() => {});
      retryResult = await executeFetchInBrowser(
        failingStrategy as PageScriptStrategy,
        args,
        platform,
        capability,
        pool,
        tokenCache,
        depth,
        identity,
      );
      retryResult.transport = 'browser';
    }
    // For the fetch-Node branch the session is still open; close it now.
    if (type === 'fetch') {
      await pool.endDrive(replay.session.id).catch(() => {});
    }
    const retryClassification = classifyFactoryExecutionResult(retryResult);
    if (factoryExecutionWasAccepted(retryClassification)) {
      errors.push(`revisit-fallback: primary retry succeeded after partial replay`);
      return retryResult;
    }
    if (retryClassification !== 'transport_failure') {
      errors.push(`revisit-fallback: primary retry stopped with ${retryClassification}`);
      return retryResult;
    }
    errors.push(`revisit-fallback: primary retry still returned ${retryResult.status}`);
    return null;
  } catch (err) {
    await pool.endDrive(replay.session.id).catch(() => {});
    errors.push(
      `revisit-fallback: primary retry threw (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

/**
 * Classify the cascade trail into a typed diagnosis the start_session
 * wrapper can attach as `_auto_exec_diagnosis` on the response. Pattern-
 * matches the same data finalizeCascadeFailure already has — the existing
 * string `errors[]` carry the prereq-failure detail; we promote them to
 * a typed `kind` with a synthesized hint sentence.
 *
 * Hint sentences are templated from the failure class plus inspected
 * fields, not LLM prose — the runtime knows which prereq failed and how,
 * so the agent reads a concrete next-step suggestion at the decision
 * point. See runtime/docs/principles.md §"Inline the result in a
 * response the runtime already emits."
 */
export interface AutoExecDiagnosis {
  kind:
    | 'stale_nonce'
    | 'auth_failed'
    | 'endpoint_stale'
    | 'prereq_returned_undefined'
    | 'needs_rediscovery'
    | 'unknown';
  attempted_tier?: string;
  attempted_endpoint?: string;
  prereq_failures: Array<{ name: string; detail: string }>;
  failure_signal: string;
  /** Auth-probe outcome when the cascade returned an auth-shaped status
   *  (401/403). Absent for non-auth-shaped failures. The runtime fires the
   *  probe lazily — only when an auth-shape failure makes the
   *  stale_nonce-vs-auth_failed disambiguation worth a network round-trip.
   *  See runtime/src/auth/probe.ts. */
  probe?: {
    url: string;
    status: number | null;
    final_url: string | null;
    auth_state: 'logged_in' | 'logged_out' | 'indeterminate';
    reason: string;
  };
  investigate_with: string[];
  hint: string;
}

const PREREQ_FAILURE_RE =
  // eslint-disable-next-line sonarjs/slow-regex, sonarjs/duplicates-in-character-class
  /(?:prerequisite|prereqs?)\s+["']?([A-Za-z_$][A-Za-z0-9_$-]*)["']?[^\n—]*[—:]([\s\S]+)/i;

/**
 * Disambiguates `stale_nonce` vs `auth_failed` via the auth-probe outcome
 * (see runtime/src/auth/probe.ts). Both classes produce the same HTTP
 * status (401/403); the structural ground truth that distinguishes them
 * is whether a probe of an auth-gated page the agent has previously
 * authenticated to (`notes.discovered_from_url` ideally, `baseUrl` as
 * fallback) returns logged-in or redirects to login.
 *
 * Per runtime/docs/principles.md §"Crisp vs fuzzy": HTTP status + final
 * URL after redirects are crisp. The narrow URL-segment-vs-login-path
 * heuristic lives inside auth-probe.ts and operates only on URL pathname
 * tokenization, not on response body prose.
 */
function classifyAuthShapeFromProbe(
  status: number | undefined,
  authState: 'logged_in' | 'logged_out' | 'indeterminate' | undefined,
): 'stale_nonce' | 'auth_failed' | null {
  if (status !== 401 && status !== 403) return null;
  if (authState === 'logged_in') return 'stale_nonce';
  if (authState === 'logged_out') return 'auth_failed';
  // indeterminate / probe-absent: don't assert auth_failed from the probe — let
  // the caller fall through to body-code inspection (stale-nonce) and only then
  // the 401/403 blanket, so a rotated-token failure isn't mislabeled needs-reauth.
  return null;
}

function strategyEndpoint(strategy: skills.Strategy | null): string | undefined {
  if (!strategy) return undefined;
  const obj = strategy as Record<string, unknown>;
  if (typeof obj.endpoint === 'string') return obj.endpoint;
  if (typeof obj.wsUrl === 'string') return obj.wsUrl;
  return undefined;
}

export function classifyAutoExecDiagnosis(
  errors: string[],
  lastFailedResult: ExecuteResult | null,
  lastFailedStrategy: skills.Strategy | null,
  authProbe?: AutoExecDiagnosis['probe'],
): AutoExecDiagnosis {
  const tier = (lastFailedStrategy as { strategy?: string } | null)?.strategy;
  const endpoint = strategyEndpoint(lastFailedStrategy);

  const prereq_failures: Array<{ name: string; detail: string }> = [];
  for (const e of errors) {
    const m = PREREQ_FAILURE_RE.exec(e);
    if (m && m[1] && m[2]) prereq_failures.push({ name: m[1], detail: m[2].trim() });
  }

  const blob = errors.join('\n').toLowerCase();
  const undefinedPrereq = prereq_failures.find((p) =>
    /undefined|null|cannot read prop|typeerror/i.test(p.detail),
  );

  let kind: AutoExecDiagnosis['kind'] = 'unknown';
  let failure_signal = errors[errors.length - 1] ?? 'cascade exhausted';

  // 401/403 disambiguation: prefer the auth-probe outcome when present
  // (the caller fires it on auth-shaped failures and passes the result
  // in). Falls through to looksLikeAuthFailure / looksLikeStaleEndpoint
  // when no probe was fired.
  const probeKind = classifyAuthShapeFromProbe(lastFailedResult?.status, authProbe?.auth_state);
  if (probeKind === 'stale_nonce') {
    kind = 'stale_nonce';
    failure_signal =
      `HTTP ${lastFailedResult?.status ?? '<no-status>'} on ${endpoint ?? '<unknown endpoint>'} ` +
      `+ auth-probe of ${authProbe?.url ?? '<no-probe-url>'} returned ${authProbe?.status ?? '<no-status>'} (logged_in) — ` +
      `per-call token rotated, account session is fine`;
  } else if (probeKind === 'auth_failed') {
    kind = 'auth_failed';
    failure_signal =
      `HTTP ${lastFailedResult?.status ?? '<no-status>'} on ${endpoint ?? '<unknown endpoint>'} ` +
      `+ auth-probe of ${authProbe?.url ?? '<no-probe-url>'} → ${authProbe?.auth_state ?? '<no-state>'} (${authProbe?.reason ?? '<no-reason>'})`;
  } else if (lastFailedResult && bodyHasStaleNonceCode(lastFailedResult)) {
    // Body carries a token-rotation code (e.g. {error:"stale_nonce"}) — the
    // account session is intact, the saved token-bearing field rotated. Wins
    // over the 401/403 auth blanket below so we don't mislabel it needs-reauth.
    kind = 'stale_nonce';
    failure_signal =
      `HTTP ${lastFailedResult.status} on ${endpoint ?? '<unknown endpoint>'} — ` +
      `response carries a token-rotation code, account session intact`;
  } else if (
    lastFailedResult &&
    looksLikeAuthFailure(lastFailedResult, lastFailedResult.finalUrl ?? '')
  ) {
    kind = 'auth_failed';
    failure_signal = `HTTP ${lastFailedResult.status} on ${endpoint ?? '<unknown endpoint>'} — auth wall`;
  } else if (lastFailedResult && looksLikeStaleEndpoint(lastFailedResult)) {
    kind = 'endpoint_stale';
    failure_signal = `HTTP ${lastFailedResult.status} on ${endpoint ?? '<unknown endpoint>'} — endpoint retired`;
  } else if (undefinedPrereq) {
    kind = 'prereq_returned_undefined';
    failure_signal = `prereq "${undefinedPrereq.name}" returned undefined / threw: ${undefinedPrereq.detail}`;
  } else if (blob.includes('needs_rediscovery')) {
    kind = 'needs_rediscovery';
  }

  let hint: string;
  switch (kind) {
    case 'stale_nonce':
      hint =
        `The saved token-bearing field rotated server-side. Don't spin a new session — investigate ` +
        `via js_eval against the live page (probe Object.keys / Object.values walks for the new path), ` +
        `then patch the prereq's expression and re-save.`;
      break;
    case 'auth_failed':
      hint =
        `The session is no longer authenticated. The agent cannot recover this without user-side ` +
        `auth — surface to the human via end_drive and start a remote viewer round if needed.`;
      break;
    case 'endpoint_stale':
      hint =
        `The endpoint URL the saved strategy targets has been retired (HTTP ${lastFailedResult?.status}). ` +
        `Investigate via get_network_log to find the live endpoint, then re-save with the new URL.`;
      break;
    case 'prereq_returned_undefined':
      hint =
        `Saved prereq "${undefinedPrereq?.name}" evaluated to undefined / threw — the page state it ` +
        `reads has drifted. Investigate via js_eval to find the new path before re-saving. ` +
        `Don't spin a new session; the failed session is still open for investigation.`;
      break;
    case 'needs_rediscovery':
      hint =
        `Saved strategy is structurally stale. Investigate via get_network_log + js_eval against the ` +
        `live page to find what changed, then re-save.`;
      break;
    default:
      hint =
        `Saved strategy failed for a reason that didn't match a known class. Inspect errors[] inline ` +
        `for detail, investigate via get_network_log + js_eval, and re-save.`;
  }

  return {
    kind,
    attempted_tier: tier,
    attempted_endpoint: endpoint,
    prereq_failures,
    failure_signal,
    ...(authProbe ? { probe: authProbe } : {}),
    investigate_with: ['js_eval', 'get_network_log', 'find_in_page'],
    hint,
  };
}

// Stamp the agent-facing `error` + recovery flags on a failure body from the
// (possibly probe-corrected) diagnosis kind. Single source of truth so every
// surface that holds a diagnosis — finalizeCascadeFailure and the start-session
// probe reclass — renders consistent error/needs_reauth/needs_rediscovery, never
// a body that says auth_failed while diagnosis says stale_nonce.
export function applyDiagnosisToBody(
  body: Record<string, unknown>,
  diagnosis: AutoExecDiagnosis,
): void {
  delete body.needs_reauth;
  delete body.needs_rediscovery;
  switch (diagnosis.kind) {
    case 'auth_failed':
      body.error = 'auth_failed';
      body.needs_reauth = true;
      break;
    case 'stale_nonce':
      body.error = 'stale_nonce';
      body.needs_rediscovery = true;
      break;
    case 'endpoint_stale':
      body.error = 'endpoint_stale';
      body.needs_rediscovery = true;
      break;
    default:
      // needs_rediscovery / unknown / prereq_returned_undefined: generic failure.
      body.error = 'all_strategies_failed';
      body.needs_rediscovery = true;
  }
}

// params_used echoes the original caller args, not identity-merged or
// generator-augmented versions — the LLM can only fix what it typed, not what
// the runtime injected.
export function finalizeCascadeFailure(
  args: Record<string, unknown>,
  errors: string[],
  lastFailedResult: ExecuteResult | null,
  lastFailedStrategy: skills.Strategy | null,
  authProbe?: AutoExecDiagnosis['probe'],
): ExecuteResult {
  const lastNotes = (lastFailedStrategy as { notes?: StrategyNotes } | null)?.notes;
  const paramsDoc = lastNotes?.params;

  // Every classified execute failure carries a pointer to the recovery
  // section so the agent reads consistent guidance at the decision point
  // (needs_reauth → start a remote viewer round; needs_rediscovery → RE mode).
  const recoveryRef = 'klura://reference#execute-errors-classification-and-recovery';

  const diagnosis = classifyAutoExecDiagnosis(
    errors,
    lastFailedResult,
    lastFailedStrategy,
    authProbe,
  );
  const lastBody =
    lastFailedResult?.status === 0 &&
    lastFailedResult.body &&
    typeof lastFailedResult.body === 'object' &&
    !Array.isArray(lastFailedResult.body) &&
    typeof (lastFailedResult.body as Record<string, unknown>).error === 'string'
      ? (lastFailedResult.body as Record<string, unknown>)
      : undefined;

  // The body's error/flags are derived from diagnosis.kind (single source of
  // truth) so they never contradict it. A 401 whose body says {error:stale_nonce}
  // now ships as stale_nonce + needs_rediscovery, not auth_failed + needs_reauth.
  const body: Record<string, unknown> = {
    original_status: lastFailedResult?.status,
    original_body: lastFailedResult?.body,
    final_url: lastFailedResult?.finalUrl,
    params_used: args,
    params_doc: paramsDoc,
    recovery_ref: recoveryRef,
    diagnosis,
  };
  if (diagnosis.kind === 'endpoint_stale') {
    body.tier = (lastFailedStrategy as { strategy?: string } | null)?.strategy;
  }
  // The generic-failure class carries the full error list for inline inspection.
  if (
    diagnosis.kind !== 'auth_failed' &&
    diagnosis.kind !== 'stale_nonce' &&
    diagnosis.kind !== 'endpoint_stale'
  ) {
    body.details = errors;
  }
  applyDiagnosisToBody(body, diagnosis);
  if (lastBody) {
    // Status-zero results are runtime-owned typed transport failures. Surface
    // their exact code without interpreting its text or replacing diagnosis.
    body.transport_error = lastBody.error;
  }

  let status = 0;
  if (diagnosis.kind === 'auth_failed' || diagnosis.kind === 'stale_nonce') {
    status = lastFailedResult?.status || 401;
  } else if (diagnosis.kind === 'endpoint_stale') {
    status = lastFailedResult?.status ?? 0;
  }
  return { status, body };
}

// notes.params is the contract for "what the caller must pass" —
// prereq-extracted tokens and generator outputs are NOT caller-supplied and are
// excluded from the check.
function findMissingParams(strategy: skills.Strategy, args: Record<string, unknown>): string[] {
  const notes = (strategy as { notes?: Record<string, unknown> }).notes;
  if (!notes || typeof notes !== 'object') return [];
  const params = (notes as { params?: Record<string, unknown> }).params;
  if (!params || typeof params !== 'object') return [];
  const missing: string[] = [];
  for (const key of Object.keys(params)) {
    // Generator outputs (`__gen.X`) are minted at execute time from the
    // `generated` block, not caller-supplied — exclude them even when the
    // literal_provenance audit nudged the agent into declaring them under
    // notes.params. Mirrors findUnsatisfiedPlaceholders in save-strategy.ts.
    if (key.startsWith('__gen.')) continue;
    // Params explicitly declared `optional: true` (e.g. a `?cuisine=` filter the
    // caller may omit) are not "missing" when absent.
    const doc = params[key];
    if (doc && typeof doc === 'object' && (doc as { optional?: unknown }).optional === true) {
      continue;
    }
    const v = args[key];
    if (v === undefined || v === null || v === '') missing.push(key);
  }
  return missing;
}

// For each enum-kind param with inline observed_values, the caller arg must be
// one of the observed `value`s. Catches the warm-execute hallucination case
// (user says "pizza", agent passes category="pizza" verbatim instead of
// fuzzy-matching against `{value:"italian", label:"Taste the pride of Napoli"}`).
// Path-B enums (source: "capability:<slug>") are out of scope — values come
// from a runtime fetch, not an inline list.
export interface UnobservedEnumIssue {
  param: string;
  value: string;
  observed_values: Array<{ value: string; label: string }>;
  /** Set when the issue's value set comes from a dynamic source-capability
   *  fetch that itself failed (capability not on disk, returned an error
   *  status, or response had no extractable enum tuples). The caller can
   *  retry after fixing the listing capability. Absent on the static-
   *  observed_values path. */
  source_capability_error?: {
    capability: string;
    status?: number;
    message?: string;
  };
}
/**
 * Walk an arbitrary listing response and surface the first array-of-objects
 * with a `value` field as enum tuples. Handles both `{ categories: [...] }`
 * and bare `[...]` shapes, and falls back to bare-string arrays. Each tuple
 * carries `{value, label}`; label defaults to value when no label field
 * exists. Used by `validateEnumArgsAgainstSourceCapability` to refresh
 * dynamic-enum values from the source capability's response.
 */
export function extractEnumValuesFromListing(
  body: unknown,
): Array<{ value: string; label: string }> {
  const tupleFromItem = (item: unknown): Array<{ value: string; label: string }> => {
    if (typeof item === 'string') return [{ value: item, label: item }];
    if (!item || typeof item !== 'object') return [];
    const value = (item as Record<string, unknown>).value;
    const label = (item as Record<string, unknown>).label;
    if (typeof value !== 'string') return [];
    return [{ value, label: typeof label === 'string' ? label : value }];
  };
  if (Array.isArray(body)) return body.flatMap(tupleFromItem);
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const [key, v] of Object.entries(o)) {
      if (!Array.isArray(v) || v.length === 0) continue;
      const tuples = v.flatMap(tupleFromItem);
      if (tuples.length === 0) continue;
      // Parallel-array shape: when the values array is bare strings (so labels
      // defaulted to value), enrich labels from a sibling label-named string
      // array of EQUAL length, pairing by index. Common when an HTML listing
      // is extracted via two `multiple: true` selectors → {values:[…],
      // labels:[…]}. Values are unchanged (only labels improve), so this never
      // affects which values validate — purely better fuzzy-match labels.
      if (v.every((x) => typeof x === 'string')) {
        const labels = findParallelLabelArray(o, key, v.length);
        if (labels) {
          return v.map((val, i) => ({ value: val, label: labels[i] ?? val }));
        }
      }
      return tuples;
    }
  }
  return [];
}

// Find a sibling array (different key, equal length, all strings) whose KEY name
// is label-shaped — the parallel labels for a bare-string values array.
function findParallelLabelArray(
  o: Record<string, unknown>,
  valueKey: string,
  len: number,
): string[] | null {
  for (const [k, v] of Object.entries(o)) {
    if (k === valueKey) continue;
    if (!Array.isArray(v) || v.length !== len) continue;
    if (!v.every((x) => typeof x === 'string')) continue;
    if (/label|name|title|text|display/i.test(k)) return v;
  }
  return null;
}

/**
 * For each enum param declaring `source: "capability:<slug>"`, fetch the
 * source capability and validate the caller's arg against its current value
 * set. This wires up the documentation promise that `source: "capability:..."`
 * resolves to a freshly-fetched authoritative list at execute time — the
 * static `observed_values` path (handled by `findUnobservedEnumArgs`) is the
 * fast path that skips this fetch when the caller's value is already known.
 *
 * Recursive execute counts against the prereq depth budget (`MAX_PREREQ_DEPTH`).
 * No caching today — each execute that hits an unobserved value pays for
 * one listing fetch. Add a TTL cache here if/when the latency shows.
 */
async function validateEnumArgsAgainstSourceCapability(
  strategy: skills.Strategy,
  args: Record<string, unknown>,
  platform: string,
  pool: AnyPool | null,
  tokenCache: TokenCache | null,
  identity: string | undefined,
  depth: number,
  suppressStrategyState = false,
): Promise<UnobservedEnumIssue[]> {
  const notes = (strategy as { notes?: Record<string, unknown> }).notes;
  if (!notes || typeof notes !== 'object') return [];
  const params = (notes as { params?: Record<string, unknown> }).params;
  if (!params || typeof params !== 'object') return [];
  const issues: UnobservedEnumIssue[] = [];
  for (const [key, spec] of Object.entries(params)) {
    if (!spec || typeof spec !== 'object') continue;
    const s = spec as Record<string, unknown>;
    if (s.kind !== 'enum') continue;
    const source = s.source;
    if (typeof source !== 'string' || !source.startsWith('capability:')) continue;
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    const sourceCapability = source.slice('capability:'.length).trim();
    if (sourceCapability.length === 0) continue;
    // Fast path: static observed_values cover the caller's value already.
    const observed = s.observed_values;
    if (Array.isArray(observed) && observed.length > 0) {
      const tuples = observed.flatMap((o): Array<{ value: string; label: string }> => {
        if (!o || typeof o !== 'object') return [];
        const ov = (o as Record<string, unknown>).value;
        const ol = (o as Record<string, unknown>).label;
        return typeof ov === 'string'
          ? [{ value: ov, label: typeof ol === 'string' ? ol : ov }]
          : [];
      });
      if (tuples.some((t) => t.value === v)) continue;
    }
    // Slow path: fetch the listing capability fresh.
    let listing: ExecuteResult;
    try {
      listing = await execute(platform, sourceCapability, {}, pool, tokenCache, {
        _depth: depth + 1,
        identity,
        _suppressStrategyState: suppressStrategyState,
      });
    } catch (err) {
      issues.push({
        param: key,
        value: v,
        observed_values: [],
        source_capability_error: {
          capability: sourceCapability,
          message: err instanceof Error ? err.message : String(err),
        },
      } as UnobservedEnumIssue);
      continue;
    }
    const listingClassification = classifyFactoryExecutionResult(listing);
    if (listingClassification === 'not_run' || listingClassification === 'delivery_unknown') {
      throw new FactoryExecutionStateError(
        listingClassification === 'not_run' ? 'not_run' : 'sent_unconfirmed',
        `dynamic_enum_source_${listingClassification}`,
        `dynamic enum source ${JSON.stringify(sourceCapability)} returned ${listingClassification}; parent request not sent`,
        {
          source_capability: sourceCapability,
          source_result: listing.body,
        },
      );
    }
    if (typeof listing.status !== 'number' || listing.status < 200 || listing.status >= 300) {
      issues.push({
        param: key,
        value: v,
        observed_values: [],
        source_capability_error: {
          capability: sourceCapability,
          status: listing.status,
        },
      } as UnobservedEnumIssue);
      continue;
    }
    const fresh = extractEnumValuesFromListing(listing.body);
    if (fresh.length === 0) {
      issues.push({
        param: key,
        value: v,
        observed_values: [],
        source_capability_error: {
          capability: sourceCapability,
          message:
            "no enum tuples extractable from response — listing capability's body must be an array of {value, label?, ...} objects (or a bare-string array)",
        },
      } as UnobservedEnumIssue);
      continue;
    }
    if (fresh.some((t) => t.value === v)) continue;
    issues.push({ param: key, value: v, observed_values: fresh });
  }
  return issues;
}

// Case-only normalization for enum args: if a caller's value matches an
// observed value case-insensitively but not exactly (the agent title-cased a
// lowercase slug — "Italian" vs observed "italian"), rewrite it to the observed
// casing IN PLACE so the outgoing request carries the API's exact value and the
// unobserved-enum check below matches. Case is the ONLY normalization — typos /
// synonyms / wrong-but-close values still flag, so the agent must fuzzy-match
// via the label rather than guess. Skipped when two observed values collide
// case-insensitively (ambiguous → let it flag). Per principles.md §"Crisp vs
// fuzzy": exact case-folded equality is crisp, not prose matching.
export function normalizeEnumArgCasing(
  strategy: skills.Strategy,
  args: Record<string, unknown>,
): void {
  const params = (strategy as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return;
  for (const [key, spec] of Object.entries(params)) {
    if (!spec || typeof spec !== 'object') continue;
    const s = spec as Record<string, unknown>;
    if (s.kind !== 'enum' || !Array.isArray(s.observed_values)) continue;
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    const values = s.observed_values
      .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>).value : undefined))
      .filter((x): x is string => typeof x === 'string');
    if (values.includes(v)) continue; // already exact — nothing to do
    const lower = v.toLowerCase();
    const ciMatches = values.filter((ov) => ov.toLowerCase() === lower);
    if (ciMatches.length === 1) args[key] = ciMatches[0];
  }
}

export function findUnobservedEnumArgs(
  strategy: skills.Strategy,
  args: Record<string, unknown>,
): UnobservedEnumIssue[] {
  const notes = (strategy as { notes?: Record<string, unknown> }).notes;
  if (!notes || typeof notes !== 'object') return [];
  const params = (notes as { params?: Record<string, unknown> }).params;
  if (!params || typeof params !== 'object') return [];
  const issues: UnobservedEnumIssue[] = [];
  for (const [key, spec] of Object.entries(params)) {
    if (!spec || typeof spec !== 'object') continue;
    const s = spec as Record<string, unknown>;
    if (s.kind !== 'enum') continue;
    const observed = s.observed_values;
    if (!Array.isArray(observed) || observed.length === 0) continue;
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    const observedTuples = observed.flatMap((o): Array<{ value: string; label: string }> => {
      if (!o || typeof o !== 'object') return [];
      const ov = (o as Record<string, unknown>).value;
      const ol = (o as Record<string, unknown>).label;
      return typeof ov === 'string' ? [{ value: ov, label: typeof ol === 'string' ? ol : ov }] : [];
    });
    if (observedTuples.some((t) => t.value === v)) continue;
    issues.push({ param: key, value: v, observed_values: observedTuples });
  }
  return issues;
}

// Thin re-export; evaluation lives in strategies/predicate-registry.ts.
export async function evaluatePredicate(
  predicate: { kind?: string } | undefined,
  ctx: { session: Session; driver: BrowserDriver },
): Promise<boolean> {
  return registryEvaluatePredicate(predicate, ctx);
}
