import { pool, tokenCache } from '../runtime-state';
import { didYouMeanSuffix } from '../utils/string-distance';
import { asPlatformSlug } from '../validators';
import * as skills from '../strategies/skills';
import { execute as executeStrategy } from '../execution';
import type { ExecuteResult } from '../execution/types';
import {
  classifyFactoryExecutionResult,
  factoryExecutionWasAccepted,
} from '../execution/result-classification';
import { pickProbeUrl, probeAuthState } from '../auth/probe';
import { classifyAutoExecDiagnosis, applyDiagnosisToBody } from '../execution';
import { invokeCheckpointAndGate } from '../checkpoints';
import { loadLogbook as loadLogbookForPlatform, readRecentAborts } from '../working-dir/logbook';
import {
  loadCapabilityPolicy as loadCapabilityPolicyFull,
  loadPolicy,
  policyExists,
  savePolicy,
  type PlatformPolicy,
  type StrategyTier,
} from '../strategies/policy';
import { buildPlatformMapSummary, type PlatformMapSummary } from '../response/platform-map-summary';
import { harvestLinkUrlObservations } from '../response/session-observations';
import { detectOriginBlocked, isResolvableChallengeShape } from '../phases/origin-blocked-detector';
import { ESCALATION_ABORT_KINDS, type AbortKind } from './abort_session';
import type { VisibilityAnomaly } from '../phases/visibility';
import { snapVisibilityAnomalies } from '../phases/visibility';

/** Wait window for the JS-challenge auto-resolve path. Most JS-only
 *  challenges (purely client-side bot checks) complete in 3-6 seconds;
 *  7s is a structurally generous bound that's still cheap vs the 15-30s
 *  of failed clicks the agent would otherwise burn. */
const CHALLENGE_RESOLVE_WAIT_MS = 7000;
import { getDeviceProfile, type DeviceProfile } from '../identity/devices';
import {
  readArtifactFromDisk,
  listArtifactsForPlatform,
  LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET,
  type DiscoveryArtifact,
} from '../strategies/discovery-artifact';
import {
  trimA11yTree,
  trimOversizedObjectBody,
  sliceLargeString,
  DEFAULT_A11Y_BUDGET,
  MAX_TOOL_OUTPUT_CHARS,
} from '../response/response-size';
import type { Session, SessionOptions } from '../drivers/types/session';
import { graphConfig } from '../phases/registry';
import { dispatch } from '../phases/state-machine';
import { checkpointCaptureJournal } from '../phases/drive/build-capture-events';
import { recoverOrphanedJournals } from '../working-dir/recover-journals';
import { asIdentifierSlug, asObject, ValidationError } from '../validators';
import {
  captureAndAppendForms,
  inlineArtifactForResponse,
  NETWORKLOG_TRIM_HINT,
} from './_internals';
import { checkCapabilityArgs } from '../tools/well-known-capabilities';

export const GRAPH_MODES = ['discover', 'map', 'execute'] as const;

/** Cap on `recent_aborts` inlined into start_session responses. Tight by
 *  design — the field is a teaser pointing at the platform_logbook for
 *  full detail, not a primary surface. */
const RECENT_ABORTS_BUDGET = 5;

/** Populate the platform-keyed response fields (artifacts, platform_map,
 *  recent_aborts) from the on-disk logbook. Inlined into start_session so
 *  the agent sees prior-session handoffs at turn 0 without extra tool
 *  calls. Each field is independent — a platform with only an
 *  observed_capabilities entry but no saved artifacts still gets a
 *  platform_map; a platform with only abort events still gets recent_aborts. */
function populatePlatformResponseFields(result: StartSessionResult, platform: string): void {
  const caps = listArtifactsForPlatform(platform);
  if (caps.length > 0) {
    const artifacts: NonNullable<StartSessionResult['artifacts']> = {};
    for (const cap of caps) {
      const a = readArtifactFromDisk(platform, cap);
      if (a) {
        artifacts[cap] = inlineArtifactForResponse(
          platform,
          cap,
          a,
          LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET,
        );
      }
    }
    if (Object.keys(artifacts).length > 0) result.artifacts = artifacts;
  }
  const map = buildPlatformMapSummary(platform);
  if (map) result.platform_map = map;
  const aborts = readRecentAborts(platform, RECENT_ABORTS_BUDGET);
  if (aborts.length > 0) result.recent_aborts = aborts;
  // Escalation pattern: ≥3 aborts within 24h sharing root cause (kind + host).
  // The "try the same approach harder" reflex burned full sessions on
  // identical bot-management walls — this surfaces the same-cause count so
  // the agent has to consciously choose to escalate or acknowledge the
  // pattern.
  const escalation = computeAbortEscalation(readRecentAborts(platform, 50));
  if (escalation) result.must_escalate = escalation;
}

const ESCALATION_THRESHOLD = 3;
const ESCALATION_WINDOW_HOURS = 24;

export function computeAbortEscalation(
  aborts: ReadonlyArray<{
    kind?: string;
    host?: string;
    hours_since: number;
  }>,
): NonNullable<StartSessionResult['must_escalate']> | undefined {
  if (aborts.length < ESCALATION_THRESHOLD) return undefined;
  const groups = new Map<string, { kind: string; host?: string; count: number }>();
  for (const a of aborts) {
    if (a.hours_since > ESCALATION_WINDOW_HOURS) continue;
    const kind = a.kind ?? 'other';
    // Only genuine persistent blocks escalate; benign exits (a saved capability
    // covered the task, user stopped, site dead) are not "try harder" patterns.
    if (!ESCALATION_ABORT_KINDS.has(kind as AbortKind)) continue;
    const host = a.host;
    const key = `${kind}|${host ?? ''}`;
    const entry = groups.get(key);
    if (entry) entry.count += 1;
    else groups.set(key, { kind, host, count: 1 });
  }
  let worst: { kind: string; host?: string; count: number } | null = null;
  for (const entry of groups.values()) {
    if (entry.count < ESCALATION_THRESHOLD) continue;
    if (!worst || entry.count > worst.count) worst = entry;
  }
  if (!worst) return undefined;
  const hostFragment = worst.host ? ` on host ${JSON.stringify(worst.host)}` : '';
  return {
    same_root_cause_count: worst.count,
    kind: worst.kind,
    ...(worst.host !== undefined ? { host: worst.host } : {}),
    advisory:
      `${worst.count} prior aborts in the last ${ESCALATION_WINDOW_HOURS}h share root cause ` +
      `kind=${JSON.stringify(worst.kind)}${hostFragment}. The "try the same approach harder" ` +
      `reflex will not work — the underlying gate has not changed since the prior sessions, and ` +
      `the levers that COULD flip it (egress / proxy / driver / human-in-the-loop) are not in ` +
      `the agent's control. What you CAN do: ` +
      `(a) abort_session immediately with a reason that names the structural condition that has ` +
      `NOT changed since the prior aborts (e.g. "same egress IP, no proxy rotation since session ` +
      `<prior_session_id>") — do NOT restate this advisory verbatim, that's circular and inflates ` +
      `the abort ledger; ` +
      `(b) if you have hard evidence the condition HAS changed (site lifted block, new cookies ` +
      `primed, observed different network) document that in your abort_session.reason so future ` +
      `readers can distinguish a real retry from a duplicate. ` +
      `Note: the runtime surfaces this count so the human operator who reads the abort ledger ` +
      `sees the pattern. Operator-level moves (residential / mobile proxy, manual remote-viewer ` +
      `session, driver swap) are out of scope for an unattended session — the agent suggesting ` +
      `them is theater. Document the condition; let the operator decide.`,
  };
}

/**
 * Validate + normalize the optional `identity` option. Returns:
 *  - `undefined` for the default-identity case (omitted, empty, or the
 *    reserved sentinel `"default"`) — caller falls through to historical
 *    platform-only paths.
 *  - The validated slug otherwise.
 *
 * Rejects: non-string, malformed slugs (failing `asIdentifierSlug`), and
 * literal `"default"` from the agent — though the latter is silently
 * coerced to `undefined` so re-issuing with the canonical handle isn't a
 * fail. The validator failure for slug shape preserves agent feedback.
 */
/**
 * Walk the session's intercepted ring and pull the HTTP status of the MOST
 * RECENT top-level navigation matching the requested or resolved host.
 *
 * Reverse-iteration is load-bearing: perform_action navigate calls also use
 * this helper, and on a long-lived session the ring already contains the
 * original session-start request. Walking forward returned that early entry
 * regardless of the new navigation, masking the just-fired status as
 * whatever the initial start_session captured (typically 200) — agents
 * moved on assuming success and missed 4xx on the actual target.
 *
 * Preference order, applied in reverse: (1) entry with
 * `isNavigation === true` matching host; (2) any entry matching host with a
 * status. Drivers that don't set `isNavigation` fall through to (2) cleanly.
 */
export function readInitialNavStatus(
  session: {
    intercepted?: ReadonlyArray<{
      url?: unknown;
      status?: number | null;
      isNavigation?: boolean;
    }>;
  },
  requestedUrl: string,
  currentUrl: string,
): number | null {
  const intercepted = session.intercepted;
  if (!Array.isArray(intercepted) || intercepted.length === 0) return null;
  let requestedHost = '';
  let currentHost = '';
  try {
    requestedHost = new URL(requestedUrl).host.toLowerCase();
  } catch {
    /* keep empty — fall through to host comparison miss */
  }
  try {
    currentHost = new URL(currentUrl).host.toLowerCase();
  } catch {
    /* keep empty */
  }
  let fallback: number | null = null;
  for (let i = intercepted.length - 1; i >= 0; i--) {
    const req = intercepted[i];
    if (!req || typeof req.url !== 'string') continue;
    let reqHost: string;
    try {
      reqHost = new URL(req.url).host.toLowerCase();
    } catch {
      continue;
    }
    if (reqHost !== requestedHost && reqHost !== currentHost) continue;
    if (typeof req.status !== 'number') continue;
    if (req.isNavigation === true) return req.status;
    if (fallback === null) fallback = req.status;
  }
  return fallback;
}

function normalizeIdentityOpt(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `invalid_start_session: identity must be a string (got ${typeof value}). ` +
        `See klura://reference#identities.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === 'default') return undefined;
  try {
    return asIdentifierSlug(trimmed, 'identity');
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_start_session: ${e.message}`, { cause: e });
    }
    throw e;
  }
}

export interface StartSessionResult {
  sessionId: string;
  a11yTree: string;
  a11y_total_chars: number;
  a11y_truncated: boolean;
  /**
   * Present only when the browser's native accessibility snapshot was
   * degraded or unavailable. A `static_dom` source means the returned tree is
   * the inert serialized-DOM fallback; `unavailable` means the session remains
   * live but `a11yTree` is empty and callers should use another read surface.
   */
  a11y_snapshot?: {
    source: 'static_dom' | 'unavailable';
    warning: string;
  };
  url: string;
  /**
   * Discovery artifacts on disk for this platform, keyed by capability name.
   * Present only when the session was started with a `platform` AND at least
   * one capability has a prior-session handoff saved. Summarizes what earlier
   * sessions learned so the agent can resume without re-discovering — see
   * klura://reference#discovery-artifact for how to read it. When an individual
   * artifact exceeds the inline budget, its `_elided_fields` marker names what
   * was trimmed and the agent can fetch the full value via
   * `get_discovery_artifact_field`.
   */
  artifacts?: Record<string, DiscoveryArtifact & { _elided_fields?: string[] }>;
  /**
   * Compact teaser of the platform logbook's cross-session surface map
   * (observed_capabilities + url_graph + forms_seen). Inlined when a logbook
   * exists for the platform AND it carries any of: observed capabilities, URL
   * graph nodes, forms seen. Acts as a pointer to `get_platform_logbook` for
   * full detail. Omitted when no logbook exists or the logbook is fully empty.
   */
  platform_map?: PlatformMapSummary;
  /**
   * Recent `abort_session` events for this platform, newest first, capped at
   * `RECENT_ABORTS_BUDGET`. Cross-session learning surface — agents read this
   * at session start to spot prior wrong starts (e.g. "session N aborted
   * because existing capability X covers this — run the saved strategy"). Omitted when
   * no abort_events have been logged for the platform.
   */
  recent_aborts?: Array<{
    at: string;
    session_id: string;
    reason: string;
    captured_actions_count: number;
    phase_at_abort: string;
  }>;
  /**
   * Fires when ≥3 prior aborts in the last 24h share the same root cause
   * (same `kind` and `host`). Cross-session signal that the agent's natural
   * "try the same approach harder" reflex won't work — N prior sessions
   * already proved it. Agent must escalate (stealth driver, start_remote_session,
   * different egress) or explicitly acknowledge that the underlying condition
   * has changed before driving the UI further. Absent when no escalation
   * pattern is detected.
   */
  must_escalate?: {
    same_root_cause_count: number;
    kind: string;
    host?: string;
    advisory: string;
  };
  /**
   * True when start_session auto-executed a matching saved strategy.
   * `execute_result` carries the executor's response. When executed is true the
   * agent can end_drive directly; no more drives needed.
   */
  executed?: boolean;
  execute_result?: ExecuteResult;
  /** Reason why auto-execute didn't run or failed (when applicable). */
  auto_execute_reason?: string;
  /**
   * True when the FSM has reached terminal{closed} as part of this start_session
   * call — fires after a graph:'execute' session whose saved strategy completed
   * with explicit `body.ok:true` or transport-only HTTP 2xx. The latter is not
   * a semantic-success assertion; agents must inspect the returned body.
   */
  session_terminal?: boolean;
  /**
   * Soft warning surfaced when graph defaults to (or is set to) 'discover' for
   * a (platform, capability) pair that already has a saved strategy on disk.
   * Re-discovery is wasteful unless the saved strategy has actually failed.
   * Echoes the saved strategy's tier so the agent sees what's already on disk.
   */
  _existing_strategy_advisory?: {
    platform: string;
    capability: string;
    saved_tier: string;
    hint: string;
  };
  /**
   * Unmissable top-level hint. Present when auto-execute ran (succeeded,
   * failed, or fired interrupts). Intended to be the FIRST thing the agent
   * reads on the response — prevents "I'll just drive the UI manually" after an
   * auto-execute already completed.
   */
  _hint?: string;
  /**
   * HTTP status of the initial nav response, when the driver captured it.
   * Surfaced unconditionally on every cold start_session so agents don't
   * need a `get_network_log` round-trip to confirm a 4xx landing.
   */
  nav_status?: number | null;
  /**
   * Structured signal that the initial navigation landed on a non-
   * functional page (anti-bot gate, custom error/block page, cross-
   * origin challenge iframe, site-closed page). Carries the structural
   * signals that fired — agents branch on shape, not vendor identity.
   * See `runtime/src/phases/origin-blocked-detector.ts` for the full
   * signal taxonomy; `recommended_action` is informational and lists
   * try-first options before mentioning abort.
   */
  origin_blocked?: import('../phases/origin-blocked-detector').OriginBlockedAdvisory;
  /**
   * Visibility anomalies on the landing's interactive elements. Annotate-
   * by-exception: only nodes that are NOT plainly visible appear here.
   * `_v` values: `"o"` overlapped (covered by another element — clicks
   * land on the cover), `"f"` below-fold (off-screen vertically), `"s"`
   * off-screen (outside viewport horizontally or otherwise unreachable
   * without scroll). Empty array means every interactive element is
   * cleanly clickable. Surfaced unconditionally on every cold start —
   * cookie banners, modals, and sticky-header overlap show up here so
   * agents don't waste clicks on covered targets.
   */
  visibility_anomalies?: ReadonlyArray<VisibilityAnomaly>;
  /** Echoed back so the agent sees which graph the session is running. */
  graph?: (typeof GRAPH_MODES)[number];
  /**
   * Two-part task contract the agent should internalize when a capability is
   * declared in discover mode: (1) deliver the user's answer, (2) save a
   * reusable strategy for the capability so warm execute works without
   * re-discovery. Present on every discover-mode start_session with a declared
   * capability (mutating or read-only). Surfaces upfront so the agent's
   * task-completion signal includes the save step — without this, models tend
   * to treat "answer delivered" as complete and skip end_drive's RE
   * handoff.
   */
  task_contract?: {
    message: string;
  };
  /**
   * User-policy cap context, surfaced when start_session declares a capability
   * that carries a permanent recorded-path cap in policy.json (ToS / compliance
   * / operator rule). Agent cannot modify.
   */
  prior_decline?: {
    source: 'user_policy';
    max_strategy_tier: string;
    reason?: string;
    is_stale: boolean;
    retry_hint: string;
  };
  /**
   * Auto-revisit prompt. Present when start_session warm-executed a saved
   * strategy whose tier is below the ceiling (`fetch`) AND the platform logbook
   * records prior lift_attempts. Agent should relay `user_prompt_suggestion` as
   * a text-only turn; user decides whether to spend rounds attempting another
   * lift this session.
   */
  revisit_prompt?: {
    served_tier: string;
    ceiling_tier: 'fetch';
    prior_attempts: number;
    last_attempt_days_ago: number | null;
    /** Anchor classification on the saved page-script. Absent when the
     *  served tier isn't page-script. "dom" / "unknown" anchors are
     *  flagged as fragile and are one of the triggers for this prompt. */
    served_anchor_type?: 'module' | 'protocol' | 'dom' | 'unknown';
    last_outcome?: string;
    last_notes?: string;
    user_prompt_suggestion: string;
  };
  /**
   * Warm-execute path advisory. Present when start_session was called with a
   * platform but no capability + args, AND the platform has saved strategies
   * whose params include enum-kind fields with observed click→XHR pairs.
   * Lists each capability's required enum params with the values the agent
   * should pick from. The right move is to re-call start_session with
   * `{capability, args: {<param>: "<value>"}}` (which auto-executes the saved
   * strategy), optionally with `graph: "execute"`. Without this nudge the runtime
   * silently drops to a fresh DRIVE session even when a perfectly-good warm
   * path exists.
   */
  _warm_path_available?: {
    capabilities: Array<{
      capability: string;
      required_enum_params: Array<{
        name: string;
        observed_values: Array<{ value: string; label?: string }>;
      }>;
    }>;
    hint: string;
  };
}

interface StartSessionOptions {
  platform?: string;
  storageState?: string;
  /**
   * Account name on the platform (opt-in, multi-account scoping). Default
   * (omitted) targets the historical platform-only paths — single-account
   * use sees zero change. Named identities (`"work"`, `"personal"`, ...)
   * scope the cookie jar (`<platform>--<identity>.json`), the identity
   * profile slot, and the pool's warm-slot key. The reserved string
   * `"default"` is rejected at the edge — omit the field instead. See
   * klura://reference#identities.
   */
  identity?: string;
  capability?: string;
  args?: Record<string, string>;
  /**
   * Active graph — selects the FSM topology + per-graph configuration.
   *   'discover' (default): drive→triage→lift→closed. Goal-directed
   *     reverse-engineering toward a saved strategy.
   *   'map': drive→closed. Surface-mapping; mutating actions gate on
   *     consent, auto-synth is skipped at close, the re-persistence gate
   *     fires at lower thresholds.
   *   'execute': execute→triage→lift→closed (or terminal{failed}). Runs
   *     a saved strategy; on stale-strategy failure, falls into triage so
   *     the agent can re-plan and re-lift.
   * See klura://reference#graphs.
   */
  graph?: import('../phases/types').GraphName;
  /**
   * Permanent platform policy to merge before the session starts. Friendly
   * aliases:
   * - `max_tier` / `max_strategy_tier` with `capability` => per-capability cap
   * - `max_tier` / `max_strategy_tier` without `capability` => platform default
   * - per-capability entries may use `max_tier` or `max_strategy_tier`
   */
  policy?: StartSessionPolicyInput;
}

type StartSessionPolicyInput = PlatformPolicy & {
  max_tier?: StrategyTier;
  max_strategy_tier?: StrategyTier;
  default_max_tier?: StrategyTier;
  reason?: string;
  per_capability?: Record<
    string,
    NonNullable<PlatformPolicy['per_capability']>[string] & {
      max_tier?: StrategyTier;
    }
  >;
};

const POLICY_TIERS = ['recorded-path', 'page-script', 'fetch'] as const;

function normalizePolicyTier(value: unknown, field: string): StrategyTier {
  if (typeof value !== 'string' || !POLICY_TIERS.includes(value as StrategyTier)) {
    const suggestion =
      typeof value === 'string' ? didYouMeanSuffix(value, POLICY_TIERS as readonly string[]) : '';
    throw new Error(
      `invalid_start_session: ${field} must be one of: ${POLICY_TIERS.join(', ')}${suggestion}`,
    );
  }
  return value as StrategyTier;
}

function normalizePolicyReason(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`invalid_start_session: ${field} must be a string`);
  }
  return value;
}

function mergeStartSessionPolicy(
  existing: PlatformPolicy,
  input: StartSessionPolicyInput,
  capability?: string,
): PlatformPolicy {
  const obj = asObject(input, 'policy');
  const next: PlatformPolicy = {
    ...existing,
    per_capability: existing.per_capability ? { ...existing.per_capability } : undefined,
    throttle: existing.throttle ? { ...existing.throttle } : undefined,
  };

  if (obj.default_max_tier !== undefined || obj.default_max_strategy_tier !== undefined) {
    next.default_max_strategy_tier = normalizePolicyTier(
      obj.default_max_strategy_tier ?? obj.default_max_tier,
      obj.default_max_strategy_tier !== undefined
        ? 'policy.default_max_strategy_tier'
        : 'policy.default_max_tier',
    );
  }

  const rootMaxTier = obj.max_strategy_tier ?? obj.max_tier;
  if (rootMaxTier !== undefined) {
    const tier = normalizePolicyTier(
      rootMaxTier,
      obj.max_strategy_tier !== undefined ? 'policy.max_strategy_tier' : 'policy.max_tier',
    );
    if (capability) {
      const reason = normalizePolicyReason(obj.reason, 'policy.reason');
      next.per_capability = {
        ...(next.per_capability ?? {}),
        [capability]: {
          ...(next.per_capability?.[capability] ?? {}),
          max_strategy_tier: tier,
          ...(reason !== undefined ? { reason } : {}),
        },
      };
    } else {
      next.default_max_strategy_tier = tier;
    }
  }

  if (obj.per_capability !== undefined) {
    const per = asObject(obj.per_capability, 'policy.per_capability');
    next.per_capability = { ...(next.per_capability ?? {}) };
    for (const [cap, rawEntry] of Object.entries(per)) {
      const entry = asObject(rawEntry, `policy.per_capability["${cap}"]`);
      const maxTier = entry.max_strategy_tier ?? entry.max_tier;
      next.per_capability[cap] = {
        ...(next.per_capability[cap] ?? {}),
        ...(maxTier !== undefined
          ? {
              max_strategy_tier: normalizePolicyTier(
                maxTier,
                entry.max_strategy_tier !== undefined
                  ? `policy.per_capability["${cap}"].max_strategy_tier`
                  : `policy.per_capability["${cap}"].max_tier`,
              ),
            }
          : {}),
        ...(entry.reason !== undefined
          ? {
              reason: normalizePolicyReason(entry.reason, `policy.per_capability["${cap}"].reason`),
            }
          : {}),
      };
    }
  }

  if (obj.forbid_capabilities !== undefined) {
    next.forbid_capabilities = input.forbid_capabilities;
  }
  if (obj.throttle !== undefined) {
    next.throttle = input.throttle;
  }
  if (obj.respect_robots_txt !== undefined) {
    next.respect_robots_txt = input.respect_robots_txt;
  }
  if (obj.notes !== undefined) {
    next.notes = input.notes;
  }

  return next;
}

function applyPermanentPolicyFromStart(opts: StartSessionOptions): void {
  if (opts.policy === undefined) return;
  if (!opts.platform) {
    throw new Error('invalid_start_session: policy requires platform so it can be persisted');
  }
  if (opts.capability) {
    try {
      asIdentifierSlug(opts.capability, 'capability');
    } catch (e) {
      if (e instanceof ValidationError) {
        throw new Error(`invalid_start_session: ${e.message}`, { cause: e });
      }
      throw e;
    }
  }
  try {
    if (policyExists(opts.platform)) {
      throw new Error(
        `invalid_start_session: policy already exists for platform "${opts.platform}". ` +
          `start_session can create permanent policy only once; use the user-owned CLI ` +
          `(\`klura policy ...\`) or edit policy.json to change it.`,
      );
    }
    savePolicy(
      opts.platform,
      mergeStartSessionPolicy(loadPolicy(opts.platform), opts.policy, opts.capability),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_start_session: ${e.message}`, { cause: e });
    }
    if (e instanceof Error && e.message.startsWith('invalid_policy:')) {
      throw new Error(`invalid_start_session: ${e.message}`, { cause: e });
    }
    throw e;
  }
}

type AutoExecuteResult = Awaited<ReturnType<typeof executeStrategy>>;
type SavedStrategyEntry = ReturnType<typeof skills.loadStrategies>[number];
type PageScriptAnchor = 'module' | 'protocol' | 'dom' | 'unknown';

function normalizePageScriptAnchor(anchor: unknown): PageScriptAnchor {
  if (anchor === 'module' || anchor === 'protocol' || anchor === 'dom' || anchor === 'unknown') {
    return anchor;
  }
  return 'unknown';
}

function servedAnchorForTier(
  tierLabel: string,
  saved: readonly SavedStrategyEntry[],
): PageScriptAnchor | undefined {
  if (tierLabel !== 'page-script') return undefined;
  const served = saved.find((s) => s.strategy === 'page-script');
  return normalizePageScriptAnchor(served?.notes?.anchor_type);
}

function daysSinceAttempt(attemptedAt: string | undefined): number | null {
  if (!attemptedAt) return null;
  return Math.floor((Date.now() - Date.parse(attemptedAt)) / (24 * 60 * 60 * 1000));
}

function attachRevisitPrompt(
  platform: string,
  capability: string,
  saved: readonly SavedStrategyEntry[],
  execResult: AutoExecuteResult,
  result: StartSessionResult,
): void {
  if (!execResult.tier || execResult.tier === 'fetch') return;
  try {
    const logbook = loadLogbookForPlatform(platform);
    const cap = logbook.per_capability[capability];
    const liftAttempts = cap?.lift_attempts ?? [];
    const tierLabel = execResult.tier;
    const servedAnchor = servedAnchorForTier(tierLabel, saved);
    const isFragilePageScript =
      tierLabel === 'page-script' && (servedAnchor === 'dom' || servedAnchor === 'unknown');
    const hasPriorAttempts = liftAttempts.length > 0;
    if (!hasPriorAttempts && !isFragilePageScript && tierLabel !== 'recorded-path') return;

    const last = liftAttempts[liftAttempts.length - 1];
    const lastDays = daysSinceAttempt(last?.attempted_at);
    const slowNote =
      tierLabel === 'recorded-path'
        ? 'Recorded-path is ~10× slower and brittle to DOM drift. '
        : '';
    let fragileNote = '';
    if (isFragilePageScript) {
      fragileNote =
        servedAnchor === 'dom'
          ? 'The saved page-script is DOM-anchored (depends on the rendered component tree) — breaks on UI refactors. '
          : 'The saved page-script has no declared anchor_type (treated as fragile) — may not survive UI refactors. ';
    }
    const lastNotePart = last?.notes ? ` — last note: "${last.notes}"` : '';
    const lastAttemptPart = lastDays !== null ? ` (last attempt ${lastDays}d ago)` : '';
    const priorAttemptsClause = hasPriorAttempts
      ? `We've previously tried lifting this to a faster tier ${liftAttempts.length} time(s)` +
        `${lastAttemptPart}${lastNotePart}. `
      : '';
    const revisitAction = isFragilePageScript
      ? 're-anchor on the underlying module/protocol so the strategy survives refactors'
      : 'lift it again now';
    result.revisit_prompt = {
      served_tier: tierLabel,
      ceiling_tier: 'fetch',
      prior_attempts: liftAttempts.length,
      last_attempt_days_ago: lastDays,
      ...(servedAnchor ? { served_anchor_type: servedAnchor } : {}),
      ...(last?.outcome ? { last_outcome: last.outcome } : {}),
      ...(last?.notes ? { last_notes: last.notes } : {}),
      user_prompt_suggestion: `I served the answer via ${tierLabel}. ${fragileNote}${priorAttemptsClause}${slowNote}Want me to spend rounds trying to ${revisitAction}, or skip and continue?`,
    };
  } catch {
    /* logbook read is best-effort — never break warm execute */
  }
}

/**
 * Build the drive-start contextual hints from structural cues already on the
 * session at start_session time. Each branch is a separate detector firing
 * only when its specific signal is present — no fall-through prose, no
 * keyword matching against agent-emitted text.
 *
 * Inputs are read once at start_session emit time (forms captured during
 * the initial nav, inlined discovery artifacts). The returned strings are
 * combined into a single `_hint` block on the response. SKILL.md does not
 * carry these reminders — they pay tokens only when their structural cue
 * actually fires.
 */
function collectDriveStartNudges(input: {
  forms: ReadonlyArray<{
    fields: ReadonlyArray<{ name: string; type: string; required?: boolean }>;
  }>;
  a11yTree: string;
  hasArtifacts: boolean;
  /** Inlined artifacts keyed by capability slug. The graduation nudge reads
   *  `tool_call_trace[*].outcome === 'ok'` per capability to discriminate
   *  "this artifact has captured evidence ready to graduate" from "this
   *  artifact is empty / still-RE-ing." */
  artifacts?: Record<string, { tool_call_trace?: ReadonlyArray<{ outcome?: string }> }>;
  /** Names of capabilities the platform's `observed_capabilities[]` slot
   *  carries (cross-session: prior `record_observed_capability` calls).
   *  The graduation nudge requires the capability to be BOTH artifacted
   *  AND observed — that's the structural signal that lift_observed_capability
   *  will accept it for this map session. */
  observedCapabilityNames?: ReadonlyArray<string>;
}): string[] {
  const nudges: string[] = [];

  // Auth-gated landing page: the canonical structural signal is an HTML
  // input with `type="password"`. That field type is what password
  // managers, mobile keyboards, and autofill engines key off — it's the
  // browser's own authoritative "this is a secret" semantic. No fuzzy
  // form-name keyword matching needed.
  const hasPasswordInput = input.forms.some((f) =>
    f.fields.some((field) => field.type === 'password'),
  );
  if (hasPasswordInput) {
    nudges.push(
      'AUTH-GATED SITE: this page has a password input. If your task spans multiple capabilities behind the same login, ' +
        'save the auth flow as its own capability with `provides: ["auth"]` declared at the top level. Dependents chain ' +
        'via `prerequisites: [{name: "auth", kind: "tag", tag: "auth"}]` — typed-edge resolution lets multiple auth ' +
        'methods (password, OAuth, SSO) coexist as separate capabilities on the same platform. When you save an ' +
        'auth-gated fetch / page-script after at least one auth-providing capability is on disk, the runtime auto-injects ' +
        'the typed-auth prereq for you. See klura://reference#tag-prereq.',
    );
  }

  // Search-shaped UI. Two structural signals, both authoritative:
  //  (1) An HTML5 `<input type="search">` inside a `<form>` (classical
  //      pattern). `captureFormSummary` surfaces this in `forms`.
  //  (2) A `searchbox` ARIA role anywhere in the a11y tree — catches
  //      modern SPA shapes where the input is form-less (a `<input
  //      type="search">` not wrapped in `<form>`, an explicit
  //      `role="searchbox"` on a div+contenteditable, etc.). Reading the
  //      a11y tree as the source of truth means the cue fires for the
  //      same UI semantic regardless of how the page chose to mark up
  //      the input.
  // Both checks are structural — input-type semantic / ARIA role — not
  // prose matching against placeholder text or page copy.
  const hasSearchShapedForm = input.forms.some(
    (f) =>
      f.fields.length <= 2 &&
      f.fields.some((field) => field.type === 'search') &&
      !f.fields.some((field) => field.type === 'password' || field.type === 'email'),
  );
  // Playwright's a11y snapshot serializes `<input type="search">` (and
  // explicit `role="searchbox"`) as a `searchbox` line. A line-anchored
  // check avoids false positives on prose containing the word "search".
  const hasSearchboxInTree = /^[ \t]*-[ \t]+searchbox\b/m.test(input.a11yTree);
  if (hasSearchShapedForm || hasSearchboxInTree) {
    nudges.push(
      'SEARCH-SHAPED UI detected (a `searchbox`-role input on the page). ' +
        'The classical capability shape is `search_<entity>` with the user query as a single arg, lifted to `fetch` if the ' +
        'search endpoint replies with templatable JSON or `fetch` + `response.format: "html"` if results are server-rendered. ' +
        'Prefer this over recorded-path replay even when the page does the search via XHR.',
    );
  }

  // Discovery artifact carry-over: a prior session left RE breadcrumbs on
  // disk and the runtime inlined them into the response. Make the carryover
  // unmissable so the agent extends rather than re-derives.
  if (input.hasArtifacts) {
    nudges.push(
      'PRIOR-SESSION HANDOFF: the response includes `artifacts` populated by earlier sessions for this platform. ' +
        "Read each artifact's notes / verified expressions / resume pointers BEFORE driving the UI — the previous agent left " +
        'specific findings (file:line for encoders, confirmed token shapes, partial RE conclusions) that you should build on. ' +
        'When you make new progress, persist it to the artifact via `add_discovery_note` / `save_verified_expression` / ' +
        '`add_resume_pointer` so the chain continues.',
    );
    // Graduation nudge: when an inlined artifact has captured evidence
    // (any `tool_call_trace` entry with `outcome === 'ok'` — proxy for
    // "this artifact reached a working call") AND the slug is in the
    // platform's observed_capabilities[], lift is the right next move.
    // Re-driving the UI to re-discover is wasted rounds when the prior
    // session already did the discovery. Per loop pattern
    // `agent-skips-lift-observed-capability-graduation` (4 of 7 runs).
    const liftCandidates = collectGraduationCandidates(input);
    if (liftCandidates.length > 0) {
      const sample = liftCandidates.slice(0, 3).join(', ');
      const overflow = liftCandidates.length > 3 ? ` (+${liftCandidates.length - 3} more)` : '';
      nudges.push(
        `READY-TO-GRADUATE artifacts: ${liftCandidates.length} inlined artifact(s) ` +
          `[${sample}${overflow}] carry captured 2xx-evidence tool_call_trace entries AND ` +
          `appear in platform_map.observed_capabilities. Call ` +
          '`lift_observed_capability({session_id, name: "<slug>"})` for each — that enters ' +
          'triage with the prior captures already on hand, then save_strategy lands the ' +
          'strategy. Re-driving the UI for fresh discovery is wasted rounds when the prior ' +
          'session already paid for the captures.',
      );
    }
  }

  return nudges;
}

/** Filter inlined artifacts to those whose tool_call_trace shows captured
 *  2xx evidence AND whose slug is in the platform's observed_capabilities.
 *  Result is the set of slugs the agent should graduate via
 *  `lift_observed_capability` instead of re-driving for fresh discovery. */
function collectGraduationCandidates(input: {
  artifacts?: Record<string, { tool_call_trace?: ReadonlyArray<{ outcome?: string }> }>;
  observedCapabilityNames?: ReadonlyArray<string>;
}): string[] {
  const artifacts = input.artifacts;
  if (!artifacts) return [];
  const observed = new Set(input.observedCapabilityNames ?? []);
  if (observed.size === 0) return [];
  const out: string[] = [];
  for (const [slug, artifact] of Object.entries(artifacts)) {
    if (!observed.has(slug)) continue;
    const trace = artifact.tool_call_trace ?? [];
    if (!trace.some((e) => e.outcome === 'ok')) continue;
    out.push(slug);
  }
  return out;
}

/**
 * Walk every saved strategy on this platform and surface capabilities whose
 * `notes.params` declares enum-kind fields with click→XHR `observed_values`.
 * The runtime knows enough to point the agent at the warm path here — without
 * this, an agent that read `list_platform_skills` for the platform but called
 * `start_session({platform})` (no capability/args) silently drops to a fresh
 * DRIVE session, re-discovering rather than executing the saved strategy.
 *
 * Returns undefined when no platform-saved capability has at least one
 * grounded enum param. Returning a list (rather than auto-executing) keeps
 * the multi-capability case unambiguous for the agent — it picks which
 * capability + which observed value matches the user intent.
 */
function collectWarmPathAvailable(
  platform: string,
): NonNullable<StartSessionResult['_warm_path_available']> | undefined {
  const skill = skills.listPlatformSkills().find((s) => s.platform === platform);
  if (!skill || skill.capabilities.length === 0) return undefined;

  const out: NonNullable<StartSessionResult['_warm_path_available']>['capabilities'] = [];
  for (const cap of skill.capabilities) {
    const strategies = skills.loadStrategies(platform, cap.name);
    if (strategies.length === 0) continue;
    const enumParams: Array<{
      name: string;
      observed_values: Array<{ value: string; label?: string }>;
    }> = [];
    for (const strat of strategies) {
      const params = (strat as { notes?: { params?: Record<string, unknown> } }).notes?.params;
      if (!params || typeof params !== 'object') continue;
      for (const [name, info] of Object.entries(params)) {
        if (!info || typeof info !== 'object') continue;
        const i = info as { kind?: unknown; observed_values?: unknown };
        if (i.kind !== 'enum' || !Array.isArray(i.observed_values)) continue;
        const grounded = i.observed_values.filter(
          (v): v is { value: string; label?: string } =>
            !!v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string',
        );
        if (grounded.length === 0) continue;
        if (enumParams.some((p) => p.name === name)) continue;
        enumParams.push({ name, observed_values: grounded });
      }
    }
    if (enumParams.length > 0) {
      out.push({ capability: cap.name, required_enum_params: enumParams });
    }
  }
  if (out.length === 0) return undefined;

  const sole = out[0];
  const summary =
    out.length === 1 && sole
      ? `Saved capability "${sole.capability}" requires ${sole.required_enum_params
          .map(
            (p) =>
              `${p.name} (one of: ${p.observed_values.map((v) => JSON.stringify(v.value)).join(', ')})`,
          )
          .join('; ')}.`
      : `${out.length} saved capabilities require enum args. Pick the one matching the user intent.`;
  return {
    capabilities: out,
    hint:
      `${summary} Re-call start_session with {platform, capability, args: {<param>: "<observed value>"}} to auto-execute the saved strategy, ` +
      `adding graph: "execute" if you want that invocation to be the whole session. Match the user's free-text request against the observed_values' \`label\` field — ` +
      `\`value\` is the wire-format token the saved strategy expects.`,
  };
}

/**
 * Read a saved strategy's `notes.params` and return the set of param names
 * the agent must supply via `args` for warm-execute to succeed. A param is
 * caller-supplied when it has no `source` field — `source: "capability:..."`
 * or `source: "prereq:..."` indicates the runtime resolves it via a
 * prerequisite at execute time, so the agent shouldn't pass it directly.
 *
 * Returns an empty set when the strategy has no `notes.params` (e.g. a
 * parameterless `logout` capability, or a recorded-path with no declared
 * placeholders).
 */
function expectedAgentArgNames(strategy: unknown): Set<string> {
  const out = new Set<string>();
  if (!strategy || typeof strategy !== 'object') return out;
  const notes = (strategy as { notes?: unknown }).notes;
  if (!notes || typeof notes !== 'object') return out;
  const params = (notes as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return out;
  for (const [name, info] of Object.entries(params as Record<string, unknown>)) {
    if (info && typeof info === 'object') {
      const source = (info as { source?: unknown }).source;
      if (typeof source === 'string' && source.length > 0) continue;
    }
    out.add(name);
  }
  return out;
}

async function maybeAutoExecuteOnStart(
  session: Session,
  opts: StartSessionOptions,
  result: StartSessionResult,
): Promise<void> {
  if (!opts.platform || !opts.capability) return;

  const { platform, capability } = opts;
  const saved = skills.loadStrategies(platform, capability);
  if (saved.length === 0) {
    // Only surface "no saved strategy" when the agent demonstrated intent
    // by passing args (the canonical warm-call shape). Otherwise the agent
    // is just opening a discovery session and the absence of a saved
    // strategy is expected, not informational.
    if (opts.args) {
      result.executed = false;
      result.auto_execute_reason = 'no_complete_saved_strategy';
      dispatchExecuteGraphOutcome(session, opts, result);
    }
    return;
  }

  // Saved strategy exists. Verify the agent passed enough args to satisfy
  // its caller-input params before attempting auto-exec. Without this check
  // the agent's `start_session({platform, capability})` with wrong/absent
  // args silently falls through to "fresh discovery" — the agent re-drives
  // the UI manually, burning rounds against a strategy that's already
  // saved. Surface the expected arg shape so the agent can re-call cleanly.
  const expected = expectedAgentArgNames(saved[0]);
  const provided = opts.args ? new Set(Object.keys(opts.args)) : new Set<string>();
  const missing = [...expected].filter((p) => !provided.has(p));
  if (missing.length > 0) {
    result.executed = false;
    result.auto_execute_reason = 'args_required_to_auto_execute';
    const expectedList = [...expected];
    const expectedShape = expectedList.map((p) => `${p}: "<value>"`).join(', ');
    result._hint =
      `A saved ${(saved[0] as { strategy?: string }).strategy ?? 'fetch'} strategy for ` +
      `${platform}/${capability} exists, but start_session args ` +
      `${opts.args ? "don't cover" : 'were not provided for'} its declared params. ` +
      `Missing: [${missing.join(', ')}]. Re-call with args: {${expectedShape}} to auto-execute ` +
      `the saved strategy. ` +
      `notes.params.<name>.description on the saved strategy has detail on each.`;
    dispatchExecuteGraphOutcome(session, opts, result);
    return;
  }

  const args = (opts.args ?? {}) as Record<string, unknown>;
  const unregister = pool.registerSharedSession?.(session, platform) ?? (() => {});
  try {
    // Identity is already validated upstream and stamped on the session
    // (`session.identity`); read from there so warm callers in
    // executeStrategy resolve the right cookie jar.
    const execResult = await executeStrategy(platform, capability, args, pool, tokenCache, {
      identity: session.identity,
      // Auto-execute on a recorded-path tier cold-spawns a fresh inner
      // session. Threading the outer (agent-driving) id lets the inner
      // pause register an alias so resume_execution / ack_checkpoint
      // with the agent's session id (the only one the agent knows from
      // start_session's response) resolve to the inner registry
      // entries. See runtime/src/execution/auto-execute-alias.ts.
      ownerSessionId: session.id,
    });
    result.executed = true;
    result.execute_result = trimOversizedObjectBody(execResult, {
      dropField: 'networkLog',
      mode: 'force-compact',
      availableHint: NETWORKLOG_TRIM_HINT,
    });
    // Track stale-strategy auto-executes so end_drive's LIFT handoff
    // routes the agent to update the broken strategy. Without this,
    // the existence of the broken strategy keeps `hasAny=true` in
    // computeReverseEngineerHandoff and end_drive closes the session
    // without ever offering a save surface — the agent loses the only
    // path to override the stale shape.
    const execStatus = (execResult as { status?: number }).status;
    if (typeof execStatus === 'number' && execStatus >= 400) {
      if (!session.staleStrategyCapabilities) {
        session.staleStrategyCapabilities = new Set();
      }
      session.staleStrategyCapabilities.add(capability);
    }
    attachRevisitPrompt(platform, capability, saved, execResult, result);
    // Promote the cascade-failure diagnosis to a top-level inline envelope.
    // On auth-shaped failure (401/403), fire the auth-probe against
    // notes.discovered_from_url (or baseUrl fallback) to disambiguate
    // "rotating-token rejection" (stale_nonce — re-extract via prereq)
    // from "session expired" (auth_failed — escalate to user re-auth).
    // The disambiguation is crisp (HTTP status + final URL after
    // redirect-follow) — see runtime/src/auth/probe.ts and principles.md
    // §"Crisp vs fuzzy".
    const body = (execResult as { body?: Record<string, unknown> }).body;
    const status = (execResult as { status?: number }).status;
    if (body && typeof body === 'object') {
      if ((status === 401 || status === 403) && body.diagnosis) {
        const probeStrategy = saved[0]?.strategy ?? null;
        const probeUrl = pickProbeUrl(probeStrategy);
        if (probeUrl) {
          try {
            const driver = pool.driverFor(session.id);
            const probe = await probeAuthState(driver, session, probeUrl);
            const errs = Array.isArray(body.details) ? (body.details as string[]) : [];
            const lastFailedResult = {
              status,
              body: body.original_body,
              finalUrl: typeof body.final_url === 'string' ? body.final_url : undefined,
            };
            const reclass = classifyAutoExecDiagnosis(
              errs,
              lastFailedResult as never,
              probeStrategy as never,
              probe,
            );
            body.diagnosis = reclass;
            // Re-derive error/needs_reauth/needs_rediscovery from the corrected
            // diagnosis so the body doesn't ship auth_failed+needs_reauth while
            // the (probe-corrected) diagnosis says stale_nonce.
            applyDiagnosisToBody(body, reclass);
          } catch {
            // Probe failed for an infrastructural reason — keep the
            // un-probed diagnosis. Don't let the probe failure cascade
            // back as a different error to the agent.
          }
        }
      }
      if (body.diagnosis) {
        (result as unknown as Record<string, unknown>)._auto_exec_diagnosis = body.diagnosis;
        // Auth-failed diagnosis is the canonical session_expired signal —
        // saved storage state is no longer valid against the live site.
        // Emit the checkpoint so a registered handler decides whether to
        // open the viewer for re-auth (default), continue silently
        // (benchmark stub), or hand off via a custom plugin. Envelope, if
        // any, attaches as `_checkpoint` on the start_session response so
        // the agent gates the next tool call on `ack_checkpoint`.
        const diagnosisKind = (body.diagnosis as { kind?: string }).kind;
        if (diagnosisKind === 'auth_failed') {
          try {
            const { envelope } = await invokeCheckpointAndGate('session_expired', {
              session_id: session.id,
              context: {
                kind: 'session_expired',
                platform,
                capability,
                attempted_tier: (body.diagnosis as { attempted_tier?: string }).attempted_tier,
                attempted_endpoint: (body.diagnosis as { attempted_endpoint?: string })
                  .attempted_endpoint,
                status,
              },
            });
            if (envelope) {
              (result as unknown as Record<string, unknown>)._checkpoint = envelope;
            }
          } catch {
            // Checkpoint dispatch failure is non-fatal — diagnosis is still
            // surfaced under _auto_exec_diagnosis. The agent can read kind:
            // "auth_failed" and decide manually.
          }
        }
      }
    }
  } catch (err) {
    result.executed = false;
    result.auto_execute_reason = `auto_execute_threw: ${err instanceof Error ? err.message : String(err)}`;
    // Throw on auto-execute is a stale-strategy signal too — same
    // routing rationale as the 4xx/5xx branch above.
    if (!session.staleStrategyCapabilities) {
      session.staleStrategyCapabilities = new Set();
    }
    session.staleStrategyCapabilities.add(capability);
  } finally {
    unregister();
  }
  dispatchExecuteGraphOutcome(session, opts, result);
}

/**
 * Decide whether `start_session({graph:"execute"})` can skip the entire
 * browser-session lifecycle. Returns true only when:
 *  - graph is explicitly "execute" (the agent is asking the runtime to RUN
 *    a saved strategy, not to drive a page);
 *  - platform + capability + args were all supplied (auto-execute would
 *    fire on the slow path too);
 *  - a saved strategy for (platform, capability) exists AND can run from
 *    Node alone — fetch tier, no `transport:"browser"`, and no
 *    browser-bound prereqs (js-eval, browser-kind imperative steps).
 *
 * Capability prereqs disqualify conservatively — they recursively dispatch
 * to another saved strategy whose own browser-need we can't determine
 * cheaply at this layer. (A future refinement: walk the dependency graph
 * and only disqualify when a transitive prereq is genuinely
 * browser-bound.)
 *
 * Disqualifying inputs fall through to the normal `pool.createSession` +
 * `driver.navigate` path so the slow path's discover-graph fallback, auth
 * probes, and recorded-path replay continue to work unchanged.
 */
function canFastPathExecute(opts: StartSessionOptions): boolean {
  if (opts.graph !== 'execute') return false;
  if (!opts.platform || !opts.capability) return false;
  if (!opts.args || typeof opts.args !== 'object') return false;
  const saved = skills.loadStrategies(opts.platform, opts.capability);
  if (saved.length === 0) return false;
  // Only consider the first (highest-priority) saved strategy. The cascade
  // would still try lower tiers on Node failure — but we want the
  // fast-path to be tight: only fire when we're certain no browser is needed
  // at all.
  return strategyRunsWithoutBrowser(saved[0]);
}

function strategyRunsWithoutBrowser(strategy: unknown): boolean {
  if (!strategy || typeof strategy !== 'object') return false;
  const tier = (strategy as { strategy?: string }).strategy;
  if (tier !== 'fetch') return false;
  const transport = (strategy as { transport?: string }).transport;
  if (transport === 'browser') return false;
  const prereqs = (strategy as { prerequisites?: Array<{ kind?: string }> }).prerequisites;
  if (Array.isArray(prereqs)) {
    for (const p of prereqs) {
      const k = p.kind;
      if (k === 'js-eval' || k === 'browser') return false;
      // Capability prereqs may transitively need a browser. Conservative
      // disqualifier — fall back to the slow path.
      if (k === 'capability') return false;
    }
  }
  return true;
}

/**
 * Synthetic execute-only start_session. Builds a Session shell via
 * `pool.createNodeOnlySession` (no browser context, no page nav, no a11y
 * snapshot) and runs `maybeAutoExecuteOnStart` against it. The FSM
 * transition to terminal{closed} fires inside maybeAutoExecuteOnStart →
 * dispatchExecuteGraphOutcome, so subsequent agent tool calls on this
 * session id get the standard "session has been finalized" admissibility
 * rejection. Driver-using paths inside maybeAutoExecuteOnStart (the
 * auth-failed probe at fetch-node.ts via pool.driverFor) already swallow
 * lookup failures via a try/catch, so the synthetic session composes
 * safely.
 */
async function executeOnlyFastPath(
  opts: StartSessionOptions,
  url: string,
  identity: string | undefined,
  deviceProfile: DeviceProfile,
): Promise<StartSessionResult> {
  // canFastPathExecute is the only entry point that gates these — narrow
  // for the type checker so the rest of the function reads cleanly.
  if (!opts.capability) {
    throw new Error('executeOnlyFastPath called without capability');
  }
  const capability = opts.capability;
  const sessionInit: { platform?: string; identity?: string } = {};
  if (opts.platform) sessionInit.platform = opts.platform;
  if (identity) sessionInit.identity = identity;
  const session = pool.createNodeOnlySession(sessionInit);
  if (opts.platform) session.platform = opts.platform;
  if (identity) session.identity = identity;
  session.device = deviceProfile.name ?? 'default';
  session.graph = 'execute';
  session.status = 'active';
  session.declaredCapabilities = [
    {
      capability,
      args: opts.args && typeof opts.args === 'object' ? opts.args : {},
      declared_at: Date.now(),
    },
  ];

  const result: StartSessionResult = {
    sessionId: session.id,
    a11yTree:
      `<not loaded: start_session(graph:"execute") fast-path ran the saved ` +
      `fetch strategy from Node — the page UI was never opened. The data is ` +
      `in execute_result. If the strategy returned an error and you need to ` +
      `re-drive the UI, open a new session without graph:"execute".>`,
    a11y_total_chars: 0,
    a11y_truncated: false,
    url,
    graph: 'execute',
  };
  if (opts.platform) populatePlatformResponseFields(result, opts.platform);

  await maybeAutoExecuteOnStart(session, opts, result);

  // Per-tool body cap (Layer 2 of the output-budget enforcement) — same
  // pipeline as the slow path. enforceFinalBudget in formatToolResult is
  // the last-resort backstop.
  if (result.execute_result) {
    compactExecuteResultBody(result.execute_result as unknown as Record<string, unknown>);
  }

  applyAutoExecuteHint(result, session, opts);
  return result;
}

/**
 * `auto_execute_reason` values that mean the runtime DECLINED to attempt
 * the saved strategy — the executor never ran, so there's no failure to
 * route through the rediscover-gate. The session swaps back to the
 * `discover` graph so drive primitives (`js_eval`, `perform_action`,
 * `get_a11y_tree`) become admissible and the `_hint`'s "drive the flow
 * yourself" path is real. Without the swap the session stays in the
 * narrow execute-phase tool surface (only `end_drive`, `get_screenshot`,
 * auth-recovery), contradicting the hint.
 *
 * Fail-closed: a future "didn't try" reason added later remains terminal
 * unless explicitly added here. "Tried and failed" reasons
 * (`auto_execute_threw: ...`) are NOT in this set — they correctly route
 * through the FSM's failure path.
 */
const NON_TERMINAL_AUTO_EXECUTE_REASONS: ReadonlySet<string> = new Set([
  'args_required_to_auto_execute',
  'no_complete_saved_strategy',
]);

/**
 * For `graph: 'execute'` sessions, route the warm-execute outcome through
 * the FSM. Saved-strategy success → `execute_succeeded` (terminal{closed});
 * failure routes through the rediscover-failure gate: stale strategies →
 * triage with the failure as defense-surface input; arg/auth/structural
 * failures → terminal{failed}. discover/map graphs ignore this entirely.
 *
 * On a "didn't try" decline (see NON_TERMINAL_AUTO_EXECUTE_REASONS), the
 * session graph swaps back to `discover` and no FSM event is dispatched —
 * the session behaves as a fresh discover session for the agent's manual
 * drive recovery.
 */
export function dispatchExecuteGraphOutcome(
  session: Session,
  opts: StartSessionOptions,
  result: StartSessionResult,
): void {
  if (session.graph !== 'execute') return;
  if (!opts.platform || !opts.capability) return;
  if (
    result.executed !== true &&
    typeof result.auto_execute_reason === 'string' &&
    NON_TERMINAL_AUTO_EXECUTE_REASONS.has(result.auto_execute_reason)
  ) {
    // Auto-execute declined — swap the session out of the execute graph
    // so drive primitives are admissible. The graph swap is safe here
    // because the FSM hasn't dispatched anything in the execute graph yet
    // (no execute-phase onEnter has populated session.execute), so the
    // half-initialized check in currentPhase doesn't trip.
    session.graph = 'discover';
    return;
  }

  const platform = opts.platform;
  const capability = opts.capability;
  const er = result.execute_result;
  const body =
    er?.body && typeof er.body === 'object' ? (er.body as Record<string, unknown>) : null;
  // A boolean body.ok is an explicit local-factory signal and therefore wins
  // over HTTP status. Without it, 2xx means only that transport completed; the
  // agent must inspect the body because local strategies do not carry the
  // signed outcome contracts used by public packages.
  const classification = classifyFactoryExecutionResult(er);
  const accepted = factoryExecutionWasAccepted(classification);

  if (result.executed === true && accepted) {
    dispatch(session, { kind: 'execute_succeeded' });
    return;
  }

  // Recorded-path heal: when auto-execute paused on a failed step it registers
  // a resume continuation in pausedExecutions and emits a recorded_step_failed
  // checkpoint. Dispatching execute_failed here would route to terminal{failed}
  // and stamp session.status='failed', making resume_execution inadmissible —
  // the exact tool the checkpoint instructs the agent to call. Leave the session
  // in its current (active, execute) state so the heal can proceed. (_checkpoint
  // is read off er — hoisted by compactExecuteResultBody — or off the intact
  // body before compaction.)
  const erCp = (er as unknown as Record<string, unknown> | undefined)?._checkpoint;
  let checkpoint: Record<string, unknown> | null = null;
  if (erCp && typeof erCp === 'object') {
    checkpoint = erCp as Record<string, unknown>;
  } else if (body && typeof body._checkpoint === 'object' && body._checkpoint !== null) {
    checkpoint = body._checkpoint as Record<string, unknown>;
  }
  if (checkpoint && checkpoint.kind === 'recorded_step_failed') {
    return;
  }

  // Failure shape: either the executor never ran (no saved strategy / args
  // missing) OR it ran and returned non-ok / threw. Both surface as
  // execute_failed with a summary for the failure-gate predicate to read.
  const errorSummary =
    result.auto_execute_reason ??
    (body && typeof body.diagnosis === 'object' && body.diagnosis !== null
      ? JSON.stringify(body.diagnosis)
      : 'execute_failed');
  // Pull the typed diagnosis.kind out so `rediscoverFailureGate` can read
  // the structural classification without re-parsing the stringified
  // `error` summary. Absent when the executor didn't run (auto_execute_reason
  // path) — the gate handles that by falling through to its rate-based
  // signal. `body.diagnosis` shape comes from `AutoExecDiagnosis` in
  // `runtime/src/execution/index.ts`.
  let diagnosisKind: string | undefined;
  if (body && typeof body.diagnosis === 'object' && body.diagnosis !== null) {
    const k = (body.diagnosis as { kind?: unknown }).kind;
    if (typeof k === 'string') diagnosisKind = k;
  }
  dispatch(session, {
    kind: 'execute_failed',
    payload: {
      platform,
      capability,
      error: errorSummary,
      result_classification: classification,
      ...(diagnosisKind ? { diagnosis_kind: diagnosisKind } : {}),
    },
  });
}

/**
 * Cap the `body` field of an in-flight `execute_result` to the agent-runtime
 * output budget. Three body shapes are handled, each preserving the agent's
 * primary decision signals (the surrounding `status`, top-level
 * `body.ok` as a `body_ok` sibling for object bodies, and `_hint` siblings):
 *
 *  - object body: JSON.stringify into a preview slice + sibling
 *    `body_preview` / `body_total_chars` / `body_truncated`; the original
 *    `body` value becomes a marker string.
 *  - string body: route through `sliceLargeString` for the preview slice; same
 *    sibling metadata pattern.
 *  - array body: keep the first N entries + sibling `body_total_entries` /
 *    `body_truncated_entries`; the original `body` value becomes a marker.
 *
 * Runs regardless of whether the strategy succeeded — a failed auto-exec may
 * still attach a huge `body.original_body` (raw response captured for
 * diagnosis) that needs the same cap.
 */
export function compactExecuteResultBody(er: Record<string, unknown>): void {
  const body = er.body;
  if (body === null || body === undefined) return;

  // Hoist _checkpoint to a sibling of body so it survives body truncation —
  // a mid-execute checkpoint (e.g. recorded_step_failed) must reach the agent
  // and downstream tooling even when the body is replaced by a marker string.
  if (typeof body === 'object' && !Array.isArray(body)) {
    const bodyObject = body as Record<string, unknown>;
    const cp = bodyObject._checkpoint;
    if (cp !== undefined && er._checkpoint === undefined) er._checkpoint = cp;
    if (typeof bodyObject.ok === 'boolean' && er.body_ok === undefined) {
      er.body_ok = bodyObject.ok;
    }
  }

  if (typeof body === 'string') {
    if (body.length <= MAX_TOOL_OUTPUT_CHARS / 2) return;
    const sliced = sliceLargeString(body, { defaultMaxLength: MAX_TOOL_OUTPUT_CHARS / 2 });
    er.body_preview = sliced.slice;
    er.body_total_chars = sliced.total_chars;
    er.body_truncated = true;
    er.body =
      `<truncated string body: ${sliced.total_chars} chars; first ${sliced.slice.length} in body_preview. ` +
      `Re-shape the strategy's response.extract to return structured fields instead of raw text.>`;
    return;
  }

  if (Array.isArray(body)) {
    const KEEP = 50;
    if (body.length <= KEEP) {
      // Small array — only worth compacting if its JSON cost is over budget
      // anyway (each entry could be a giant object).
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length <= MAX_TOOL_OUTPUT_CHARS / 2) return;
      const previewBudget = Math.floor(MAX_TOOL_OUTPUT_CHARS / 2);
      er.body_preview = bodyStr.slice(0, previewBudget);
      er.body_total_chars = bodyStr.length;
      er.body_truncated = true;
      er.body = `<truncated array body: ${body.length} entries, ${bodyStr.length} chars; first ${previewBudget} in body_preview.>`;
      return;
    }
    const kept = body.slice(0, KEEP);
    er.body = kept;
    er.body_total_entries = body.length;
    er.body_truncated_entries = true;
    return;
  }

  if (typeof body === 'object') {
    const bodyStr = JSON.stringify(body);
    if (bodyStr.length <= MAX_TOOL_OUTPUT_CHARS / 2) return;
    const previewBudget = Math.floor(MAX_TOOL_OUTPUT_CHARS / 2);
    er.body_preview = bodyStr.slice(0, previewBudget);
    er.body_total_chars = bodyStr.length;
    er.body_truncated = true;
    er.body =
      `<truncated: ${bodyStr.length} chars; first ${previewBudget} in body_preview. ` +
      `For a structured view of subsets, re-run via start_session(graph: "execute") and shape the body in the strategy itself.>`;
  }
}

function describeFactoryExecutionResult(
  classification: ReturnType<typeof classifyFactoryExecutionResult>,
  status: number,
): string {
  switch (classification) {
    case 'explicit_success':
      return `execute_result.body.ok === true — the local strategy explicitly reports success.`;
    case 'transport_accepted':
      return (
        `execute_result.status === ${status} (HTTP 2xx) — transport completed, but factory ` +
        `execution has no declared semantic outcome contract. Inspect execute_result.body before reporting success.`
      );
    case 'explicit_failure':
      return `execute_result.body.ok === false — the local strategy explicitly reports failure.`;
    case 'transport_failure':
    case 'not_run':
      return `execute_result.status === ${status} — transport did not complete successfully.`;
  }
}

export function applyAutoExecuteHint(
  result: StartSessionResult,
  session: { graph?: string; phase?: string; status?: string },
  opts: StartSessionOptions,
): void {
  if (result.executed === false && result.auto_execute_reason) {
    result._hint = `Auto-execute did NOT run (reason: ${result.auto_execute_reason}). You're on a fresh session; drive the flow yourself or call execute({platform, capability, args}) explicitly.`;
    return;
  }
  if (result.executed !== true || !result.execute_result) return;

  const er = result.execute_result;
  const tier = er.tier ?? 'unknown';
  const classification = classifyFactoryExecutionResult(er);
  const accepted = factoryExecutionWasAccepted(classification);
  const fired = (() => {
    if (!er.body || typeof er.body !== 'object') return [];
    const f = (er.body as { interrupts_fired?: unknown }).interrupts_fired;
    return Array.isArray(f) ? (f as string[]) : [];
  })();
  const firedNote =
    fired.length > 0 ? ` Interrupts fired: ${fired.map((n) => JSON.stringify(n)).join(', ')}.` : '';
  const resultNote = describeFactoryExecutionResult(classification, er.status);
  const head = `AUTO-EXECUTED the saved ${tier} strategy for ${opts.platform}/${opts.capability}.`;

  if (accepted && session.graph === 'execute') {
    // graph:'execute' + an accepted result → FSM is in terminal{closed}. A
    // transport-only result still requires the agent to interpret the body;
    // signed package outcome contracts are evaluated on the consumer path.
    result.session_terminal = true;
    if (classification === 'transport_accepted') {
      result._hint =
        `${head} ${resultNote}${firedNote}` +
        ` The execute session is terminal because the saved request completed. ` +
        `If the typed body represents a failure or partial result, do NOT report success; open a discovery session and repair the strategy. ` +
        `Otherwise call end_drive({session_id: "${result.sessionId}"}) and relay the body.`;
    } else {
      result._hint =
        `${head} ${resultNote}${firedNote}` +
        ` SESSION IS TERMINAL. The capability explicitly succeeded for this turn. ` +
        `Call end_drive({session_id: "${result.sessionId}"}) and relay the result. ` +
        `Re-discovery is appropriate only when a later execute_result explicitly fails.`;
    }
    return;
  }
  if (accepted) {
    // Non-execute graph (discover/map) auto-executed because args matched. A
    // transport-only body stays an agent judgment rather than a runtime claim.
    result._hint =
      `${head} ${resultNote}${firedNote}` +
      ` Inspect the body before deciding whether to end or repair; do not infer semantic success from HTTP status.`;
    return;
  }
  if (session.graph === 'execute' && session.phase === 'triage' && session.status !== 'failed') {
    result._hint =
      `${head} ${resultNote}${firedNote}` +
      ` SESSION REMAINS ACTIVE IN TRIAGE. Inspect the typed failure and the live page with read-only diagnostics; ` +
      `do not infer the cause from the application-defined code alone. Submit a surface-bound triage plan, then ` +
      `repair the saved fetch/page-script with update_strategy in lift (or use the recorded-step checkpoint flow when one is present).`;
    return;
  }
  if (session.graph === 'execute' && session.status === 'failed') {
    result.session_terminal = true;
    result._hint =
      `${head} ${resultNote}${firedNote}` +
      ` SESSION IS TERMINAL because the failure was not structurally classified as repairable in place. ` +
      `Follow any typed diagnosis or checkpoint in the response; otherwise open a discovery session to gather fresh evidence.`;
    return;
  }
  result._hint =
    `${head} ${resultNote}${firedNote}` +
    ` Inspect execute_result before driving the UI; if the saved strategy is broken, patch_step or ` +
    `save a new one rather than ad-hoc-redoing the flow.`;
}

function validatePlatformSlugShape(platform: string | undefined): void {
  if (platform === undefined || platform === '') return;
  try {
    asPlatformSlug(platform, 'platform');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `invalid_start_session: ${msg}. Pick a platform slug consistent with what ` +
        `record_observed_capability and save_strategy accept (kebab-case, lowercase letters / ` +
        `digits / dashes only). For multi-segment TLDs prefer collapsing dots/underscores to ` +
        `dashes, dropping a trailing \`.com\`, or staying single-token.`,
      { cause: e },
    );
  }
}

/** Fold capture journals left behind by sessions that never reached end_drive.
 *  Skips any still-live session so a concurrent writer is never folded
 *  mid-flight. Best-effort — recovery must never block a session start. */
function recoverOrphanedCaptureJournals(): void {
  try {
    recoverOrphanedJournals({ activeSessionIds: new Set(pool.activeSessionIds) });
  } catch {
    /* swallow */
  }
}

/**
 * Accessibility is contextual output, not the browser session's lifecycle
 * boundary. Keep a successfully-created, navigated session usable when both
 * the native snapshot and the driver's fallback fail; callers can still use
 * screenshots, targeted DOM reads, and js_eval against the live page.
 */
async function captureStartAccessibilityTree(
  driver: ReturnType<typeof pool.driverFor>,
  session: Session,
): Promise<string> {
  try {
    return await driver.getAccessibilityTree(session);
  } catch (error) {
    if (session.accessibilitySnapshot?.source !== 'unavailable') {
      const message = error instanceof Error ? error.message : String(error);
      session.accessibilitySnapshot = {
        source: 'unavailable',
        at: Date.now(),
        warning:
          `The accessibility snapshot failed, but the browser session is still live. ` +
          `Use get_screenshot, find_in_page, or js_eval to inspect the page. Failure: ${message}`,
      };
    }
    return '';
  }
}

function attachAccessibilitySnapshotDiagnostic(result: StartSessionResult, session: Session): void {
  const snapshot = session.accessibilitySnapshot;
  if (snapshot?.source !== 'static_dom' && snapshot?.source !== 'unavailable') return;
  result.a11y_snapshot = {
    source: snapshot.source,
    warning:
      snapshot.warning ?? 'The native accessibility snapshot was not available for this response.',
  };
}

function compactAutoExecuteA11y(result: StartSessionResult, session: Session): void {
  if (result.executed !== true || JSON.stringify(result).length <= MAX_TOOL_OUTPUT_CHARS) return;
  const a11yChars = result.a11y_total_chars;
  const classification = classifyFactoryExecutionResult(result.execute_result);
  const fetchHint = `Fetch the full ${a11yChars}-char tree via get_a11y_tree({session_id: "${session.id}", page: 1}) if you need it.`;
  switch (classification) {
    case 'explicit_success':
      result.a11yTree = `<dropped: auto-exec explicitly succeeded; the page UI isn't load-bearing here. ${fetchHint}>`;
      break;
    case 'transport_accepted':
      result.a11yTree = `<dropped: auto-exec transport completed; inspect execute_result.body for the semantic outcome. Page UI dropped for budget. ${fetchHint}>`;
      break;
    case 'explicit_failure':
    case 'transport_failure':
    case 'not_run':
      result.a11yTree = `<dropped: auto-exec ran but failed — read execute_result for the outcome. Page UI dropped for budget. ${fetchHint}>`;
      break;
  }
  result.a11y_truncated = true;
}

export async function startSession(
  url: string,
  opts: StartSessionOptions = {},
): Promise<StartSessionResult> {
  applyPermanentPolicyFromStart(opts);

  // Recover capture journals orphaned by a prior session that never reached
  // end_drive (max_turns, crash, SIGTERM). Event-driven: folding happens when
  // the next session opens, not on a timer.
  recoverOrphanedCaptureJournals();

  // Earliest possible slug-vs-args check: when the agent declares a
  // capability slug AND args together, the slug must not contain any of
  // the args' values as tokens. The slug names what the capability does
  // in the abstract; values are parameters. Catching this at
  // start_session means zero rounds wasted — the agent re-declares with
  // a clean slug before any drive begins. Same structural signal the
  // save-time `enum_value_baked_into_slug` detector runs, just earlier
  // in the lifecycle.
  if (opts.capability && opts.args && typeof opts.args === 'object') {
    const slugTokens = new Set(
      opts.capability
        .toLowerCase()
        .split(/[_\-/]/)
        .filter((t) => t.length > 0),
    );
    for (const [argName, argValue] of Object.entries(opts.args)) {
      if (typeof argValue !== 'string' || argValue.length < 3) continue;
      const valueLower = argValue.toLowerCase();
      if (slugTokens.has(valueLower)) {
        throw new Error(
          `invalid_start_session: capability slug "${opts.capability}" contains the token "${argValue}", ` +
            `which is also the value of arg "${argName}". The slug names what the capability does in the abstract — ` +
            `it must not bake one of its own parameter values. Saving this shape implies a parallel slug per value ` +
            `(e.g. one capability per ${argName}) when the right shape is a single capability that takes "${argName}" ` +
            `as a parameter. Re-call start_session with a slug that does not contain "${argValue}" — slugs are ` +
            `verb + noun in the abstract; parameter values live in args + notes.params, never in the slug itself.`,
        );
      }
    }
  }

  // Platform-slug shape validation. Without this, `start_session({platform:
  // "some_store_uk"})` succeeds at boot but the slug doesn't match
  // `asPlatformSlug` (kebab-only); downstream calls (record_observed_capability,
  // save_strategy) reject the same slug, so the session ends up writing
  // strategies under one slug while observations and prior on-disk skills
  // live under another — invisible to lift_observed_capability and to
  // list_platform_skills lookups. Reject at the edge instead.
  validatePlatformSlugShape(opts.platform);
  // Platform is required when capability is set. Saved strategies live under
  // <platform>/, storage state lives at storage-state/<platform>.json, and
  // every downstream lifecycle (auto-execute, synth, submit_triage_plan)
  // keys by platform. Accepting capability without platform leaves the
  // session unable to file the resulting strategy and unable to load prior
  // cookies — the agent drives the entire flow and end_drive accepts with
  // nothing to persist. Reject up-front; that's the only layer where this
  // rule fits cleanly.
  if (opts.capability && !opts.platform) {
    throw new Error(
      `invalid_start_session: capability "${opts.capability}" was declared without a platform. ` +
        `Platform keys the on-disk skill dir (\`~/.klura/skills/<platform>/...\`) and the storage-state file ` +
        `(\`~/.klura/storage-state/<platform>.json\`); without it, end_drive cannot save and cookies cannot ` +
        `be reloaded next session. Re-call start_session with \`platform: "<slug>"\`. Common pattern: ` +
        `platform = the second-level domain (e.g. \`acme\` for acme.com).`,
    );
  }

  // The daemon has exactly one device profile (see runtime/src/devices.ts).
  // Multi-device setups run multiple daemons with different KLURA_HOME.
  const deviceProfile = getDeviceProfile();

  // Validate the optional identity slug. The reserved string `"default"` is
  // rejected at the edge — omit the field instead. See
  // klura://reference#identities.
  const identity = normalizeIdentityOpt(opts.identity);

  // Execute-graph fast path. When the agent calls
  // start_session({graph:"execute", platform, capability, args}) AND a saved
  // strategy exists AND the strategy can run from Node alone (fetch tier,
  // node transport, no browser-bound prereqs), skip the entire browser
  // session lifecycle. The slow path opens a Playwright context, navigates
  // to `url`, captures forms, and snapshots the a11y tree — 5-15 s of
  // setup the agent doesn't use, because the data is in execute_result and
  // the session terminates immediately on success. The auth-probe branch
  // inside maybeAutoExecuteOnStart already swallows driverFor failures, so
  // the synthetic Session shell composes safely.
  if (canFastPathExecute(opts)) {
    return executeOnlyFastPath(opts, url, identity, deviceProfile);
  }

  const sessionOpts: SessionOptions = {};

  // Apply device profile settings
  if (deviceProfile.userAgent) sessionOpts.userAgent = deviceProfile.userAgent;
  sessionOpts.viewport = deviceProfile.viewport;
  if (deviceProfile.hasTouch) sessionOpts.hasTouch = true;
  if (deviceProfile.isMobile) sessionOpts.isMobile = true;
  if (deviceProfile.deviceScaleFactor)
    sessionOpts.deviceScaleFactor = deviceProfile.deviceScaleFactor;

  // Load (platform, identity)-scoped storage state (cookies). Default
  // identity (omitted) reads <platform>.json — historical path; named
  // identities read <platform>--<identity>.json.
  if (opts.platform) {
    const statePath = skills.loadStorageStatePath(opts.platform, identity);
    if (statePath) sessionOpts.storageState = statePath;
    // Pass platform + identity through so warm-pool implementations (local and
    // docker) can key cached backends by both. Pools that don't support warm
    // reuse ignore these fields.
    sessionOpts.platform = opts.platform;
    if (identity) sessionOpts.identity = identity;
  }
  if (opts.storageState) {
    sessionOpts.storageState = opts.storageState;
  }

  const session = await pool.createSession(sessionOpts);
  if (opts.platform) session.platform = opts.platform;
  if (identity) session.identity = identity;
  session.device = deviceProfile.name ?? 'default';
  // Stamp the active graph before the first driver action so the FSM
  // dispatcher and graph-config readers see it on the very first dispatch.
  session.graph = opts.graph ?? 'discover';
  session.status = 'active';
  if (opts.platform && opts.capability) {
    session.declaredCapabilities = [
      {
        capability: opts.capability,
        args: opts.args && typeof opts.args === 'object' ? opts.args : {},
        declared_at: Date.now(),
      },
    ];
  }
  const driver = pool.driverFor(session.id);
  await driver.navigate(session, url);
  // Stamp the landing URL as the session's last-seen surface so the first
  // perform_action's `isPathDistinct` check has a real prior to compare
  // against. Without this, the path-distinct check sees `undefined` and
  // returns true on every first action, spuriously firing surface_changed
  // and (in discover graph) bouncing the agent into TRIAGE before they've
  // done any real work.
  session.lastSurfaceUrl = url;

  // Record the initial navigation as a dom_navigation event (top-level nav).
  // Powers the platform_map url_graph — every URL the session visits is a
  // node, adjacent visits are edges.
  if (!session.domNavigations) session.domNavigations = [];
  session.domNavigations.push({ at: Date.now(), url, via: 'nav' });

  // Surface-map: snapshot every <form> in the landing-page DOM. Forms that
  // appear later via SPA route changes are captured by the per-action sweep
  // in performAction.
  await captureAndAppendForms(session, driver);

  const rawTree = await captureStartAccessibilityTree(driver, session);
  // `trimmed` + `currentUrl` may be re-snapped below if the initial
  // detection fires on a JS-challenge shape that auto-resolves.
  let trimmed = trimA11yTree(rawTree, DEFAULT_A11Y_BUDGET);
  let currentUrl = await driver.getUrl(session).catch(() => url);
  // Harvest page_link enum observations from the RAW tree (pre-trim, so link
  // tiles dropped by trimming still count). Lets the agent ground a category
  // enum from page-offered link targets without having to click each tile.
  harvestLinkUrlObservations(session.id, rawTree, currentUrl);
  session.extractedContentBytes = (session.extractedContentBytes ?? 0) + trimmed.tree.length;
  // Durability checkpoint: snapshot the initial landing captures to the session
  // journal so a crash before end_drive still recovers them. No-op on graphs
  // that don't journal (warm/execute).
  await checkpointCaptureJournal(session);
  let navStatus = readInitialNavStatus(session, url, currentUrl);
  const iframes: ReadonlyArray<{ src: string }> =
    typeof driver.listTopLevelIframes === 'function'
      ? await driver.listTopLevelIframes(session).catch(() => [])
      : [];
  let originBlocked = detectOriginBlocked({
    requestedUrl: url,
    finalUrl: currentUrl,
    navStatus,
    a11yTree: trimmed.tree,
    iframes,
    connectEnabled: pool.connectEnabled,
  });
  // Resolvable JS-challenge path: when the initial detection fires on a
  // structurally challenge-shaped page (cross-host vendor redirect +
  // iframe-only minimal a11y), the page MIGHT auto-resolve in a few
  // seconds (purely client-side bot checks run as in-page JS).
  // Wait briefly, re-snap a11y + url + status, re-run the detector.
  // If the challenge cleared, the advisory drops and the session
  // continues normally with the resolved page in hand. If it didn't
  // clear, the advisory stands.
  if (originBlocked && isResolvableChallengeShape(originBlocked, trimmed.tree, navStatus)) {
    await new Promise((r) => setTimeout(r, CHALLENGE_RESOLVE_WAIT_MS));
    const rawTreeAfter = await captureStartAccessibilityTree(driver, session);
    const trimmedAfter = trimA11yTree(rawTreeAfter, DEFAULT_A11Y_BUDGET);
    const currentUrlAfter = await driver.getUrl(session).catch(() => currentUrl);
    harvestLinkUrlObservations(session.id, rawTreeAfter, currentUrlAfter);
    const navStatusAfter = readInitialNavStatus(session, url, currentUrlAfter);
    const iframesAfter: ReadonlyArray<{ src: string }> =
      typeof driver.listTopLevelIframes === 'function'
        ? await driver.listTopLevelIframes(session).catch(() => [])
        : [];
    const advisoryAfter = detectOriginBlocked({
      requestedUrl: url,
      finalUrl: currentUrlAfter,
      navStatus: navStatusAfter,
      a11yTree: trimmedAfter.tree,
      iframes: iframesAfter,
      connectEnabled: pool.connectEnabled,
    });
    if (advisoryAfter === null) {
      // Challenge resolved — swap in the post-wait snapshot.
      session.extractedContentBytes =
        (session.extractedContentBytes ?? 0) + (trimmedAfter.tree.length - trimmed.tree.length);
      trimmed = trimmedAfter;
      currentUrl = currentUrlAfter;
      navStatus = navStatusAfter;
      originBlocked = null;
    } else {
      // Challenge didn't resolve. Keep the post-wait snapshot anyway
      // (it's at least no worse than the initial) and let the advisory
      // stand.
      session.extractedContentBytes =
        (session.extractedContentBytes ?? 0) + (trimmedAfter.tree.length - trimmed.tree.length);
      trimmed = trimmedAfter;
      currentUrl = currentUrlAfter;
      navStatus = navStatusAfter;
      originBlocked = advisoryAfter;
    }
  }
  // The requested URL is only an initial seed: redirects and in-page
  // navigation can change the landing URL before start_session returns.
  // Surface triage must bind the page the runtime actually observed.
  session.lastSurfaceUrl = currentUrl;
  const visibilityAnomalies = await snapVisibilityAnomalies(driver, session);
  const result: StartSessionResult = {
    sessionId: session.id,
    a11yTree: trimmed.tree,
    a11y_total_chars: trimmed.total_chars,
    a11y_truncated: trimmed.truncated,
    url: currentUrl,
    nav_status: navStatus,
    visibility_anomalies: visibilityAnomalies,
  };
  attachAccessibilitySnapshotDiagnostic(result, session);
  if (originBlocked) result.origin_blocked = originBlocked;
  if (opts.platform) populatePlatformResponseFields(result, opts.platform);
  result.graph = session.graph;
  // Mid-flow interruption behavior is plugin-orchestrated. Headless / CI
  // environments register priority-5 handlers (see
  // runtime/src/interruptions/) whose `continue` resolutions short-circuit
  // the runtime's ask-user / open-viewer defaults.
  await maybeAutoExecuteOnStart(session, opts, result);

  // When auto-exec succeeded, the agent doesn't need the page UI — the data
  // is in execute_result. The a11y tree + the result body together routinely
  // exceed MAX_TOOL_OUTPUT_CHARS for non-trivial APIs (a search API can
  // return ~38 KB of hits; a chat-send can return the whole conversation
  // page). Past the SDK's truncation threshold the harness sees a
  // `<persisted-output>` marker instead of the structured result, so
  // executed:true / execute_result.status are invisible to downstream
  // consumers (scoreWarmExecute, execute-succeeded predicates) and the agent
  // loses its primary signal. Drop the a11y tree first (recoverable via
  // get_a11y_tree(session_id)); if still oversized, compact the body too.
  // Aligns with principles.md §"Respect the MCP output budget".
  compactAutoExecuteA11y(result, session);
  // Body compaction runs regardless of `executed`-state — a failed auto-exec
  // can still carry a huge `body.original_body` (raw response captured for
  // diagnosis), and the a11y-drop above only fires on success. Replace
  // oversized body content with a budget-bounded preview + sibling metadata so
  // the agent's primary signals (`status`, hoisted `body_ok` for object bodies,
  // `_hint`) remain intact while the bulk is dropped. See
  // principles.md §"Respect the MCP output budget".
  if (result.execute_result) {
    compactExecuteResultBody(result.execute_result as unknown as Record<string, unknown>);
  }

  // Unmissable top-level hint: callers that pass capability+args are asking the
  // runtime to DO the capability. When a saved strategy exists it auto-executes
  // in-session; agents miss this 1 in 3 runs and re-drive the UI manually,
  // burning turns on a flow that already completed. Surface the outcome loudly,
  // at the top of the response.
  applyAutoExecuteHint(result, session, opts);

  // Existing-strategy advisory. When the agent opens a discover-mode session
  // for a (platform, capability) that already has a saved strategy on disk,
  // re-discovery is wasteful unless the saved strategy has actually failed.
  // Surface the saved tier and point to graph:'execute'. Doesn't refuse —
  // legitimate re-discovery (broken strategy, deliberate re-lift) just
  // ignores the advisory. Skipped when auto-execute already ran (the hint
  // above is sharper for that case).
  if (
    !result.executed &&
    opts.platform &&
    opts.capability &&
    (session.graph ?? 'discover') === 'discover'
  ) {
    const saved = skills.loadStrategy(opts.platform, opts.capability);
    if (saved) {
      const savedTier =
        (saved as { strategy?: string }).strategy ?? (saved as { type?: string }).type ?? 'unknown';
      result._existing_strategy_advisory = {
        platform: opts.platform,
        capability: opts.capability,
        saved_tier: savedTier,
        hint:
          `A saved ${savedTier} strategy already exists for ${opts.platform}/${opts.capability}. ` +
          `To run it, call start_session with graph:'execute' and the same args — the runtime fires ` +
          `the saved strategy directly, no UI walk needed. Re-discovery (this discover session) only ` +
          `pays off when execute_result explicitly fails or its typed body shows a semantic failure. If you're trying to ` +
          `"upgrade tier," remember: the saved tier was chosen for the actual signal source ` +
          `(e.g. page-script when the auth value lives in DOM-set meta tags). Driving the UI again ` +
          `to save a different tier is almost always wasted rounds.`,
      };
    }
  }

  // Warm-path advisory: agent passed `platform` but didn't ask the runtime to
  // execute (no capability + args). If the platform has saved strategies with
  // grounded enum params, surface them — without this, agents that called
  // list_platform_skills and saw the saved capability still re-drive the UI manually.
  if (opts.platform && !opts.capability && !result.executed) {
    const warm = collectWarmPathAvailable(opts.platform);
    if (warm) result._warm_path_available = warm;
  }

  const isDiscoveryMode = (session.graph ?? 'discover') === 'discover';
  // Task contract fires for EVERY discover-mode session with a declared
  // capability, regardless of whether the args look mutating. Without this,
  // read-only capabilities (list / search / feed) never see a reminder that
  // "deliver the answer" is only half of klura's contract — the other half is
  // saving a reusable strategy — and the agent's internal "task complete"
  // signal fires on the answer alone, leading to no-op end_drive retries
  // when LIFT fires. Surface user-policy cap when this capability is
  // ToS/compliance-capped. Agent-self-report history lives in the working-dir
  // logbook; read via get_platform_logbook, not via prior_decline on this
  // response.
  if (isDiscoveryMode && opts.capability && opts.platform) {
    const policyEntry = loadCapabilityPolicyFull(opts.platform, opts.capability);
    if (policyEntry?.max_strategy_tier === 'recorded-path') {
      result.prior_decline = {
        source: 'user_policy',
        max_strategy_tier: policyEntry.max_strategy_tier,
        ...(policyEntry.reason ? { reason: policyEntry.reason } : {}),
        is_stale: false,
        retry_hint: `This capability is capped at recorded-path by USER POLICY (source: policy.json) — permanent, does not auto-expire. RE mode will be skipped for this capability regardless of what evidence you find. Do not attempt to clear this cap; only the user/operator can, by editing ~/.klura/skills/${opts.platform}/policy.json or running \`klura policy clear ${opts.platform} ${opts.capability}\`.`,
      };
    }
  }

  if (isDiscoveryMode && opts.capability && !result.executed) {
    result.task_contract = {
      message:
        `klura sessions run in TWO phases. Internalize this now, before DRIVE ends and your "task complete" signal fires:\n\n` +
        `DRIVE (Drive Real Interactions, View Endpoints): deliver the user's answer. Clicks, reads, reports. Ends when you call end_drive.\n\n` +
        `LIFT (Learn Interface From Traffic): the user is satisfied and off reading your answer. Your new job is to save a reusable strategy for capability "${opts.capability}" so the next caller doesn't redo your work. end_drive refuses to tear down the session until LIFT resolves with save_strategy. If you're unsure whether a lift is possible, call get_platform_logbook first — it returns prior sessions' field_stability, signer_history, bundle_history, and the per-capability logbook so you see what earlier agents already discovered. Permanent ToS/compliance caps are user-owned via the CLI (klura policy set); MCP can only create policy at start_session when none exists, never mutate it later.\n\n` +
        `Declining LIFT is the infrastructure equivalent of never writing a test — the task works once for this user and costs everyone else ~30s re-discovery + 10-20 LLM rounds + rate-limit exposure on every subsequent invocation. Saving page-script once amortizes after 2 future calls and keeps paying off forever.\n\n` +
        `**Three shapes of backing, in preference order:**\n` +
        `  1. **XHR / WS backing** — captured JSON / binary requests carry the data. Lift to \`fetch\` (unsigned, CORS-open) or \`page-script\` (signed / anti-bot / rotating-token — page runs the signer). Most real-world capabilities land here, INCLUDING signed ones: "request can't replay from Node" = \`page-script\` with a js-eval prereq that calls the page's signer, NOT a recorded-path decline.\n` +
        `  2. **Server-rendered HTML in the initial document** — the posts / list / item details are already in the HTML the browser loaded (view-source: would show them, or the a11y tree carried the content after navigating to an arg-templated URL). Save as \`fetch\` with \`response: {format: "html", extract: {name: {selector, attr?, multiple?, fields?}}}\`. One HTTP call, ~100ms warm, no browser. See klura://reference#fetch-schema.\n` +
        `  3. **Genuinely DOM-only** — data only appears after multi-step client-side work (search-type-submit flows, scroll-to-load pagination that fires unique XHRs per scroll, JS-computed values with no HTML trace, consent-gated content that needs a human click). recorded-path replay.\n\n` +
        `"Server-rendered" and "HTML-only" are NOT synonyms for recorded-path. Check the initial document response in \`get_network_log\` before declining to recorded-path — if the content is there, save \`fetch\` + html-extract.\n\n` +
        `LIFT RHYTHM: after DRIVE, emit a quick triage turn ("worth lifting? rough rounds?"). Plow through every RE trick — inspect_ws_frame, try_generator iterations, js_eval probes, set_breakpoint + evaluate_on_frame, source-read. Rotating fields → template via js-eval prereqs that re-derive from the live page. The session ends LIFT when save_strategy lands a complete runnable strategy. Every save passes through the user_confirmation classifier (the user approves or rejects the proposed shape at save time, with strategy summary inlined in the prompt); rejection stays in the current phase, so keep working. end_drive keeps returning the same handoff until a save lands. Mid-work user-assistance asks ("mind sending another message to verify?" via trigger_reference_send with consent; "could you click X in the viewer?" as a text-only turn) are fine.\n\n` +
        `When end_drive returns phase:"lift", investigate or save before re-calling — repeat end_drive calls without intervening progress return the same refusal. Full playbook: klura://reference#reverse-engineer-playbook.`,
    };
  }
  // Well-known capability arg-shape hint (e.g. send_message → {recipient, text}).
  // Platform-missing is hard-rejected at the entry point above; this only
  // surfaces typos / dropped keys the slug implies.
  if (opts.capability) {
    const argHint = checkCapabilityArgs(opts.capability, opts.args);
    if (argHint) {
      result._hint = result._hint ? `${argHint}\n\n${result._hint}` : argHint;
    }
  }

  // Per-graph start hint. When the active graph defines `startSessionHint`,
  // surface it once per session — only when no higher-priority hint claimed
  // the slot upstream (auto-execute, declined start).
  if (!result._hint) {
    const hint = graphConfig(session).startSessionHint;
    if (hint) {
      result._hint = hint;
    }
  }

  // Drive-start contextual nudges. Fire structurally on signals already in
  // session state at this lifecycle edge (forms captured during the initial
  // navigation; discovery artifacts inlined above). Each detector is purely
  // semantic — input type / artifact presence — not prose matching, so the
  // nudges fire only when the page actually carries the shape they describe.
  // Agents in DRIVE need this once per session at most; never again. SKILL.md
  // stays terse — these are token-paid only when relevant. The pattern catalog
  // for contributors lives in runtime/docs/strategies.md (#common-capability-shapes).
  if (isDiscoveryMode && !result.executed) {
    const observedNames =
      result.platform_map?.observed_capabilities.map((c) => c.name) ?? ([] as string[]);
    const nudges = collectDriveStartNudges({
      forms: session.domFormsObserved ?? [],
      a11yTree: result.a11yTree,
      hasArtifacts: !!result.artifacts && Object.keys(result.artifacts).length > 0,
      artifacts: result.artifacts,
      observedCapabilityNames: observedNames,
    });
    if (nudges.length > 0) {
      const block = nudges.join(' ');
      result._hint = result._hint ? `${result._hint}\n\n${block}` : block;
    }
  }

  // DRIVE-time consent: when the user calls start_session with a declared
  // capability and args, those args ARE the user's consent. The runtime does
  // not inject a pre_action_consent interruption — asking the agent to
  // re-confirm what the user just typed is redundant friction (they already
  // told us to send X to Y). Consent gates live on the
  // genuinely-agent-initiated side-effects: `trigger_reference_send` in LIFT
  // (re-firing a submit during RE gates on a Level-3 token-gated consent flow —
  // first call returns a consent_token + checklist, second commits with
  // consent_answers incl. the user's own acknowledgement quote for Tier 2) and
  // `save_strategy`'s post-save validation handoff for mutating capabilities
  // (the validation call fires a second real request the user didn't ask for).

  return result;
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';

const graphModesList = GRAPH_MODES.map((g) => `"${g}"`).join(', ');
const startSessionDescription = `Start a klura session: open a browser and navigate to the given URL. Returns \`{sessionId, a11yTree, url, artifacts?, executed?, execute_result?, graph?}\`. The \`graph\` parameter selects one of: ${graphModesList}. **Default is "discover" — pick that for ANY user-driven request, including ones where the agent has to navigate around an unfamiliar site to find the right page.** "discover": drive→triage→lift→closed, the standard goal-directed reverse-engineering flow ending in a saved strategy. "map": drive→triage→lift→closed for deliberate platform onboarding with no single capability declared up front; record candidates with \`record_observed_capability\`, then enter a save cycle with \`lift_observed_capability\`. Map saves are pre-authorized, mutating actions retain consent gates, and close-time auto-synth is skipped. "execute": execute→triage→lift→closed (or terminal{failed}), runs a saved strategy and falls into triage on stale-strategy failure so the agent can re-plan and re-lift. When you pass \`{capability, args}\` and a complete saved strategy covers that capability, the runtime auto-runs the strategy in-session and returns \`executed: true\` with the result. Inspect \`execute_result.body\`: local factory execution treats an explicit boolean \`body.ok\` as authoritative, while HTTP 2xx without it proves transport acceptance only.`;

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.startSession,
  description: startSessionDescription,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to navigate to' },
      platform: {
        type: 'string',
        description:
          'Platform slug — keys the on-disk skill dir (`~/.klura/skills/<platform>/`) and storage-state file (`~/.klura/storage-state/<platform>.json`). REQUIRED when `capability` is set; optional in pure-exploration mode (no capability declared). Common pattern: second-level domain (e.g. `acme` for acme.com).',
      },
      capability: {
        type: 'string',
        description:
          'The capability slug being discovered or executed (e.g. "send_message"). Required for auto-execute and for auto-save at end_drive.',
      },
      args: {
        type: 'object',
        description:
          'Per-capability argument map: {paramName: literalValue}. These are the user-supplied values the agent will type (e.g. {text: "hello", recipient: "Bob"}). Used at auto-execute time to run the saved strategy, and at end_drive time to template captured traffic into a reusable strategy body.',
      },
      policy: {
        type: 'object',
        description:
          'Create permanent platform policy at session creation time. This is create-only: if policy.json already exists for the platform, start_session rejects rather than mutating it. Requires `platform`. Friendly aliases: `max_tier` / `max_strategy_tier` set the declared capability cap when `capability` is present, otherwise the platform default; `default_max_tier` / `default_max_strategy_tier` set the platform default. Tiers: "recorded-path", "page-script", "fetch". Per-capability entries may use `max_tier` or `max_strategy_tier`. After creation, policy is user-owned via CLI / policy.json, not MCP.',
        properties: {
          max_tier: {
            type: 'string',
            enum: ['recorded-path', 'page-script', 'fetch'],
            description:
              'Alias for max_strategy_tier. With `capability`, caps that capability; without it, sets the platform default.',
          },
          max_strategy_tier: {
            type: 'string',
            enum: ['recorded-path', 'page-script', 'fetch'],
            description:
              'With `capability`, caps that capability; without it, sets the platform default.',
          },
          default_max_tier: {
            type: 'string',
            enum: ['recorded-path', 'page-script', 'fetch'],
            description: 'Alias for default_max_strategy_tier.',
          },
          default_max_strategy_tier: {
            type: 'string',
            enum: ['recorded-path', 'page-script', 'fetch'],
          },
          reason: {
            type: 'string',
            description:
              'Optional audit reason stored when `max_tier` / `max_strategy_tier` creates a per-capability cap.',
          },
          per_capability: {
            type: 'object',
            description:
              'Per-capability caps, keyed by capability slug. Entry fields: max_tier/max_strategy_tier and optional reason.',
          },
          forbid_capabilities: { type: 'array', items: { type: 'string' } },
          throttle: { type: 'object' },
          respect_robots_txt: { type: 'boolean' },
          notes: { type: 'string' },
        },
      },
      graph: {
        type: 'string',
        enum: [...GRAPH_MODES],
        description:
          'Default: "discover". Pick "discover" for a specific user goal, even when reaching it requires unfamiliar navigation. Pick "map" for broad, user-authorized platform onboarding with no capability declared up front: explore in drive, record candidates with `record_observed_capability`, then call `lift_observed_capability` for triage + lift + save. Map saves are pre-authorized, mutating actions retain consent gates, auto-synth is skipped at close, and the re-persistence gate fires when ≥5 perform_actions land with zero persistence calls. "discover": drive→triage→lift→closed. "map": drive→triage→lift→closed. "execute": execute→triage→lift→closed (or terminal{failed}); runs a saved strategy and on stale-strategy failure transitions into triage with the failure as defense-surface input — arg/auth/structural failures terminate with status: failed.',
      },
      identity: {
        type: 'string',
        description:
          'Optional account name on `platform`. Default-when-omitted (or `"default"`) uses the historical platform-only cookie jar / profile — single-account behavior. Pass `"work"`, `"personal"`, etc. to scope cookies (`<platform>--<identity>.json`), the credential-autofill profile slot, and the warm-pool key so two accounts on the same platform never share state. Use this when the agent needs to "use account A and do X, use account B and do Y" in one conversation. See klura://reference#identities.',
      },
    },
    required: ['url'],
  },
  handler: (args: any) =>
    startSession(args.url, {
      platform: args.platform,
      capability: args.capability,
      args: args.args,
      policy: args.policy,
      graph: args.graph,
      identity: args.identity,
    }),
};
