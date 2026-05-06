import fs from 'fs';
import path from 'path';
import type { GeneratorEntry } from './generators';
import { isTierAllowed, isCapabilityForbidden } from './policy';
import { stampTier, type TierStamp } from '../lift/telemetry';
import { asPlatformSlug, asIdentifierSlug, asEnum, ValidationError } from '../validators';

import { KLURA_DIR, SKILLS_DIR, WORKDIR_DIR } from '../paths';
import { appendStrategyEvent } from '../working-dir/logbook';
import { readPlatformSkillInfo } from './skills-list-helpers';
export { KLURA_DIR, SKILLS_DIR };

// Shape / prereq / placeholder validators live in ./validate; gate consumers
// (save-audit, save-warnings) live in ../gate. saveStrategy below chains them
// under a try/accumulate wrapper.
import {
  setTryGeneratorStatsProvider,
  getTryGeneratorStatsForSession,
  setDeclaredArgsProvider,
  setCapturedRequestsProvider,
  setTypedValuesProvider,
  validateStrategyShape,
  validateNoOpaqueUserParams,
  validateNoSelectorSelfReference,
  validatePlaceholderReferences,
  JS_EVAL_TIMEOUT_HARD_CAP_MS,
  JS_EVAL_TIMEOUT_DEFAULT_MS,
} from './validate';
import { type AuditAnswers } from '../gate';
// audit/save-strategy is lazy-required inside saveStrategy() below — see the
// load-time comment there. Pulling it eagerly creates a require cycle that
// trips runtime-state's eager singletons (TokenCache / ListenerManager).
export {
  setTryGeneratorStatsProvider,
  getTryGeneratorStatsForSession,
  setDeclaredArgsProvider,
  setCapturedRequestsProvider,
  setTypedValuesProvider,
  validateStrategyShape,
  validateNoOpaqueUserParams,
  validateNoSelectorSelfReference,
  validatePlaceholderReferences,
  JS_EVAL_TIMEOUT_HARD_CAP_MS,
  JS_EVAL_TIMEOUT_DEFAULT_MS,
};
export type { AuditAnswers } from '../gate';

// Per-parameter documentation. The LLM writes this on discovery and the runtime
// echoes it back verbatim in execute() error bodies so the LLM can diagnose
// shape mismatches without re-discovering. Runtime never validates or enforces
// `kind` — it's purely informational context for the agent.
export interface ParamDoc {
  description: string;
  // Loose enum — the runtime treats it as opaque. Common values for
  // tab-complete but the LLM can write a novel kind and nothing breaks.
  kind?: 'id' | 'slug' | 'email' | 'url' | 'uuid' | 'enum' | 'text';
  // Where the value comes from: "identities.<platform>.username", "URL slug",
  // "response.id from GET /api/users", free-form prose, etc.
  source?: string;
  // A concrete example value. Crucial — one real-looking example does more for
  // the LLM's shape-spotting than any prose description.
  example?: string;
}

// Strict allowlist of top-level keys under `notes`. Free-text containers became
// the cover-story escape hatch when every other guard tightened — the agent's
// impulse is to justify a save, and any object-shaped sub-key under notes
// accepted that justification. Locking this down keeps the notes slot narrow;
// observed-capability pointers now live on the platform logbook (see
// `recordObservedCapability` in working-dir/logbook).

export interface StrategyNotes {
  /**
   * Per-parameter documentation. Either a plain description string (legacy) or
   * a structured ParamDoc. Runtime never validates against this — it's echoed
   * back in execute() error bodies so the LLM can diagnose shape mismatches
   * without re-discovering.
   */
  params?: Record<string, string | ParamDoc>;
  /**
   * Durability classification for `page-script` strategies. The agent declares
   * where the script's anchor lives; triage + revisit-prompt use this to decide
   * whether a saved page-script is at ceiling or should be revisited for a
   * more-durable anchor.
   *
   *   module    — calls a module the page also calls (signer, transport
   *               client, task builder). Survives UI refactors.
   *   protocol  — builds a wire-level payload + hands it to a durable
   *               sender. Survives UI + module-rename refactors.
   *   dom       — walks DOM/fiber, depends on rendered components.
   *               Breaks on UI refactors.
   *   unknown   — agent didn't classify. Treated like dom for revisit.
   *
   * Other tiers ignore this field (no anchor choice to make).
   */
  anchor_type?: 'module' | 'protocol' | 'dom' | 'unknown';
  /**
   * Example responses from THIS session, included so future agents
   * reading `list_platform_skills` can preview what executing this
   * capability actually returns — and decide whether to reuse the
   * existing slug vs invent a new one. Provide 1–2 entries when you
   * have a captured response; omit when there's nothing to show
   * (recorded-path with side-effect-only steps, write APIs that return
   * `{ok: true}` etc.).
   *
   * **READ THIS BEFORE YOU SAVE — REDACT PII.**
   *
   * The saved strategy file ships across users. It will be read by
   * agents in other sessions, possibly other operators. Anything you
   * paste here is durable. **You are the only redactor — there is no
   * runtime regex backstop**, because a regex can't tell a legitimate
   * required field (a `from_email` template parameter, a `support_phone`
   * contact lookup, a structural ID that happens to look like an SSN)
   * from a leaked user record. The runtime trusts your judgment.
   *
   * REPLACE WITH PLACEHOLDERS, do not delete (preserve response shape):
   *   - personal names           → `"<redacted_name>"`
   *   - emails                   → `"<redacted_email>"`
   *   - phone numbers            → `"<redacted_phone>"`
   *   - addresses (street/city)  → `"<redacted_address>"`
   *   - government IDs (SSN, NI) → `"<redacted_id>"`
   *   - payment numbers (card)   → `"<redacted_payment>"`
   *   - live API keys / tokens   → `"<redacted_secret>"`
   *   - any per-user ID that uniquely identifies a person → `"<redacted_user_id>"`
   *
   * KEEP (structural / non-identifying):
   *   - response shape (object keys, array indices)
   *   - enum values, status codes, ratings, counts
   *   - public slugs, ISO timestamps, version strings
   *   - free-text content that would be the same for any user
   *     (restaurant names, public product names, news headlines, etc.)
   *
   * If unsure, redact. Naming the field is enough for the next agent
   * to understand the shape — they don't need the value. */
  example_responses?: Array<{
    /** Args used when the captured response was produced. */
    request_args?: Record<string, unknown>;
    /** Excerpt of the response body, **PII-redacted by you per the
     *  rules above**. JSON-shaped (preserves the response structure
     *  for the agent to introspect) or string (for HTML / text bodies). */
    response_excerpt?: unknown;
    /** One-line note describing what you redacted, e.g. "redacted email
     *  and user_id fields; left restaurant names and ratings intact". */
    redaction_summary?: string;
  }>;
}

// Current schema version. Bump when the strategy file format changes.
// Migrations run automatically on load — see migrateStrategy().
export const SCHEMA_VERSION = 1;

/**
 * Runtime-stamped metadata, owned end-to-end by the runtime. Agents read
 * these via `list_platform_skills` / `get_strategy` but must never emit
 * them on `save_strategy` — see `rejectAgentEmittedRuntimeMeta`.
 */
export interface RuntimeMeta {
  /**
   * Best-effort full URL (`location.href`) the session was on when the marker
   * XHR fired at capture time. Lets a later session try opening the same URL
   * directly instead of re-discovering from the root.
   */
  discovered_from_url?: string;
  /**
   * Slug id of the recorded-path step that was live when the marker XHR (or
   * first capture) fired. The revisit-fallback ladder in `execute()` uses
   * this as the partial-replay anchor: when the primary fetch / page-script
   * strategy misses, the runtime partial-replays a sibling recorded-path up
   * to (and including) this step, then retries the primary.
   */
  discovered_at_step_id?: string;
  /** Audit advisories the runtime emitted at save time — see `persistWarningsOnRuntimeMeta`. */
  save_warnings?: Array<{ kind: string; message: string; hint?: string }>;
  /** Reason the save-time probe demoted a fetch strategy to page-script. */
  tier_demote_reason?: string;
  /** Soft warnings the save-time probe accumulated (e.g. login-wall redirects). */
  probe_warnings?: string[];
}

export interface Strategy {
  schema_version?: number;
  strategy: 'fetch' | 'page-script' | 'recorded-path';
  notes?: StrategyNotes;
  runtime_meta?: RuntimeMeta;
  generated?: Record<string, GeneratorEntry>;
  tier_stamp?: TierStamp;
  /**
   * Optional return-value caching hint. When set, the runtime memoizes
   * successful execute() results for the `(platform, identity, capability,
   * args)` tuple for `ttl` (e.g. `"5m"`, `"30s"`, `"1h"`). Use for stable
   * lookups (`search_contact`, `whoami`, `list_channels`) that don't change
   * within a user's session. NEVER set this on writes — `send_message`,
   * `place_order`, anything that mutates state — caching a write would
   * silently drop the user's second call. See klura://reference#capability-cache.
   */
  cache?: { ttl: string };
  /**
   * Tags this capability fulfills. Other capabilities depend on this one via
   * `{kind: "tag", tag: "<tag>"}` prereqs — the typed-edge alternative to
   * matching by slug. Canonical tag: `"auth"` for login flows. Multiple
   * capabilities on the same platform can advertise the same tag (e.g. both
   * `login_password` and `login_gmail` declaring `provides: ["auth"]`); when
   * a tag prereq resolves to multiple providers the agent disambiguates by
   * switching to `{kind: "capability", capability: "<slug>"}`. See
   * klura://reference#tag-prereq.
   */
  provides?: string[];
  [key: string]: unknown;
}

// Strategy type → on-disk subdirectory. Each type gets its own folder so a
// `fetch` and a `page-script` for the same capability can coexist.
const SUBDIR_MAP: Record<string, string> = {
  fetch: 'fetch',
  'page-script': 'scripts',
  'recorded-path': 'paths',
};

const STRATEGY_TYPES = ['fetch', 'page-script', 'recorded-path'] as const;

const SUBDIRS = ['fetch', 'scripts', 'paths'] as const;

export interface StrategyInfo {
  type: string;
}

export interface ObservedCapabilitySummary {
  name: string;
  why_not_lifted: string;
  observed_in_sessions: number;
  last_observed_at: string;
}

export interface CapabilityInfo {
  name: string;
  strategies: StrategyInfo[];
  /**
   * Parameter shape from `notes.params` of the highest-tier saved strategy.
   * Lets callers preflight `execute()` args without guessing — the difference
   * between `{repo: "org/name"}` and `{owner: "org", repo: "name"}` is the
   * difference between an instant working call and a 30-second selector-timeout
   * blocker. Merged from whichever strategy file has the richest `notes.params`
   * so clients see the full shape regardless of which tier they target.
   */
  params?: Record<
    string,
    | string
    | {
        description?: string;
        kind?: string;
        example?: string;
        source?: string;
        /** When `kind === "enum"`, the catalog of valid values + labels.
         *  Auto-snapshotted at save time from session observations
         *  (click→XHR pairs, URL-variance visits) so the agent reading
         *  list_platform_skills sees what the enum accepts immediately —
         *  no second tool call to chase the source-capability indirection,
         *  no value hallucination from prompt text. Capped to a small
         *  budget for listing-surface compactness; the dynamic
         *  `source: capability:...` resolver still fires for fresh values
         *  at execute time. */
        observed_values?: Array<{ value: string; label?: string }>;
      }
  >;
  /**
   * One-line at-a-glance signature of what this capability does, derived
   * from the highest-tier saved strategy. Format: `<METHOD> <full URL>`
   * for fetch / page-script (`GET http://api.example.com/v1/list`), or
   * `recorded-path (<step count> steps)` for recorded tier. Lets callers
   * map "user wants X" to an existing capability without parsing strategy
   * notes — same role as `params`, on the endpoint axis. The presence of
   * a clean signature is what stops verb-translation hallucinations
   * (`list_top_restaurants` invented for an existing `find_top_restaurants`).
   */
  signature?: string;
  /**
   * Compact preview of the first `notes.example_responses[].response_excerpt`
   * — what the capability actually returns when executed. Byte-capped at
   * EXAMPLE_PREVIEW_BUDGET so the listing stays under the MCP output
   * budget on platforms with many capabilities. Full body lives on the
   * saved strategy and is read via `get_strategy`.
   */
  example_response_preview?: string;
  /**
   * Save-time advisories the runtime attached to any saved strategy for this
   * capability. Flat union across tiers, deduped by kind+message. Surfaced at
   * the CapabilityInfo level (not nested inside each strategy) so agents
   * listing skills see the warnings without parsing nested strategy objects.
   * Treat any entry here as "this skill works but won't generalise / may break
   * at warm execute — fix before the next run adds saved cycles to a brittle
   * strategy."
   */
  save_warnings?: Array<{ kind: string; message: string; hint?: string }>;
}

export interface SkillInfo {
  platform: string;
  capabilities: CapabilityInfo[];
  /**
   * Companion capabilities the agent observed across prior sessions but didn't
   * lift to their own strategy. Read from the platform logbook's
   * `observed_capabilities[]` slot (not per-strategy notes).
   */
  observed_capabilities?: ObservedCapabilitySummary[];
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Run any necessary migrations on a loaded strategy. Each migration transforms
 * from version N to N+1. Returns the (possibly mutated) strategy at
 * SCHEMA_VERSION.
 */
function migrateStrategy(data: Strategy, filePath: string): Strategy {
  const version = data.schema_version ?? 0;
  if (version >= SCHEMA_VERSION) return data;

  // Migration 0 → 1: stamp schema_version (no structural changes)
  if (version < 1) {
    data.schema_version = 1;
  }

  // Write back migrated strategy so we only migrate once
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch {
    // Best-effort — don't fail on write error
  }
  return data;
}

export interface SaveAuditInput {
  token?: string;
  answers?: AuditAnswers;
  // List of captured endpoints from this session that the agent has NOT
  // lifted into a saved strategy, prereq, or sibling capability. Caller
  // (typically index.ts save wrapper) computes this from the session's
  // interceptedRequests; empty list skips audit axis C.
  observedSiblings?: Array<{ method: string; url: string; key: string }>;
  // Per-param observations gathered during the session (UI click → XHR
  // correlation). Keyed by param name. Feeds the enum-param consistency
  // check in the pre-save audit: when the agent declares
  // `notes.params[X].kind === "enum"` with `observed_values`, every entry
  // must be present here. Empty map / missing key → enum params must use
  // Path B (`source: "capability:<slug>"`).
  observedParamValues?: Record<
    string,
    import('../response/session-observations').ParamObservation[]
  >;
  /** All endpoint origin+pathname pairs captured in the session. Fed by
   *  the save wrapper from `driver.getInterceptedRequests`. Used by the
   *  lookup-as-capability audit check: a prereq that hits a captured
   *  endpoint on a _by_/_for_/_lookup_ capability must be saved as a
   *  sibling and chained via {kind: "capability"}, not inlined. */
  capturedEndpointPaths?: Set<string>;
  /** All URLs observed during discovery (network-log XHR/fetch + top-level
   *  document navigations). Used by the audit's `unobserved_url` Detector
   *  (`ackReason: 'none'`) to reject saves whose URL wasn't seen — agent
   *  recalled from training data instead. Per principles.md §"Observe,
   *  not probe", runtime-enforced. */
  observedUrls?: readonly string[];
  /** Live session — used by the audit's `observed_property_keys` Detector
   *  to read the per-session observation trace for provenance checking
   *  baked property-access keys in expression bodies. Null for programmatic
   *  saves (tests, auto-synth). */
  session?: import('../drivers/types/session').Session | null;
}

/** Cap on how many observed values to snapshot per enum param at save
 *  time. Listing surfaces stay compact under the MCP budget; values
 *  beyond this count are still resolvable dynamically via
 *  `source: capability:list_<entity>`. */
const ENUM_SNAPSHOT_BUDGET = 24;

/** Walk the strategy's `notes.params`, find any enum-shaped param, and
 *  merge values observed by the session (click→XHR pairs, URL-variance
 *  visits) into `observed_values`. Idempotent: doesn't duplicate values
 *  the agent already declared. Skips when there are no session
 *  observations for the param's URL-key. */
function snapshotEnumObservationsIntoSave(data: Strategy, sessionId: string): void {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return;
  let allObs: Record<string, unknown[]> | null = null;
  for (const [placeholder, info] of Object.entries(params)) {
    if (!info || typeof info !== 'object') continue;
    const i = info as { kind?: unknown; observed_values?: unknown };
    if (i.kind !== 'enum') continue;

    // The session observation index is keyed by URL-param name. Map the
    // strategy's placeholder to its URL-param via the endpoint:
    // `?<urlParam>={{<placeholder>}}`. Fall back to the placeholder name
    // when no mapping is found (the common case where placeholder ===
    // url-param).
    const urlParam = findUrlParamForPlaceholder(data, placeholder) ?? placeholder;
    if (allObs === null) {
      try {
        // Lazy import to avoid a top-level circular dep.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../response/session-observations') as {
          getAllParamObservations: (id: string) => Record<string, unknown[]>;
        };
        allObs = mod.getAllParamObservations(sessionId);
      } catch {
        allObs = {};
      }
    }
    const obs = allObs[urlParam];
    if (!Array.isArray(obs) || obs.length === 0) continue;

    const existing = Array.isArray(i.observed_values)
      ? (i.observed_values as Array<{ value?: unknown; label?: unknown }>)
      : [];
    const seen = new Set<string>();
    const merged: Array<{ value: string; label?: string }> = [];
    for (const entry of existing) {
      if (typeof entry !== 'object') continue;
      const value = entry.value;
      if (typeof value !== 'string' || seen.has(value)) continue;
      seen.add(value);
      const label = entry.label;
      merged.push(typeof label === 'string' ? { value, label } : { value });
    }
    for (const o of obs) {
      if (!o || typeof o !== 'object') continue;
      const v = (o as { value?: unknown }).value;
      if (typeof v !== 'string' || seen.has(v)) continue;
      seen.add(v);
      const labelRaw = (o as { source?: { label?: unknown } }).source?.label;
      const label = typeof labelRaw === 'string' ? labelRaw : undefined;
      merged.push(label ? { value: v, label } : { value: v });
      if (merged.length >= ENUM_SNAPSHOT_BUDGET) break;
    }
    if (merged.length === 0) continue;
    (info as { observed_values?: unknown }).observed_values = merged;
  }
}

/** Given a strategy's endpoint, find the URL-param key bound to a given
 *  `{{placeholder}}`. e.g. `/api/restaurants?category={{cuisine}}` →
 *  placeholder "cuisine" maps to url-param "category". Returns null when
 *  the placeholder isn't templated into a URL-param slot (e.g. body
 *  template, header). */
function findUrlParamForPlaceholder(data: Strategy, placeholder: string): string | null {
  const baseUrl = (data as { baseUrl?: unknown }).baseUrl;
  const endpoint = (data as { endpoint?: unknown }).endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return null;
  let urlString = endpoint;
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    try {
      urlString = new URL(endpoint, baseUrl).toString();
    } catch {
      // Fall through with raw endpoint
    }
  }
  // Match `?<key>={{placeholder}}` or `&<key>={{placeholder}}`.
  const re = new RegExp(`[?&]([^=&]+)=\\{\\{${escapeRegExp(placeholder)}\\}\\}`);
  const m = re.exec(urlString);
  return m ? (m[1] ?? null) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function saveStrategy(
  platform: string,
  capability: string,
  data: Strategy,
  changelog?: string,
  sessionId?: string,
  audit?: SaveAuditInput,
): string {
  // Slug check at the door — platform and capability become filesystem
  // keys, so reject path-traversal attempts before any other work.
  try {
    asPlatformSlug(platform, 'platform');
    asIdentifierSlug(capability, 'capability');
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_strategy: ${e.message}`, { cause: e });
    }
    throw e;
  }

  // Stage 0 shape validation runs for every save, including programmatic
  // ones (auto-synth, tests). The full audit pipeline (detectors +
  // classifiers) gates on sessionId below — those layers depend on session
  // context. Lazy-require breaks the audit-chain require cycle.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const auditSaveStrategy =
    require('../audit/save-strategy') as typeof import('../audit/save-strategy');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { saveStrategyAudit } = auditSaveStrategy;
  saveStrategyAudit.runShapeChecks(data, {
    sessionId,
    platform,
    capability,
    session: audit?.session ?? null,
    observedSiblings: audit?.observedSiblings ?? [],
    observedParamValues: audit?.observedParamValues ?? {},
    capturedEndpointPaths: audit?.capturedEndpointPaths ?? new Set<string>(),
    observedUrls: audit?.observedUrls ?? [],
  });

  // Audit pipeline (Stage 1 detectors + Stage 2 classifiers). Skipped for
  // programmatic saves without session context — Stage 0 above covers the
  // shape gate either way.
  if (sessionId) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const auditIndex = require('../audit') as typeof import('../audit');
    const auditDecider =
      require('../audit/save-confirmation-decider') as typeof import('../audit/save-confirmation-decider');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const { extractAcksFromNotes, persistWarningsOnRuntimeMeta } = auditSaveStrategy;
    const { rejectionToErrorMessage } = auditIndex;
    const { getRegisteredSaveConfirmationDecider } = auditDecider;
    const auditCtx = {
      sessionId,
      platform,
      capability,
      session: audit?.session ?? null,
      observedSiblings: audit?.observedSiblings ?? [],
      observedParamValues: audit?.observedParamValues ?? {},
      capturedEndpointPaths: audit?.capturedEndpointPaths ?? new Set<string>(),
      observedUrls: audit?.observedUrls ?? [],
    };
    // SaveConfirmationDecider injection — when registered, the decider
    // ALWAYS wins. Production has no decider registered, so the audit
    // rejects on first call with a prompt_for_user the agent reads to
    // the actual user; the agent then supplies the user's reply via
    // audit_answers.user_confirmation. Test harnesses register a decider
    // that simulates a user; that decider must override any
    // self-attested user_confirmation the agent supplied — otherwise the
    // agent learns to fill in `{decision: "approve"}` themselves and
    // bypass the gate (see `runtime/docs/principles.md` §"LLM
    // self-gated checks can be bypassed"). The decider's verdict is
    // server-derived; the agent's self-attestation is not.
    const agentAnswers = (audit?.answers as Record<string, unknown> | undefined) ?? {};
    let mergedAnswers: Record<string, unknown> = agentAnswers;
    const decider = getRegisteredSaveConfirmationDecider();
    if (decider) {
      const synthesized = decider.decide(data, auditCtx);
      // Inject a deterministic composeUserPrompt rendering as agent_prompt
      // so the user_confirmation Classifier's fact-check passes for the
      // decider path. The composer's output covers every required_fact by
      // construction (capability slug, tier, target, anchor, warnings).
      /* eslint-disable @typescript-eslint/no-require-imports */
      const auditConfirmationPrompt =
        require('../audit/save-confirmation-prompt') as typeof import('../audit/save-confirmation-prompt');
      /* eslint-enable @typescript-eslint/no-require-imports */
      mergedAnswers = {
        ...agentAnswers,
        user_confirmation: {
          agent_prompt: auditConfirmationPrompt.composeUserPrompt(data, auditCtx),
          user_decision: synthesized.decision,
          user_quote: synthesized.quote,
        },
      };
    }
    const auditResult = saveStrategyAudit.process(data, auditCtx, {
      token: audit?.token,
      answers: mergedAnswers,
      acks: extractAcksFromNotes(data),
    });
    if (auditResult.status === 'rejected') {
      throw new Error(rejectionToErrorMessage('save_strategy', auditResult.rejection));
    }
    // Persist the issues that fired (whether acked or not) onto
    // runtime_meta.save_warnings so a later session reading
    // list_platform_skills / get_strategy sees what concerns this save
    // acknowledged.
    persistWarningsOnRuntimeMeta(data, auditResult.warnings);
  }

  return commitValidatedStrategy(platform, capability, data, changelog, sessionId);
}

// Persist a pre-validated, pre-audited strategy: policy check, schema-version
// stamp, enum snapshot, write, lifecycle event. `tools/save-strategy.ts`
// calls this after its own pipeline so the validator + audit chain doesn't
// re-run.
export function commitValidatedStrategy(
  platform: string,
  capability: string,
  data: Strategy,
  changelog?: string,
  sessionId?: string,
): string {
  if (isCapabilityForbidden(platform, capability)) {
    throw new Error(
      `policy_violation: capability "${capability}" is forbidden for platform "${platform}"`,
    );
  }
  if (!isTierAllowed(platform, capability, data.strategy)) {
    throw new Error(
      `policy_violation: strategy tier "${data.strategy}" exceeds max_strategy_tier for platform "${platform}" capability "${capability}"`,
    );
  }

  data.schema_version = SCHEMA_VERSION;

  if (!data.tier_stamp) {
    data.tier_stamp = stampTier(data.strategy);
  }

  // Auto-snapshot observed_values onto enum params at save time, so future
  // agents reading list_platform_skills can see WHAT the enum accepts
  // without having to call the source capability or auto-execute first.
  // Source pulls: (1) values the agent already declared in the save, (2)
  // session click→XHR pairs and URL-variance observations the runtime
  // captured during this discovery flow. Without this snapshot, the
  // listing surface shows `cuisine: enum, source: capability:list_X`
  // and the agent has to chase the indirection (a round trip the agent
  // often skips, leading to value-hallucinations like "pizza").
  if (sessionId) {
    snapshotEnumObservationsIntoSave(data, sessionId);
  }

  const subdir = SUBDIR_MAP[data.strategy] || 'api';
  const dir = path.join(SKILLS_DIR, platform, subdir);
  ensureDir(dir);
  const filePath = path.join(dir, `${capability}.json`);
  const existed = fs.existsSync(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  appendStrategyEvent(platform, capability, {
    strategy: data.strategy,
    kind: existed ? 'rediscovered' : 'discovered',
    detail: changelog || (existed ? 'overwriting existing' : `saved ${data.strategy} strategy`),
  });
  return filePath;
}

export function loadStrategy(platform: string, capability: string): Strategy | null {
  const all = loadStrategies(platform, capability);
  return all[0] ?? null;
}

/**
 * Demote a `fetch` strategy to `page-script` by rewriting the strategy tier in
 * place and moving the JSON file from the `fetch/` subdir to the `scripts/`
 * subdir. Called by the runtime's Node-fire degradation logic: after N
 * consecutive TLS / bot-check failures on the Node fire path, the strategy
 * durably switches to page-fired execution.
 *
 * No-op if the source file doesn't exist or isn't actually `fetch` tier. The
 * destination file, if one exists, is overwritten (we assume the fetch-tier
 * save is canonical and its page-script sibling was stale).
 */
export function demoteFetchToPageScript(platform: string, capability: string): void {
  const srcPath = path.join(
    SKILLS_DIR,
    platform,
    SUBDIR_MAP.fetch ?? 'fetch',
    `${capability}.json`,
  );
  if (!fs.existsSync(srcPath)) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(srcPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }
  if (parsed.strategy !== 'fetch') return;
  parsed.strategy = 'page-script';
  validateStrategyShape(parsed);
  const dstDir = path.join(SKILLS_DIR, platform, SUBDIR_MAP['page-script'] ?? 'scripts');
  ensureDir(dstDir);
  const dstPath = path.join(dstDir, `${capability}.json`);
  fs.writeFileSync(dstPath, JSON.stringify(parsed, null, 2));
  try {
    fs.unlinkSync(srcPath);
  } catch {
    // best-effort — leaving the old file around is non-fatal
  }
  appendStrategyEvent(platform, capability, {
    strategy: 'page-script',
    kind: 'tier_demote',
    detail: 'fetch → page-script (persistent after N Node-fire failures)',
  });
}

// Load all strategies for a capability, sorted by priority: fetch → page-script
// → recorded-path (cheapest first). `fetch` escapes the browser entirely
// (100-300ms Node fetch); `page-script` pays for a page load (~3s+);
// `recorded-path` replays the DOM step-by-step (~15s+).
export function loadStrategies(platform: string, capability: string): Strategy[] {
  const strategies: Strategy[] = [];

  for (const subdir of SUBDIRS) {
    const filePath = path.join(SKILLS_DIR, platform, subdir, `${capability}.json`);
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Strategy;
      strategies.push(migrateStrategy(raw, filePath));
    }
  }

  const priority: Record<string, number> = {
    fetch: 0,
    'page-script': 1,
    'recorded-path': 2,
  };
  strategies.sort((a, b) => (priority[a.strategy] ?? 99) - (priority[b.strategy] ?? 99));

  return strategies;
}

/**
 * Capability slugs on a platform that advertise the given tag via their
 * top-level `provides: [...]` declaration. The typed-edge resolver: any
 * `{kind: "tag", tag: "<tag>"}` prereq lands here at execute time, picks a
 * slug from the returned list, and delegates to capability-prereq resolution.
 *
 * A capability "provides" a tag if ANY of its on-disk tier files declares it
 * — agents save the recorded-path first, then graduate to fetch / page-script
 * later, and the `provides` declaration shouldn't have to be re-stamped on
 * every tier graduation. Deduplicates by slug — multiple tiers for the same
 * slug count once.
 */
export function findCapabilitiesProviding(platform: string, tag: string): string[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const platformDir = path.join(SKILLS_DIR, platform);
  if (!fs.existsSync(platformDir)) return [];
  const seen = new Set<string>();
  for (const subdir of SUBDIRS) {
    const subdirPath = path.join(platformDir, subdir);
    if (!fs.existsSync(subdirPath)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(subdirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const slug = entry.slice(0, -'.json'.length);
      if (seen.has(slug)) continue;
      const filePath = path.join(subdirPath, entry);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Strategy;
        const provides = raw.provides;
        if (Array.isArray(provides) && provides.includes(tag)) {
          seen.add(slug);
        }
      } catch {
        // Unreadable / malformed — skip silently. The caller's worst case is a
        // missing provider; resolveCapabilityPrereq's 0/1/2+ branches surface
        // the actual rejection.
      }
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function listPlatformSkills(): SkillInfo[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];

  const platforms = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  return platforms.map(readPlatformSkillInfo);
}

// Storage state + cookie jar: implementation moved to storage-state.ts. Re-
// exported here for back-compat with `import { ... } from "./skills"`.
export {
  storageStatePath,
  saveStorageState,
  loadStorageStatePath,
  readStorageStateCookies,
  writeStorageStateCookies,
} from './storage-state';

export function archiveStrategy(
  platform: string,
  capability: string,
  strategyType: string,
  detail?: string,
): void {
  const subdir = SUBDIR_MAP[strategyType];
  if (!subdir) return;
  const active = path.join(SKILLS_DIR, platform, subdir, `${capability}.json`);
  const archived = path.join(SKILLS_DIR, platform, subdir, `${capability}.broken.json`);
  if (fs.existsSync(active)) {
    fs.renameSync(active, archived);
    appendStrategyEvent(platform, capability, {
      strategy: strategyType,
      kind: 'archived',
      detail: detail || 'archived as broken',
    });
  }
}

export function unarchiveStrategy(
  platform: string,
  capability: string,
  strategyType: string,
): void {
  const subdir = SUBDIR_MAP[strategyType];
  if (!subdir) return;
  const archived = path.join(SKILLS_DIR, platform, subdir, `${capability}.broken.json`);
  const active = path.join(SKILLS_DIR, platform, subdir, `${capability}.json`);
  if (fs.existsSync(archived)) {
    fs.renameSync(archived, active);
    appendStrategyEvent(platform, capability, {
      strategy: strategyType,
      kind: 'unarchived',
      detail: 'manually reset',
    });
  }
}

export function clearAll(): void {
  if (fs.existsSync(KLURA_DIR)) {
    fs.rmSync(KLURA_DIR, { recursive: true, force: true });
  }
}

/**
 * Wipe strategy state (saved skills + graduation telemetry) but preserve user
 * state: cookies in `storage-state/`, `identities.json`, `config.json` (secret
 * resolvers), and `device.json` (daemon device profile). Used by benchmark
 * runners to start a "fresh discovery" iteration without forcing the user to
 * re-authenticate — cookies are orthogonal to strategy discovery, and passwords
 * are only interesting at first-time discovery.
 *
 * `clearAll()` remains available for genuine "nuke everything" scenarios.
 */
export function clearSkills(): void {
  // Strategy state lives in two parallel trees:
  //   SKILLS_DIR   — saved strategies (copy-pasteable, shippable)
  //   WORKDIR_DIR  — per-platform session archives, logbook, health, and
  //                  per-capability discovery artifacts (may contain PII)
  // Both get wiped for a fresh-discovery iteration; user state under
  // storage-state/, identities.json, config.json, device.json is preserved.
  for (const dir of [SKILLS_DIR, WORKDIR_DIR]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// --- Strategy patching (step-level healing) ---

export function patchStep(
  platform: string,
  capability: string,
  strategyType: string,
  stepId: string,
  patch: Record<string, unknown>,
): { ok: true; path: string } | { error: string } {
  // Validate inputs through the centralized validator layer
  try {
    asPlatformSlug(platform, 'platform');
    asIdentifierSlug(capability, 'capability');
    asEnum(strategyType, 'strategyType', STRATEGY_TYPES);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { error: `invalid_patch: ${e.message}` };
    }
    return { error: String(e) };
  }

  if (typeof stepId !== 'string' || stepId.length === 0) {
    return {
      error: `invalid_patch: step_id must be a non-empty string (the slug id declared on the recorded-path step, e.g. "click_send"). See klura://reference#recorded-path-schema.`,
    };
  }

  const subdir = SUBDIR_MAP[strategyType];
  if (!subdir) return { error: `unknown strategy type: ${strategyType}` };
  const filePath = path.join(SKILLS_DIR, platform, subdir, `${capability}.json`);
  if (!fs.existsSync(filePath)) return { error: 'strategy file not found' };

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { steps?: unknown[] };
  const steps = data.steps;
  if (!Array.isArray(steps)) return { error: 'strategy type has no steps' };

  const knownIds: string[] = [];
  let targetIndex = -1;
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (!s || typeof s !== 'object') continue;
    const id = (s as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    knownIds.push(id);
    if (id === stepId) targetIndex = i;
  }
  if (targetIndex === -1) {
    const idList = knownIds.map((k) => `"${k}"`).join(', ') || '(none)';
    return {
      error: `invalid_strategy: no step with id "${stepId}" in strategy; known ids: [${idList}]`,
    };
  }

  const step = steps[targetIndex] as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    step[k] = v;
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  appendStrategyEvent(platform, capability, {
    strategy: strategyType,
    kind: 'patched',
    detail: `step "${stepId}": patched ${Object.keys(patch).join(', ')}`,
  });

  return { ok: true, path: filePath };
}
