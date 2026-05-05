// `submit_triage_plan` — the agent's exit from triage. Persists a defense-
// surface plan (per `surface_label`) to the per-platform / per-capability
// logbook, fires the `triage_plan` checkpoint, and transitions to LIFT.
// Callable from triage (first plan) and from lift (re-plan — drops back
// to triage with a fresh budget, then re-enters lift on the next call).
//
// Single forward path. The user's reply to the checkpoint prompt comes
// in via `ack_checkpoint({user_response})` AFTER this tool returns; the
// agent reads it and classifies approve / reject / approve-with-comment
// themselves. To "reject" a plan the agent simply calls
// `submit_triage_plan` again with a revised plan. The runtime does not
// keyword-match human replies — that's the LLM's job.
//
// Tier suggestion is informational, not gating. The agent still aims
// T0 (fetch) → T1 (page-script) → T2 (recorded-path) in lift; the
// triage verdict shapes user expectation + escalation hygiene.
//
// Validation gate: `tier_justification` must cite at least one verbatim
// artifact actually present in the session's captured traffic — an origin
// from `intercepted[].url`, a script URL, a cookie name from
// `setCookieNames`, or a URL from `domNavigations`. Empty justification
// or zero matches → reject with the candidate list.

import { pool } from '../runtime-state';
import { loadLogbook, writeLogbook } from '../working-dir/logbook';
import type { TriagePlan, DefenseSurface } from '../working-dir/schema';
import { dispatch } from '../session-phase/state-machine';
import { currentPhase } from '../session-phase/registry';
import { invokeCheckpointAndGate, type CheckpointEnvelope } from '../checkpoints';
import { asString, asObject, asArray, asEnum } from '../validators';
import { bindUrlsToSurface, urlKey } from '../session-phase/surface-binding';
import type { Session } from '../drivers/types/session';
import { loadConfig } from '../config/handler';
import {
  composeSaveAuthoringContract,
  type SaveAuthoringContract,
} from '../save-authoring-contract';
import { triagePlanAudit, extractUrlToken, resolveAgainstOrigin } from '../audit/triage-plan';
import { rejectionToErrorMessage, type Issue } from '../audit/index';
import { renderSaveStrategySchemaMarkdown, type StrategyTier } from '../strategies/schema-catalog';

const EXPECTED_TIERS = ['fetch', 'page-script', 'recorded-path'] as const;

export interface SubmitTriagePlanArgs {
  session_id: string;
  capability: string;
  surface_label: string;
  defense_surface: DefenseSurface;
  expected_tier: 'fetch' | 'page-script' | 'recorded-path';
  tier_justification: string;
  summary_for_user: string;
  /** Per-Detector acknowledgements: keyed by detector kind, value is the
   *  agent's one-sentence reason. Required when an `ackReason: 'required'`
   *  Detector emits a warning (e.g. `enum_value_baked_into_slug`); the audit
   *  rejection echoes the kind so the agent knows what to ack on retry. */
  acks?: Record<string, string>;
}

function parseDefenseSurface(raw: unknown): DefenseSurface {
  const obj = asObject(raw, 'defense_surface');
  const stringArray = (v: unknown, field: string): string[] =>
    asArray(v, `defense_surface.${field}`).map((entry, i) =>
      asString(entry, `defense_surface.${field}[${i}]`),
    );
  const observed_origins = stringArray(obj.observed_origins, 'observed_origins');
  // Each observed_origins entry must be a parseable origin (scheme + host).
  // Bare hostnames like "x.com" are silently dropped downstream by
  // `originOf()` (in audit/triage-plan.ts) because `new URL("x.com")`
  // throws — the agent then sees a "request_pattern not on observed_origin"
  // rejection without knowing why their entries weren't recognized. Reject
  // explicitly here so the message is "observed_origins[i] missing scheme,"
  // not the downstream symptom.
  observed_origins.forEach((entry, i) => {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      const suggestion = JSON.stringify('https://' + entry.replace(/^https?:\/\//, ''));
      throw new Error(
        `invalid_strategy: defense_surface.observed_origins[${i}] = ${JSON.stringify(entry)} ` +
          `is not a parseable URL. Each entry must include the scheme: ` +
          `e.g. ${suggestion}, not ${JSON.stringify(entry)}. Bare hostnames are silently dropped by the ` +
          `downstream audit, leading to a confusing "request_pattern not on observed_origin" ` +
          `rejection. Add the scheme and re-submit.`,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `invalid_strategy: defense_surface.observed_origins[${i}] = ${JSON.stringify(entry)} ` +
          `uses ${parsed.protocol} scheme; must be http: or https:.`,
      );
    }
  });
  return {
    observed_origins,
    observed_scripts: stringArray(obj.observed_scripts, 'observed_scripts'),
    cookies_set: stringArray(obj.cookies_set, 'cookies_set'),
    request_patterns: stringArray(obj.request_patterns, 'request_patterns'),
    mechanism_hypothesis: asString(
      obj.mechanism_hypothesis,
      'defense_surface.mechanism_hypothesis',
    ),
  };
}

function parseAcks(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asObject(raw, 'acks');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = asString(v, `acks.${k}`);
  }
  return out;
}

function parseArgs(raw: unknown): SubmitTriagePlanArgs {
  const root = asObject(raw, 'submit_triage_plan args');
  return {
    session_id: asString(root.session_id, 'session_id'),
    capability: asString(root.capability, 'capability'),
    surface_label: asString(root.surface_label, 'surface_label'),
    defense_surface: parseDefenseSurface(root.defense_surface),
    expected_tier: asEnum(root.expected_tier, 'expected_tier', EXPECTED_TIERS),
    tier_justification: asString(root.tier_justification, 'tier_justification'),
    summary_for_user: asString(root.summary_for_user, 'summary_for_user'),
    acks: parseAcks(root.acks),
  };
}

const TRIAGE_PLAN_HISTORY_CAP = 5;

function getPlatform(args: SubmitTriagePlanArgs, sessionPlatform: string | undefined): string {
  if (sessionPlatform) return sessionPlatform;
  throw new Error(
    `submit_triage_plan: session has no \`platform\` set — pass \`platform\` to start_session or attach it before calling submit_triage_plan. capability=${args.capability}`,
  );
}

/** Server-derive `observed_at_urls` from `session.domNavigations` between
 *  triage entry and now. The agent doesn't supply this — they could
 *  hallucinate visits; the runtime knows what was actually navigated to. */
function deriveObservedAtUrls(session: Session): string[] {
  const since = session.triage?.enteredAt ?? 0;
  const navs = session.domNavigations ?? [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const nav of navs) {
    if (nav.at < since) continue;
    if (seen.has(nav.url)) continue;
    seen.add(nav.url);
    ordered.push(nav.url);
  }
  return ordered;
}

export interface SubmitTriagePlanResult {
  ok: true;
  phase: 'lift';
  /** User-facing summary verbatim. The agent surfaces it as a text turn
   *  to the user before the next tool call. */
  relay_to_user_before_proceeding: string;
  /** Always 'lift' on success — the only return shape. */
  next_phase: 'lift';
  message: string;
  /** Pending-checkpoint envelope when the registry resolved `handover`.
   *  The next tool call MUST include the checkpoint_token via
   *  `ack_checkpoint`; the agent then reads `user_response` and decides
   *  whether to call submit_triage_plan again (re-plan) or proceed
   *  with RE moves. */
  _checkpoint?: CheckpointEnvelope;
  /** Structured save-authoring brief composed from session state. Lists
   *  every save_strategy constraint that would fire if violated, with
   *  the specific session evidence already substituted, and the order
   *  the capabilities should be saved in. The agent reads this once at
   *  LIFT entry and authors save_strategy correctly on the first
   *  attempt — no audit-cycle thrash. The audit stays as the safety
   *  net for what the agent missed. See klura://reference#save-authoring-contract. */
  save_authoring_contract?: SaveAuthoringContract;
  /** Detector warnings the audit emitted that the agent acked through.
   *  Present when the audit committed despite emitting one or more
   *  `ackReason: 'required'` issues — the runtime echoes the resolved
   *  warnings so the agent (and any post-hoc reviewer) can see what was
   *  acked and why. Empty / undefined when no warnings fired. */
  triage_warnings?: Issue[];
  /** Save-strategy schema scoped to the agent's declared `expected_tier`,
   *  rendered from the canonical Zod validators. Lets the agent enter LIFT
   *  with the exact required + optional fields for the tier they're about
   *  to author — every field the validator enforces is enumerated, so
   *  drift between docs and runtime is structurally impossible. The full
   *  catalog is available on demand via
   *  `klura://reference#save-strategy-schema`. */
  save_strategy_schema?: string;
}

export async function submitTriagePlan(rawArgs: unknown): Promise<SubmitTriagePlanResult> {
  const args = parseArgs(rawArgs);
  const session = pool.getSession(args.session_id);
  const phase = currentPhase(session);

  if (phase !== 'triage' && phase !== 'lift') {
    throw new Error(
      `submit_triage_plan is only valid in triage or lift phases (currently '${phase}'). ` +
        `From drive: call \`end_drive\` first to enter triage.`,
    );
  }

  const platform = getPlatform(args, session.platform);

  const observedAtUrls = deriveObservedAtUrls(session);

  // Run the triage-plan audit before any state changes. Detectors cover
  // (a) request_pattern URL ground-truthing, (b) capability declaration,
  // (c) tier_justification citation, and (d) slug-baked query values
  // (Level-2 ackable; mirrors save-time `enum_value_baked_into_slug`).
  // The structured rejection envelope is identical in shape to
  // save_strategy's so the agent reads one error format across both gates.
  // See `runtime/src/audit/triage-plan.ts`.
  const triageAuditResult = triagePlanAudit.process(
    {
      surface_label: args.surface_label,
      defense_surface: args.defense_surface,
      tier_justification: args.tier_justification,
      expected_tier: args.expected_tier,
    },
    { session, capability: args.capability },
    { acks: args.acks },
  );
  if (triageAuditResult.status === 'rejected') {
    throw new Error(
      rejectionToErrorMessage('submit_triage_plan', triageAuditResult.rejection, {
        toolName: 'submit_triage_plan',
        referenceUrl: 'klura://reference#triage',
      }),
    );
  }
  const triageWarnings = triageAuditResult.warnings;

  // Persist plan to logbook. Prior plan for the same surface moves into
  // per-surface history.
  const plan: TriagePlan = {
    recorded_at: new Date().toISOString(),
    session_id: session.id,
    surface_label: args.surface_label,
    observed_at_urls: observedAtUrls,
    defense_surface: args.defense_surface,
    expected_tier: args.expected_tier,
    tier_justification: args.tier_justification,
    summary_for_user: args.summary_for_user,
  };

  const logbook = loadLogbook(platform);
  let entry = logbook.per_capability[args.capability];
  if (!entry) {
    entry = {
      sessions_contributed: 0,
      last_session_at: new Date().toISOString(),
      last_session_id: session.id,
      lift_attempts: [],
      strategy_events: [],
      current_tier: 'none',
      data_sufficiency: {
        captures_of_target_endpoint: 0,
        field_stability_confidence: 'low',
        known_rotating_fields: [],
        known_stable_fields: [],
        ambiguous_fields: [],
      },
    };
    logbook.per_capability[args.capability] = entry;
  }
  if (!entry.triage_plans_by_surface) entry.triage_plans_by_surface = {};
  if (!entry.triage_plan_history_by_surface) entry.triage_plan_history_by_surface = {};
  const prior = entry.triage_plans_by_surface[args.surface_label];
  if (prior) {
    const history = entry.triage_plan_history_by_surface[args.surface_label] ?? [];
    history.push(prior);
    while (history.length > TRIAGE_PLAN_HISTORY_CAP) history.shift();
    entry.triage_plan_history_by_surface[args.surface_label] = history;
  }
  entry.triage_plans_by_surface[args.surface_label] = plan;
  logbook.updated_at = new Date().toISOString();
  writeLogbook(logbook);

  // Bind URLs to the surface label so future navigations don't re-fire
  // `surface_changed`. The triage audit above has already validated that
  // every `request_patterns` entry has an extractable URL token and that
  // each token sits on an observed_origin or matches a captured URL — so
  // this loop is a simple extract+resolve pass with no validation
  // duplication.
  const patternUrls = args.defense_surface.request_patterns
    .map((pattern) => {
      const token = extractUrlToken(pattern);
      if (token === null) return null;
      return resolveAgainstOrigin(token, args.defense_surface.observed_origins);
    })
    .filter((u): u is string => typeof u === 'string' && u.length > 0);

  // Auto-augment: any XHR / form-action POST captured during this session
  // whose origin+pathname is a child of one of the named URLs above belongs
  // to the same surface. Without this, form-action POSTs (which never get
  // navigated to directly — the browser POSTs and immediately follows the
  // 302) and async fetches that the agent never explicitly listed land on
  // `surface_triage_missing` at save time even though they're structurally
  // part of the surface this plan describes. The path-prefix check keeps
  // multi-surface flows honest: a plan for `/search` claims `/search/*` but
  // not `/checkout`. A plan whose only named URL is the origin root (`/`)
  // claims every path on that origin — the legacy-form-post pattern where
  // the form lives on the homepage and POSTs to a sibling path.
  const namedKeys = [...observedAtUrls, ...patternUrls]
    .map((u) => urlKey(u))
    .filter((k): k is string => k !== null);
  const isChildOfNamed = (rawUrl: string): boolean => {
    const childKey = urlKey(rawUrl);
    if (childKey === null) return false;
    for (const namedKey of namedKeys) {
      if (childKey === namedKey) return true;
      // Root path (urlKey preserves the single slash for pathname "/") —
      // every path on that origin is a child.
      if (namedKey.endsWith('/') && childKey.startsWith(namedKey)) return true;
      // Non-root subpath match: `/search` claims `/search/api` but not
      // `/searchresults`.
      if (childKey.startsWith(`${namedKey}/`)) return true;
    }
    return false;
  };
  const capturedChildUrls: string[] = [];
  const seenChildKeys = new Set<string>();
  for (const req of session.intercepted) {
    if (!req.url) continue;
    if (!isChildOfNamed(req.url)) continue;
    const k = urlKey(req.url);
    if (k === null || seenChildKeys.has(k)) continue;
    seenChildKeys.add(k);
    capturedChildUrls.push(req.url);
  }
  bindUrlsToSurface(session, args.surface_label, [
    ...observedAtUrls,
    ...patternUrls,
    ...capturedChildUrls,
  ]);

  const cameFromLift = phase === 'lift';

  // Step A — drop back to triage. From triage, this is a self-loop that
  // resets the counter; from lift, it transitions back to triage.
  dispatch(session, { kind: 'plan_submitted' });

  // Step B — fire the triage_plan checkpoint. The default handler
  // surfaces the user-facing summary as a handover prompt; the
  // autonomous benchmark stub resolves `continue`. In both cases the
  // tool transitions to LIFT — the agent reads the user's reply via
  // `ack_checkpoint({user_response})` after this returns and decides
  // whether to re-submit (rejected) or proceed (approved). The runtime
  // does not classify the reply itself.
  const { envelope } = await invokeCheckpointAndGate('triage_plan', {
    session_id: session.id,
    capability: args.capability,
    context: {
      kind: 'triage_plan',
      capability: args.capability,
      surface_label: args.surface_label,
      summary_for_user: args.summary_for_user,
      expected_tier: args.expected_tier,
      tier_justification: args.tier_justification,
      defense_surface: args.defense_surface,
      is_replan: cameFromLift,
    },
  });

  dispatch(session, { kind: 'plan_handoff' });

  // Positive-frame the actual lift budget at entry. Triage is bounded (10
  // rounds default) on purpose — short deliberation, then act. LIFT is
  // typically unconstrained but the user can configure `lift.max_rounds`
  // > 0; report whatever's actually configured rather than asserting
  // "unlimited" categorically. The reason for surfacing the budget here
  // (and not only via a rejection later) is to invert the agent's
  // implicit "this system rations rounds" prior — without a positive
  // budget framing the agent under-invests. Grounded in:
  //   - "ContextBudget" (arxiv 2604.01664) — agents perform shallow
  //     searches and saturate under perceived constraints.
  //   - "Curriculum-Aware Budget Scheduling for LLMs" (arxiv 2604.19780)
  //     — explicit per-phase budget declaration outperforms inferred
  //     budgets for both overthinking and underthinking.
  const liftBudget = session.lift?.budget ?? loadConfig().lift.max_rounds;
  const liftBudgetLine =
    liftBudget === 0
      ? `**LIFT has no round limit** — work as long as the capability needs.`
      : `**LIFT round budget: ${liftBudget}** (per your \`lift.max_rounds\` config). Plan accordingly.`;
  // Tell the agent it is the classifier of the user's ack reply. The
  // user replies in any language; the agent calls `ack_checkpoint` with
  // the reply as `user_response` and then reads it to decide approve /
  // reject / approve-with-adjustments. The runtime never keyword-matches
  // the reply — that's the LLM's job.
  const ackInstructionLine = envelope
    ? `**You are the classifier of the user's reply.** After relaying \`relay_to_user_before_proceeding\` to the user, the next tool call is \`ack_checkpoint({checkpoint_token, user_response: <user's verbatim reply>})\`. Then read the reply yourself — any language, any wording — and decide: (a) clean approve → proceed with RE moves; (b) reject (user wants a different tier / method / approach) → call \`submit_triage_plan\` again with their guidance baked into the revised plan; (c) approve-with-adjustments → incorporate the user's suggestions before the first RE call. The runtime does not keyword-match the reply — you do. `
    : '';
  return {
    ok: true,
    phase: 'lift',
    next_phase: 'lift',
    relay_to_user_before_proceeding: args.summary_for_user,
    message:
      `Triage plan committed and approved — entering LIFT for surface \`${args.surface_label}\`. ` +
      ackInstructionLine +
      `${liftBudgetLine} ` +
      `Tier suggestion (${args.expected_tier}) is informational; aim T0 (fetch) → T1 (page-script) → T2 (recorded-path) in order anyway. ` +
      `RE-active tools (try_generator, set_breakpoint, evaluate_on_frame, install_page_init_script) ` +
      `are now unlocked. ` +
      `If reality contradicts the verdict (e.g. T0 (fetch) attempts silently 403 on a "looks clean" surface), ` +
      `call submit_triage_plan again with updated defense_surface — re-plans drop you back to triage with a fresh budget. ` +
      `Relay this summary to the user before proceeding: "${args.summary_for_user}"`,
    ...(envelope ? { _checkpoint: envelope } : {}),
    ...(triageWarnings.length > 0 ? { triage_warnings: triageWarnings } : {}),
    ...((): { save_authoring_contract?: SaveAuthoringContract } => {
      // Compose + cache the save-authoring contract on the session. The
      // agent reads this once at LIFT entry and authors save_strategy
      // correctly upfront — every constraint maps 1:1 to a save-strategy
      // detector but is surfaced before commitment instead of after the
      // first rejection. Cached on session.saveAuthoringContract so
      // re-reads via get_save_authoring_contract are free.
      try {
        const declaredArgs = ((): Record<string, unknown> => {
          const dc = (session.declaredCapabilities ?? []).find(
            (c) => c.capability === args.capability,
          );
          return dc && typeof dc.args === 'object' ? (dc.args as Record<string, unknown>) : {};
        })();
        const contract = composeSaveAuthoringContract(
          session,
          args.capability,
          declaredArgs,
          platform,
        );
        (
          session as unknown as { saveAuthoringContract?: SaveAuthoringContract }
        ).saveAuthoringContract = contract;
        return { save_authoring_contract: contract };
      } catch {
        return {};
      }
    })(),
    save_strategy_schema: renderSaveStrategySchemaMarkdown({
      tier: args.expected_tier as StrategyTier,
    }),
  };
}
