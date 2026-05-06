import { pool, tokenCache } from '../runtime-state';
import * as skills from '../strategies/skills';
import { execute as executeStrategy } from '../execution';
import type { ExecuteResult } from '../execution/types';
import { pickProbeUrl, probeAuthState } from '../auth-probe';
import { classifyAutoExecDiagnosis } from '../execution';
import { invokeCheckpointAndGate } from '../checkpoints';
import { loadLogbook as loadLogbookForPlatform } from '../working-dir/logbook';
import {
  loadCapabilityPolicy as loadCapabilityPolicyFull,
  loadPolicy,
  policyExists,
  savePolicy,
  type PlatformPolicy,
  type StrategyTier,
} from '../strategies/policy';
import { buildPlatformMapSummary, type PlatformMapSummary } from '../response/platform-map-summary';
import { getDeviceProfile } from '../identity/devices';
import {
  readArtifactFromDisk,
  listArtifactsForPlatform,
  LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET,
  type DiscoveryArtifact,
} from '../strategies/discovery-artifact';
import {
  trimA11yTree,
  trimOversizedObjectBody,
  DEFAULT_A11Y_BUDGET,
} from '../response/response-size';
import type { Session, SessionOptions } from '../drivers/types/session';
import { graphConfig } from '../session-phase/registry';
import { dispatch } from '../session-phase/state-machine';
import { asIdentifierSlug, asObject, ValidationError } from '../validators';
import {
  captureAndAppendForms,
  inlineArtifactForResponse,
  NETWORKLOG_TRIM_HINT,
} from './_internals';
import { checkCapabilityArgs } from '../well-known-capabilities';

export const GRAPH_MODES = ['discover', 'map', 'execute'] as const;

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
   * call — fires after a graph:'execute' session whose saved strategy returned
   * ok. Capability is fully discharged for this turn; no LIFT, no audit, no
   * additional save. Agents should end their turn after relaying the result.
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
   * strategy) or call execute() directly. Without this nudge the runtime
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
  graph?: import('../session-phase/types').GraphName;
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
    throw new Error(`invalid_start_session: ${field} must be one of: ${POLICY_TIERS.join(', ')}`);
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
  }

  return nudges;
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
      `or call execute() directly. Match the user's free-text request against the observed_values' \`label\` field — ` +
      `\`value\` is the wire-format token the saved strategy expects.`,
  };
}

async function maybeAutoExecuteOnStart(
  session: Session,
  opts: StartSessionOptions,
  result: StartSessionResult,
): Promise<void> {
  if (opts.platform && opts.capability && opts.args) {
    const { platform, capability, args } = opts;
    const saved = skills.loadStrategies(platform, capability);
    if (saved.length === 0) {
      result.executed = false;
      result.auto_execute_reason = 'no_complete_saved_strategy';
      return;
    }

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
        // entries. See runtime/src/auto-execute-alias.ts.
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
      // redirect-follow) — see runtime/src/auth-probe.ts and principles.md
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
    return;
  }

  if (opts.capability && !opts.args) {
    result.executed = false;
    result.auto_execute_reason = 'args_required_to_auto_execute';
  }
  dispatchExecuteGraphOutcome(session, opts, result);
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
  // Success: explicit body.ok flag OR HTTP 2xx status. Same dual signal used by
  // the unmissable hint above — github's /_graphql returns {data, errors:[]}
  // without a top-level ok field, so body.ok alone misclassifies a successful
  // GraphQL mutation as failure (which then re-routes through the rediscover
  // gate and leaves the FSM in execute/triage instead of terminal{closed}).
  const okBody = body && body.ok === true;
  const okStatus = typeof er?.status === 'number' && er.status >= 200 && er.status < 300;
  const ok = okBody || okStatus;

  if (result.executed === true && ok) {
    dispatch(session, { kind: 'execute_succeeded' });
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
  // `runtime/src/execution.ts`.
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
      ...(diagnosisKind ? { diagnosis_kind: diagnosisKind } : {}),
    },
  });
}

function applyAutoExecuteHint(
  result: StartSessionResult,
  session: { graph?: string },
  opts: StartSessionOptions,
): void {
  if (result.executed === false && result.auto_execute_reason) {
    result._hint = `Auto-execute did NOT run (reason: ${result.auto_execute_reason}). You're on a fresh session; drive the flow yourself or call execute({platform, capability, args}) explicitly.`;
    return;
  }
  if (result.executed !== true || !result.execute_result) return;

  const er = result.execute_result;
  const tier = er.tier ?? 'unknown';
  // Success signal for the unmissable hint. Two complementary checks:
  //   - body.ok === true: explicit success flag from websocket sends and
  //     strategies that wrap their response in {ok, ...}.
  //   - HTTP 2xx status: covers raw page-script/fetch responses (GraphQL,
  //     REST, etc.) whose body shape is the server's, not klura's. github's
  //     /_graphql returns {data, errors:[]} with no top-level ok — body.ok
  //     alone misclassifies that as a partial failure.
  // Either signal counts as "the request landed and the server accepted it."
  const okBody = Boolean(
    er.body && typeof er.body === 'object' && (er.body as { ok?: unknown }).ok === true,
  );
  const okStatus = er.status >= 200 && er.status < 300;
  const ok: boolean = okBody || okStatus;
  const fired = (() => {
    if (!er.body || typeof er.body !== 'object') return [];
    const f = (er.body as { interrupts_fired?: unknown }).interrupts_fired;
    return Array.isArray(f) ? (f as string[]) : [];
  })();
  const firedNote =
    fired.length > 0 ? ` Interrupts fired: ${fired.map((n) => JSON.stringify(n)).join(', ')}.` : '';
  const successNote = okBody
    ? `execute_result.body.ok === true — the strategy claims success.`
    : `execute_result.status === ${er.status} (HTTP 2xx) — the request landed and the server accepted it.`;
  const head = `AUTO-EXECUTED the saved ${tier} strategy for ${opts.platform}/${opts.capability}.`;

  if (ok && session.graph === 'execute') {
    // graph:'execute' + saved-strategy ok → FSM is in terminal{closed}.
    // Capability is fully discharged for this turn. Agent should call
    // end_drive and end the turn — no LIFT, no save, no re-drive.
    result.session_terminal = true;
    result._hint =
      `${head} ${successNote}${firedNote}` +
      ` SESSION IS TERMINAL. The capability is fully discharged for this turn. ` +
      `Call end_drive({session_id: "${result.sessionId}"}) and end your text turn — that's it. ` +
      `Do NOT open another start_session for ${opts.platform}/${opts.capability}. ` +
      `Do NOT call save_strategy — a working strategy already exists on disk. ` +
      `Do NOT attempt to "lift to a better tier" — the saved tier was chosen for the actual signal source ` +
      `(e.g. page-script when the auth signal lives in a meta tag set by JS). Re-discovery is only ` +
      `appropriate when execute_result indicates a real failure on a future call.`;
    return;
  }
  if (ok) {
    // Non-execute graph (discover/map) auto-executed because args matched.
    // Strategy succeeded but the session is still in DRIVE.
    result._hint =
      `${head} ${successNote}${firedNote}` +
      ` Do NOT re-drive the UI manually unless the execute_result indicates failure — if the on-screen ` +
      `state looks wrong despite a successful execute, the saved strategy has a bug; fix it via patch_step ` +
      `or save a new one, don't ad-hoc-redo the flow.`;
    return;
  }
  result._hint =
    `${head} execute_result.body.ok is NOT true — the strategy may have partially failed.${firedNote}` +
    ` Inspect execute_result before driving the UI; if the saved strategy is broken, patch_step or ` +
    `save a new one rather than ad-hoc-redoing the flow.`;
}

/**
 * Reject `graph: "map"` + `capability` at the edge. Map's topology is
 * `drive → terminal{closed}` — there is no triage or lift phase, so a
 * declared capability has nowhere to land a saved strategy. Without this
 * rejection, end_drive ends up writing session.lift bookkeeping out-of-band
 * for a graph that doesn't have lift, and the next currentPhase() call hits
 * the half-init invariant.
 */
function rejectMapWithCapability(opts: StartSessionOptions): void {
  if (!opts.capability || opts.graph !== 'map') return;
  throw new Error(
    `invalid_start_session: capability "${opts.capability}" cannot be declared on a \`graph: "map"\` session. ` +
      `Map mode is for surface-mapping a platform you'll return to (no specific user goal); its FSM topology has no ` +
      `lift phase, so a declared capability has nowhere to land a saved strategy. For ANY goal-directed flow — ` +
      `including ones where the agent has to navigate around the site to find the right page — pass ` +
      `\`graph: "discover"\` (the default; you can omit it). Pure platform mapping (no capability) stays on map.`,
  );
}

export async function startSession(
  url: string,
  opts: StartSessionOptions = {},
): Promise<StartSessionResult> {
  applyPermanentPolicyFromStart(opts);

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

  rejectMapWithCapability(opts);

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
        `platform = the second-level domain (\`messenger\` for messenger.com, \`reddit\` for reddit.com).`,
    );
  }

  // The daemon has exactly one device profile (see runtime/src/devices.ts).
  // Multi-device setups run multiple daemons with different KLURA_HOME.
  const deviceProfile = getDeviceProfile();

  // Validate the optional identity slug. The reserved string `"default"` is
  // rejected at the edge — omit the field instead. See
  // klura://reference#identities.
  const identity = normalizeIdentityOpt(opts.identity);

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

  const rawTree = await driver.getAccessibilityTree(session);
  const trimmed = trimA11yTree(rawTree, DEFAULT_A11Y_BUDGET);
  const currentUrl = await driver.getUrl(session).catch(() => url);
  session.extractedContentBytes = (session.extractedContentBytes ?? 0) + trimmed.tree.length;
  const result: StartSessionResult = {
    sessionId: session.id,
    a11yTree: trimmed.tree,
    a11y_total_chars: trimmed.total_chars,
    a11y_truncated: trimmed.truncated,
    url: currentUrl,
  };
  // Inline prior-session discovery artifacts for this platform so the agent
  // sees the handoff at turn 0 without an extra tool call.
  if (opts.platform) {
    const caps = listArtifactsForPlatform(opts.platform);
    if (caps.length > 0) {
      const artifacts: NonNullable<StartSessionResult['artifacts']> = {};
      for (const cap of caps) {
        const a = readArtifactFromDisk(opts.platform, cap);
        if (a)
          artifacts[cap] = inlineArtifactForResponse(
            opts.platform,
            cap,
            a,
            LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET,
          );
      }
      if (Object.keys(artifacts).length > 0) result.artifacts = artifacts;
    }
    // Cross-session surface map teaser. Reads the platform logbook and
    // condenses observed_capabilities + url_graph + forms_seen counts into
    // a compact pointer to `get_platform_logbook`. Independent of the
    // discovery-artifact handoff above — observed-only platforms still get
    // a summary even when no per-capability artifact exists.
    const map = buildPlatformMapSummary(opts.platform);
    if (map) result.platform_map = map;
  }
  result.graph = session.graph;
  // Mid-flow interruption behavior is plugin-orchestrated. Headless / CI
  // environments register priority-5 handlers (see
  // runtime/src/interruptions/) whose `continue` resolutions short-circuit
  // the runtime's ask-user / open-viewer defaults.
  await maybeAutoExecuteOnStart(session, opts, result);

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
          `pays off when execute_result.body.ok comes back false on a real call. If you're trying to ` +
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
    const nudges = collectDriveStartNudges({
      forms: session.domFormsObserved ?? [],
      a11yTree: result.a11yTree,
      hasArtifacts: !!result.artifacts && Object.keys(result.artifacts).length > 0,
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
import type { ToolDef } from '../tool-types';

const graphModesList = GRAPH_MODES.map((g) => `"${g}"`).join(', ');
const startSessionDescription = `Start a klura session: open a browser and navigate to the given URL. Returns \`{sessionId, a11yTree, url, artifacts?, executed?, execute_result?, graph?}\`. The \`graph\` parameter selects one of: ${graphModesList}. **Default is "discover" — pick that for ANY user-driven request, including ones where the agent has to navigate around an unfamiliar site to find the right page.** "discover": drive→triage→lift→closed, the standard goal-directed reverse-engineering flow ending in a saved strategy. "map": drive→closed, **only for deliberate platform onboarding with no specific user goal** (e.g. "walk this site so future sessions can use it") — has no triage/lift phase and rejects \`capability\` declarations; mutating-action consent gates and skipped auto-synth. "execute": execute→triage→lift→closed (or terminal{failed}), runs a saved strategy and falls into triage on stale-strategy failure so the agent can re-plan and re-lift. When you pass \`{capability, args}\` and a complete saved strategy covers that capability, the runtime auto-runs the strategy in-session and returns \`executed: true\` with the result — call end_drive and you are done.`;

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
          'Platform slug — keys the on-disk skill dir (`~/.klura/skills/<platform>/`) and storage-state file (`~/.klura/storage-state/<platform>.json`). REQUIRED when `capability` is set; optional in pure-exploration mode (no capability declared). Common pattern: second-level domain (`messenger` for messenger.com, `reddit` for reddit.com).',
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
          'Default: "discover". **Pick "discover" for any user-driven request, even ones requiring navigation through an unfamiliar site to find the right page** — the goal-directedness is what matters, not whether the path is known. "map" is ONLY for deliberate platform onboarding with no user goal in flight; declaring a `capability` on a `map` session is rejected (map has no lift phase). "discover": drive→triage→lift→closed. "map": drive→closed; mutating actions gate on a one-time session-wide consent checkpoint, auto-synth is skipped at close, the re-persistence gate fires when ≥5 perform_actions land with zero persistence calls. "execute": execute→triage→lift→closed (or terminal{failed}); runs a saved strategy and on stale-strategy failure transitions into triage with the failure as defense-surface input — arg/auth/structural failures terminate with status: failed.',
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
