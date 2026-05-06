import { pool } from '../runtime-state';
import * as skills from '../strategies/skills';
import { loadCapabilityPolicy as loadCapabilityPolicyFull } from '../strategies/policy';
import {
  collectDataLoadCandidates,
  collectListingCandidates,
  findLiteralInSessionCaptures,
  type DataLoadCandidate,
  type ListingCandidate,
} from '../strategies/synthesize-on-close';
import { getAllParamObservations } from '../response/session-observations';
import {
  composeSaveAuthoringContract,
  type SaveAuthoringContract,
} from '../save-authoring-contract';
import {
  composeTriageAuthoringContract,
  type TriageAuthoringContract,
} from '../triage-authoring-contract';
import { computeTriageBundle, type TriageBundle } from '../working-dir/triage-bundle';
import type { CheckpointEnvelope } from '../checkpoints';
import { loadConfig } from '../config/handler';
import { resolveReferenceResource } from '../response/reference-sections';
import { dispatch } from '../session-phase/state-machine';
import { currentPhase } from '../session-phase/registry';

// Pull the Reverse-engineer playbook prose at module load. The LIFT handoff
// inlines this verbatim so agents see the playbook on the response they're
// already reading — `klura://reference#reverse-engineer-playbook` slug
// pointers don't get fetched in practice. Read once at module load to avoid
// re-parsing REFERENCE.md on every end_drive call.
let cachedPlaybookProse: string | null = null;
function getReversePlaybookProse(): string {
  if (cachedPlaybookProse !== null) return cachedPlaybookProse;
  try {
    const { text } = resolveReferenceResource('klura://reference#reverse-engineer-playbook');
    cachedPlaybookProse = text;
  } catch {
    cachedPlaybookProse = '';
  }
  return cachedPlaybookProse;
}

/**
 * end_drive handoff shape when declared capabilities are unresolved. The
 * response is framed as a **role transition**, not a refusal — the agent is
 * done driving the UI; now they're a reverse engineer whose job is to figure
 * out how the page reproduced each capability so warm execute works for future
 * callers.
 *
 * Every unresolved capability gets: inline candidate XHRs (ranked by
 * structural classifier) so the agent can see body previews immediately,
 * plus a list of questions the agent needs to answer to pick a tier. The
 * upfront defense-surface read happens in TRIAGE via `submit_triage_plan`
 * — close-time picks the conversation back up after triage approved.
 *
 * Close requires a successful `save_strategy` for every declared capability.
 * Repeat end_drive calls without that return this same handoff — there
 * is no "third call wins" behavior. Each save itself runs through the
 * `user_confirmation` classifier in the save-strategy audit, so the user
 * has the final say at save time on whether the proposed shape is acceptable.
 */
type CloseHandoff = {
  ok: false;
  phase: 'lift';
  session_id: string;
  platform: string;
  unresolved_capabilities: Array<{
    capability: string;
    declared_args: Record<string, string>;
    saved_strategies: string[];
    policy_max_tier: string | null;
    /** True when a saved strategy auto-executed this session and failed
     *  (HTTP 4xx/5xx or executor throw). The agent must save_strategy to
     *  override the broken shape — the existing strategy is on disk but
     *  no longer matches reality. Absent / false when the capability has
     *  no save yet or the existing save executed cleanly. */
    stale_existing_strategy?: boolean;
    candidate_xhrs: DataLoadCandidate[];
    /** Captured responses that enumerate values used as URL-param values
     *  on the candidate XHRs. Save each as its own `list_<entity>`
     *  capability and reference it via `notes.params.<X>.source:
     *  "capability:list_<entity>"` so the valid value set refreshes on
     *  every warm execute. Empty when no listing-then-pick pattern was
     *  observed in this session. */
    candidate_listings?: ListingCandidate[];
    /** Structured save-authoring brief for this capability — composed
     *  from session state. Lists every save_strategy constraint that
     *  would fire if violated. Reading this at LIFT entry replaces
     *  cycling through audit rejections one-detector-at-a-time.
     *  See klura://reference#save-authoring-contract. */
    save_authoring_contract?: SaveAuthoringContract;
    questions_to_answer: string[];
  }>;
  captures: {
    http_requests: number;
    ws_frames: number;
    actions: number;
  };
  // Minimal cross-session facts per unresolved capability: current saved tier,
  // prior lift attempts, the capability's own discovery artifact. No verdicts,
  // no field-stability classification, no round estimates — the LLM reads
  // captures + `get_platform_logbook` + artifact and decides. Keyed by
  // capability name.
  triage: Record<string, TriageBundle>;
  // Capabilities whose triage compute threw. Keyed by capability name, value is
  // the error message. Empty/absent when everything computed cleanly. A
  // non-empty entry here means the inline `triage[<cap>]` bundle is missing on
  // purpose — the agent should treat it as "no triage available" rather than
  // "no action recommended."
  triage_errors?: Record<string, string>;
  tools: {
    investigate: string[];
    re_lift: string[];
    save: string[];
  };
  end_drive_attempts: number;
  message: string;
  /** Structured brief for authoring `submit_triage_plan` — derived from
   *  session captures. Surfaces what the triage audit will check (URL
   *  token extractable, URL grounded in captures or observed_origins) so
   *  the agent reads it once at TRIAGE entry instead of cycling through
   *  audit rejections. See klura://reference#triage. */
  triage_authoring_contract?: TriageAuthoringContract;
  /** Set when the `triage_plan` checkpoint resolved `handover` — a real
   *  human (or registered plugin) needs to answer before LIFT work
   *  proceeds. Carries the token the next tool call must echo via
   *  `ack_checkpoint`. Absent when the resolution was `continue`/`resolved`
   *  (auto-proceed paths — benchmark stub, autonomous plugin). */
  _checkpoint?: CheckpointEnvelope;
};

// Classify URL query-string params as "suspicious" via shape heuristics —
// session-scoped vs caller-varying vs safe-verbatim. Advisory, not
// authoritative: the agent decides. Emitted inline on each candidate_xhrs[]
// entry so an agent inspecting candidates sees *before* authoring the save
// which params will break warm execute if baked verbatim.
//
// Triggers (ORed): - name substring match on a generic auth/signing/tracing
// vocabulary — the runtime never names a brand's header, only generic English
// crypto/auth terms (sign, token, hmac, nonce, etc.). - name equals a short
// time token (ts, time). - value is all-digits ≥10 chars (likely a unix
// timestamp or snowflake id). - value is mixed-case alphanumeric ≥20 chars
// (likely an opaque rotating token).
//
// Per docs, "documented exceptions" — candidates/advisories, not judgments.
// Simple sites (static APIs, plain GETs) match nothing and the advisory is an
// empty array. No platform regex, no brand constants. Generic
// auth/signing/tracing vocabulary only — no brand tokens. Runtime must never
// hardcode a platform-specific header / global / param name. These are English
// crypto/auth/tracing terms that appear across the web.
const SUSPICIOUS_PARAM_NAME_SUBSTRINGS = [
  'signature',
  'sign',
  'token',
  'hmac',
  'nonce',
  'trace',
  'device',
  'csrf',
  'session',
  'fingerprint',
  'timestamp',
];

export function classifyUrlParams(
  rawUrl: string,
): Array<{ name: string; reason: string; value_preview: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }
  const out: Array<{ name: string; reason: string; value_preview: string }> = [];
  const seen = new Set<string>();
  for (const [name, value] of parsed.searchParams.entries()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const nameLower = name.toLowerCase();
    const reasons: string[] = [];
    for (const needle of SUSPICIOUS_PARAM_NAME_SUBSTRINGS) {
      if (nameLower.includes(needle)) {
        reasons.push(`name contains "${needle}"`);
        break;
      }
    }
    if (nameLower === 'ts' || nameLower === 'time' || nameLower === '_' || nameLower === 't') {
      reasons.push(`name is short time-token shape ("${nameLower}")`);
    }
    if (value.length >= 10 && /^\d+$/.test(value)) {
      reasons.push(`value is ${value.length}-digit numeric (likely timestamp or snowflake id)`);
    } else if (
      value.length >= 20 &&
      /[A-Z]/.test(value) &&
      /[a-z]/.test(value) &&
      /\d/.test(value)
    ) {
      reasons.push(
        `value is ${value.length}-char mixed-case alphanumeric (likely opaque rotating token)`,
      );
    }
    if (reasons.length > 0) {
      const preview = value.length > 40 ? `${value.slice(0, 40)}…` : value;
      out.push({ name, reason: reasons.join('; '), value_preview: preview });
    }
  }
  return out;
}

// Exported for unit tests — can be called against a Session-shaped object
// without a live pool. Production call-site is in endDrive.
/**
 * Predicate sibling of `computeReverseEngineerHandoff`. Returns true iff
 * `computeReverseEngineerHandoff(session, platform)` would return a non-null
 * handoff — without doing the expensive decoration work (candidate XHR
 * scoring, listing detection, captures inventory). The orchestrator calls
 * this BEFORE running the end-drive audit so the audit's
 * `triage_acknowledgment` classifier can decide whether to gate.
 *
 * Mirrors the early-exit conditions in `computeReverseEngineerHandoff`:
 * no declared capability, every declared capability already has a non-stale
 * saved strategy (or is user-capped at recorded-path).
 */
export function wouldReverseEngineerHandoffFire(
  session: ReturnType<typeof pool.getSession>,
  platform: string,
): boolean {
  const declared = session.declaredCapabilities ?? [];
  if (declared.length === 0) return false;
  const staleSet = session.staleStrategyCapabilities;
  for (const d of declared) {
    const saved = skills.loadStrategies(platform, d.capability);
    const policy = loadCapabilityPolicyFull(platform, d.capability);
    const policyCap = policy?.max_strategy_tier ?? null;
    const hasAny = saved.length > 0;
    const userCapped = policyCap === 'recorded-path';
    const stale = staleSet?.has(d.capability) ?? false;
    if (!((hasAny && !stale) || userCapped)) return true; // any unresolved → handoff fires
  }
  return false;
}

export function computeReverseEngineerHandoff(
  session: ReturnType<typeof pool.getSession>,
  platform: string,
): null | CloseHandoff {
  const declared = session.declaredCapabilities ?? [];
  if (declared.length === 0) return null;

  // Unresolved = declared AND (no saved strategy OR saved strategy went
  // stale this session) AND no user-policy cap at recorded-path. Agent
  // "I tried and couldn't" context lives in the working-dir logbook and
  // is read via get_platform_logbook — no gate here.
  //
  // The staleStrategyCapabilities branch is what routes the agent to LIFT
  // when auto-execute returned 4xx/5xx or threw — without it, the
  // existing-but-broken strategy keeps `hasAny=true`, end_drive closes,
  // and the agent has no surface to override the stale save.
  const staleSet = session.staleStrategyCapabilities;
  const unresolvedRaw = declared
    .map((d) => {
      const saved = skills.loadStrategies(platform, d.capability);
      const policy = loadCapabilityPolicyFull(platform, d.capability);
      const policyCap = policy?.max_strategy_tier ?? null;
      const hasAny = saved.length > 0;
      const userCapped = policyCap === 'recorded-path';
      const stale = staleSet?.has(d.capability) ?? false;
      if ((hasAny && !stale) || userCapped) return null;
      return {
        capability: d.capability,
        declared_args: d.args,
        saved_strategies: saved.map((s) => s.strategy),
        policy_max_tier: policyCap,
        ...(stale ? { stale_existing_strategy: true } : {}),
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  if (unresolvedRaw.length === 0) return null;

  // Decorate each unresolved capability with its candidate XHRs and
  // listing-then-pick candidates. `candidate_listings` is the structural
  // signal that an enum-shaped param is grounded by a separately-fired
  // listing endpoint — agent should save the listing as a sibling
  // `list_<entity>` capability and reference it via `notes.params.<X>.source:
  // "capability:list_<entity>"`, which the runtime resolves at execute time.
  const observedParamValues = getAllParamObservations(session.id);
  const listingCandidatesAll = collectListingCandidates(
    session.intercepted,
    observedParamValues,
    5,
  );
  const unresolved: CloseHandoff['unresolved_capabilities'] = unresolvedRaw.map((u) => {
    const candidates = collectDataLoadCandidates(session, u.capability, session.intercepted, 5);
    const candidatesWithAdvice = candidates.map((c) => ({
      ...c,
      suspicious_params: classifyUrlParams(c.url),
    }));
    const candidateXhrIndices = new Set(candidates.map((c) => c.i));
    // Listings whose use-site (the click-firing request) is among this
    // capability's candidate_xhrs are this capability's listings.
    const listings = listingCandidatesAll.filter((l) =>
      candidateXhrIndices.has(l.used_as.appears_in_request_i),
    );
    const questions = [
      'Which captured XHR carries the data you reported to the user? (Review candidate_xhrs[*].body_preview.)',
      'Any suspicious_params[] on your chosen XHR? Those are params the runtime flagged as possibly session-scoped by SHAPE — you classify. Anything rotating / timestamp / opaque-token / device/nonce-shaped must be templated via a prereq (js-eval that calls the in-page builder, or page-extract from DOM) — do NOT bake them as literals on `save_strategy`. Anything user-stable (slug, user id, thread id, entity id) templates via notes.params.',
      'Is the response body JSON (save with fetch/page-script) or binary (RE toolkit via inspect_ws_frame + try_generator)?',
      'If the request is signed: can the page re-derive the signing per-call (→ page-script) or do you need to lift the signing algo (→ fetch)?',
    ];
    if (listings.length > 0) {
      questions.push(
        `candidate_listings[*] surfaces captured responses that enumerate values you later picked from. Save each as its own \`list_<entity>\` capability (\`save_strategy\` against the listing URL) and reference it from this capability via \`notes.params.<param>.source: "capability:list_<entity>"\`. The runtime fetches the listing at execute time to validate caller args against the freshly-fetched value set — static \`observed_values\` freeze the catalog at discovery time and miss values added since.`,
      );
    }
    // Per-capability save-authoring contract. Composed from session
    // state at handoff time; every constraint maps 1:1 to a
    // save_strategy detector. Reading this upfront replaces the
    // cascading audit cycle. See `runtime/src/save-authoring-contract.ts`.
    let contract: SaveAuthoringContract | undefined;
    try {
      contract = composeSaveAuthoringContract(session, u.capability, u.declared_args, platform);
    } catch {
      contract = undefined;
    }
    return {
      ...u,
      candidate_xhrs: candidatesWithAdvice,
      ...(listings.length > 0 ? { candidate_listings: listings } : {}),
      ...(contract ? { save_authoring_contract: contract } : {}),
      questions_to_answer: questions,
    };
  });

  const actionCount = (session.performActionHistory ?? []).length;
  const wsCount = (session.wsFrames ?? []).length;
  const httpCount = session.intercepted.length;
  const endDriveAttempts = session.endDriveAttempts ?? 1;

  const capNames = unresolved.map((u) => u.capability).join(', ');
  const repeatedNoOpClose = detectRepeatedNoOpClose(session, unresolved);
  // Empty-artifact guard: when the agent is about to hit the third
  // end_drive (which auto-synths recorded-path unconditionally) without
  // having persisted ANY findings — no verified_expressions, no discovery
  // notes, no resume pointers — the recorded-path fallback is the ONLY thing
  // that will land. For genuinely DOM-only multi-step capabilities that's the
  // correct outcome. For everything else — XHR- backed APIs, SSR HTML reads,
  // signed requests — recorded-path is the wrong tier and the agent needs to
  // explicitly save fetch / page-script (or fetch+html-extract for SSR) before
  // closing. Surface the state on attempt 2 so the agent knows they're one
  // close away from a recorded-path-only outcome and can back out if they meant
  // to lift.
  const acc = session.artifactAccumulator;
  const sumBuckets = (m: Record<string, readonly unknown[]> | undefined): number =>
    m ? Object.values(m).reduce((n, arr) => n + arr.length, 0) : 0;
  const verifiedCountTotal = sumBuckets(acc?.verifiedExpressions);
  const notesCountTotal = sumBuckets(acc?.notes);
  const resumePointersTotal = sumBuckets(acc?.agentResumePointers);
  const hasAnyPersistedFindings = verifiedCountTotal + notesCountTotal + resumePointersTotal > 0;
  const emptyArtifactWarning =
    endDriveAttempts >= 2 && !hasAnyPersistedFindings
      ? `\n\n⚠ EMPTY-ARTIFACT: you've called end_drive twice and persisted ZERO findings (no save_verified_expression, add_discovery_note, or add_resume_pointer). Calling end_drive again will return this same handoff — there is no "third call wins" path. LIFT ends when save_strategy lands a runnable strategy for every declared capability; every save passes the user_confirmation classifier so the user has the final say on whether the proposed shape is acceptable. Until a save lands, keep working: save_strategy against the candidate XHR carrying the data (build the fetch / page-script shape from the captured request — baseUrl + endpoint + method + headers + body), OR for SSR HTML reads save \`fetch\` with \`response: {format: "html", extract: {...}}\`, OR run the RE toolkit (try_generator / js_eval / set_breakpoint + save_verified_expression to persist).`
      : '';

  // Ungrounded-read guard: for a declared read-shaped capability (declared
  // args, no type/fill/submit in performActionHistory), check whether the
  // session actually captured content that could support the answer the agent
  // gave the user. Failure mode this catches: site shows a login gate or
  // registration wall, agent dismisses the banner, reports posts from
  // training-data memory rather than flagging it couldn't access the content.
  // Per runtime/docs/principles.md §"Prefer runtime enforcement over prompt
  // reminders" — fabrication is a very strong training prior that SKILL.md text
  // can't override; the end_drive handoff is the decision-point surface.
  //
  // "Weak grounding" heuristic: declared-arg literal only matches in
  // visited_url (the URL bar), nowhere else; total non-OPTIONS response body
  // bytes is low; no scroll/wait action in history. Each individual signal has
  // false positives (SSR-only sites legitimately have no XHR; auth-gated APIs
  // may block responses) — combining them narrows to the actual failure. Kept
  // as an advisory, not a block: a stern nudge that the agent may either fix by
  // re-opening the session and extracting properly, or ack by revising their
  // answer to say "I couldn't access the content."
  const WRITE_SHAPED = new Set(['type', 'fill_editor', 'fill', 'submit']);
  const actionsAll = session.performActionHistory ?? [];
  const hasWriteShapedAction = actionsAll.some(
    (a) =>
      typeof (a as { action?: string }).action === 'string' &&
      WRITE_SHAPED.has((a as { action: string }).action),
  );
  const hasScrollOrWait = actionsAll.some(
    (a) =>
      typeof (a as { action?: string }).action === 'string' &&
      ((a as { action: string }).action === 'scroll' ||
        (a as { action: string }).action === 'wait'),
  );
  type UngroundedReport = {
    capability: string;
    arg_matches_outside_visited_url: number;
    arg_matches_in_visited_url: number;
    details: Array<{ arg: string; literal_len: number; sources: string[] }>;
  };
  const ungroundedReports: UngroundedReport[] = [];
  if (!hasWriteShapedAction) {
    for (const decl of session.declaredCapabilities ?? []) {
      const args = decl.args;
      const details: UngroundedReport['details'] = [];
      let outsideVisited = 0;
      let insideVisited = 0;
      for (const [argName, argVal] of Object.entries(args)) {
        if (typeof argVal !== 'string' || argVal.length < 4) continue;
        const hits = findLiteralInSessionCaptures(session, argVal);
        const sources = hits.map((h) => h.source);
        outsideVisited += sources.filter((s) => s !== 'visited_url').length;
        insideVisited += sources.filter((s) => s === 'visited_url').length;
        details.push({ arg: argName, literal_len: argVal.length, sources });
      }
      if (details.length === 0) continue;
      ungroundedReports.push({
        capability: decl.capability,
        arg_matches_outside_visited_url: outsideVisited,
        arg_matches_in_visited_url: insideVisited,
        details,
      });
    }
  }
  // Summed response-body bytes from non-OPTIONS HTTP captures. OPTIONS
  // preflights carry no data; filtering them out avoids counting bytes the
  // agent can't have read from.
  const totalResponseBytes = session.intercepted.reduce((acc2, req) => {
    const method = (req as { method?: string }).method;
    if (typeof method === 'string' && method.toUpperCase() === 'OPTIONS') return acc2;
    const body = (req as { responseBody?: unknown }).responseBody;
    if (typeof body === 'string') return acc2 + body.length;
    if (body && typeof body === 'object') {
      try {
        return acc2 + JSON.stringify(body).length;
      } catch {
        return acc2;
      }
    }
    return acc2;
  }, 0);
  const RESPONSE_CONTENT_FLOOR = 2048; // ~2KB of actual body across all non-OPTIONS XHRs
  const EXTRACTED_CONTENT_FLOOR = 4096; // ~4KB of a11y-tree text returned to the agent
  // Extraction-text grounding: every a11y-tree return (start_session,
  // perform_action, get_a11y_tree) increments session.extractedContentBytes.
  // When the running total is substantive, the agent saw enough page content to
  // ground a read answer even if no XHR response body existed (SSR-only sites,
  // logged-out profile pages rendered from HTML). This suppresses the
  // ungrounded advisory for that legitimate case.
  const extractedBytes = session.extractedContentBytes ?? 0;
  const weakReports = ungroundedReports.filter(
    (r) =>
      r.arg_matches_outside_visited_url === 0 &&
      r.arg_matches_in_visited_url > 0 &&
      totalResponseBytes < RESPONSE_CONTENT_FLOOR &&
      extractedBytes < EXTRACTED_CONTENT_FLOOR &&
      !hasScrollOrWait,
  );
  let ungroundedReadAdvisory = '';
  if (weakReports.length > 0) {
    const readCapabilityLabel =
      weakReports.length === 1 ? 'a read capability' : `${weakReports.length} read capabilities`;
    const capabilityList = weakReports.map((r) => r.capability).join(', ');
    const reportLines = weakReports
      .map((r) => {
        const argSummary = r.details
          .map(
            (d) =>
              `${d.arg}: literal of length ${d.literal_len} matched in [${d.sources.join(', ') || 'nowhere'}]`,
          )
          .join('; ');
        return `  • ${r.capability}: ${argSummary}`;
      })
      .join('\n');
    ungroundedReadAdvisory =
      `\n\n⚠ UNGROUNDED-READ ADVISORY: you declared ${readCapabilityLabel} (${capabilityList}), but the session captured no substantive page content that could back the answer you gave the user.\n` +
      reportLines +
      `\n  Total non-OPTIONS XHR response bytes captured: ${totalResponseBytes} (floor: ${RESPONSE_CONTENT_FLOOR}).` +
      `\n  No scroll or wait action was performed — the page likely never loaded past the initial gate/banner.` +
      `\n  If you reported specific data to the user (post text, dates, numeric stats), verify it came from an a11yTree / screenshot / XHR response captured in THIS session. A common failure mode: the site showed a login wall, you dismissed a banner, and then answered from prior knowledge of the entity. If that happened, your next turn should revise the answer — e.g. "the page required authentication and I couldn't read the posts" — rather than leaving the fabricated answer standing.`;
  }

  // Compose the minimal triage bundle for every unresolved capability:
  // current_tier + prior_attempts + discovery_artifact. Cross-session facts
  // only; no verdicts, no round estimates. The LLM reads the raw captures +
  // `get_platform_logbook` + artifact and decides.
  const triageByCapability: Record<string, TriageBundle> = {};
  const triageErrors: Record<string, string> = {};
  for (const u of unresolved) {
    try {
      triageByCapability[u.capability] = computeTriageBundle(session, platform, u.capability);
    } catch (err) {
      // Per-capability triage is best-effort — a malformed logbook or missing
      // archive shouldn't break end_drive. But the failure must be VISIBLE:
      // a silent empty `triage: {}` looks identical to a successful no-op
      // bundle and hides logbook bugs indefinitely. Log to stderr + attach
      // under `triage_errors[<capability>]` so the agent (and field-report
      // inspectors) can see the miss.
      const msg = err instanceof Error ? err.message : String(err);
      triageErrors[u.capability] = msg;
      try {
        process.stderr.write(
          `[klura] triage compute failed for ${platform}/${u.capability}: ${msg}\n`,
        );
      } catch {
        /* stderr write failure is non-fatal */
      }
    }
  }
  const capabilityNoun = unresolved.length === 1 ? 'y' : 'ies';
  const strategyTarget =
    unresolved.length === 1 ? `capability ${capNames}` : `capabilities ${capNames}`;
  const message = repeatedNoOpClose
    ? `REPEAT-CLOSE DETECTED. You called end_drive again without taking any action between attempts. ` +
      `Calling end_drive with the same session state will return the same refusal every time — it WILL NOT resolve anything. ` +
      `\n\nYou HAVE NOT SAVED a strategy for the declared capabilit${capabilityNoun}: ${capNames}. ` +
      `Delivering the answer to the user is only HALF of this task; klura's contract is that every declared capability ends with EITHER a saved strategy OR an explicit policy decline with evidence. Without one, warm runs have to rediscover from cold and the benchmark reports 'no strategy saved'. ` +
      `\n\nYour next tool call MUST be one of:` +
      `\n  - save_strategy({session_id, platform, capability, strategy: {strategy: "fetch" | "page-script" | "recorded-path", ...}}) — author the strategy from the captured request you picked from candidate_xhrs[] (baseUrl + endpoint + method + headers + body). Bake nothing that rotates per call.` +
      `\n  - get_network_log / get_action_history / inspect_ws_frame — investigate before authoring` +
      `\nend_drive WILL NOT terminate the session until save_strategy lands a runnable strategy for every declared capability. Every save passes the user_confirmation classifier — the user approves or rejects the proposed shape at save time. Until a save lands, every close call returns this same handoff.`
    : `**DRIVE COMPLETE → LIFT REQUIRED.** end_drive will NOT terminate this session until save_strategy lands a runnable strategy for every declared capability. Repeat end_drive calls return this same handoff. Ending your turn here without a save IS A FAILURE — the session is still open, every future tool call will see the same LIFT prompt, and the bench records "no strategy saved." Keep working until save_strategy succeeds. Every save passes through the user_confirmation classifier in the save-strategy audit; the user approves or rejects the proposed shape at save time, with the strategy summary inlined in the prompt. Saving \`recorded-path\` is allowed in any phase — but the user_confirmation prompt surfaces tier + step count, so the user gets the final say on whether \`recorded-path\` is acceptable for this capability. ` +
      `\n\nThe user has their answer. They've moved on. You are now in LIFT — infrastructure mode.` +
      `\n\nLIFT is NOT about the current user's request. It's already satisfied. LIFT is about the NEXT caller — and the one after that, and the benchmark run, and every other agent that uses klura tomorrow. Your job right now is to save a reusable strategy for ${strategyTarget} so nobody has to redo the work you just did.` +
      `\n\nThis changes the cost-benefit math. You are no longer a task-completer finishing a request; you are a reverse engineer writing library code. The question is NOT "is this worth it for this user" (they're done). The question is: "is a permanently-callable warm-fast version of this capability worth my time right now?" Almost always yes. Declining a liftable capability means every future invocation pays ~30s re-discovery + 10-20 LLM rounds + rate-limit exposure + storage-state churn. Saving page-script once amortizes after 2 future calls and keeps paying off.` +
      `\n\n**Heavy / signed / multi-token endpoints are the EXPECTED case in LIFT — they are not a reason to fold.** "Lots of rotating tokens" / "complex signing" / "would take significant RE rounds" are observations about the work, not justifications to skip it. Every modern signed write looks like this. The page-script tier exists exactly so the page's own JS re-derives those tokens at execute time; you template them as js-eval prereqs, you don't replicate the signer in Node. Your move is to start lifting, not to estimate complexity and stop.` +
      `\n\n**Three shapes of backing, in preference order:**\n` +
      `  1. **XHR / WS backing** — signed or unsigned, captured JSON / binary requests carry the data. Lift to \`fetch\` (unsigned) or \`page-script\` (signed / anti-bot / rotating-token — page runs the signer). Most real-world capabilities land here, INCLUDING signed ones: "request can't replay from Node" = \`page-script\` with a js-eval prereq that calls the page's signer.\n` +
      `  2. **Server-rendered HTML in the initial document** — the data is already in the HTML the browser loaded (view-source: would show it, or the a11y tree carried the content after navigating to an arg-templated URL). Save as \`fetch\` with \`response: {format: "html", extract: {name: {selector, attr?, multiple?, fields?}}}\`. One HTTP call, ~100ms warm, no browser. See klura://reference#fetch-schema.\n` +
      `  3. **Genuinely DOM-only multi-step** — data only appears after search-type-submit flows, scroll-to-load pagination that fires unique per-scroll XHRs, JS-computed values with no HTML trace, or consent-gated content. recorded-path replay.\n\n` +
      `Check the initial document response in \`get_network_log\` before saving recorded-path — if the content is there, save \`fetch\` + html-extract.` +
      `\n\n--- REVERSE-ENGINEER PLAYBOOK (inlined; read this before any RE rounds) ---\n\n` +
      getReversePlaybookProse() +
      `\n\n--- END PLAYBOOK ---\n\n` +
      `Side reading (slug pointer, fetch on demand): klura://reference#re-pattern-choice — iterate vs encoder-read; pick based on the envelope.\n\n` +
      `Every unresolved capability's top-5 candidate XHRs + any RE signals are inlined in unresolved_capabilities. ` +
      `Captured in this session: ${httpCount} HTTP request(s), ${wsCount} WebSocket frame(s), ${actionCount} perform_action(s). ` +
      `\n\n**LIFT RHYTHM.** Plow through every RE trick: \`inspect_ws_frame\` → \`try_generator\` iterations (iteration 1 with the starter is free), \`js_eval\` probes, \`set_breakpoint\` + \`evaluate_on_frame\`, source-read via \`get_js_source\` / \`search_js_source\` / \`read_js_function\`. Rotating fields (epoch_id, otid, nonces, signatures, timestamps, etc.) are TEMPLATED via js-eval prereqs that re-derive from the live page. **The session ends LIFT when save_strategy lands a complete runnable strategy.** Every save runs through user_confirmation; if the user rejects the proposed shape (e.g. they want a higher tier than what you proposed), keep working — the rejection stays in the current phase. Tool calls are cheap; a saved strategy is permanent infrastructure.\n\n` +
      `The \`triage[<capability>]\` block on this response carries only cross-session facts (current tier, prior lift attempts, discovery_artifact scratchpad). YOU classify the capture shape and pick the tier. Signal sources: \`get_network_log\` / \`inspect_ws_frame\` / \`get_action_history\` for raw captures; \`get_platform_logbook({platform, capability})\` for cross-session memory (field_stability, signer_history, bundle_history); candidate_xhrs inline under each unresolved_capabilities[*] entry. Next tool call: save_strategy (author the fetch / page-script / recorded-path shape from the captured request you pick from candidate_xhrs[]), or get_network_log / inspect_ws_frame / get_js_source / search_js_source / set_breakpoint to investigate first.\n\n` +
      `**Side-effect-producing RE moves need consent.** trigger_reference_send refires a submit on a real service and is token-gated (Level-3): the first call returns a \`consent_token\` + checklist; the second commits with \`consent_answers\` including tier classification and (for Tier 2) the user's own acknowledgement quote. Classify per klura://reference#checkpoints (Tier 2 by default — any third-party recipient, human OR bot, counts) and get explicit user confirmation before supplying the quote. Prefer read-only RE moves (inspect_ws_frame / find_in_ws_frame on pinned frames, try_generator against a captured reference, set_breakpoint + evaluate_on_frame) — these don't fire a send and never need consent.`;
  // No checkpoint fires from end_drive in the new flow. The ask-user
  // moment moves to `submit_triage_plan`. The session is now in the
  // TRIAGE phase (set by the state machine when end_drive transitions
  // drive→triage); the agent must call `submit_triage_plan` with a
  // defense-surface read before LIFT-active tools become admissible.
  // The hard-blocking middleware enforces this — diagnostic tools are
  // available throughout, but try_generator / set_breakpoint /
  // save_strategy / etc. only unlock once the triage_plan checkpoint
  // approves AND the surface the strategy targets is bound.
  // Surface the actual configured triage budget at entry so the agent
  // has the right prior. Naming the budget on the positive transition
  // (rather than only via a rejection later) avoids the implicit
  // "this system rations rounds globally" anchor described in
  // ContextBudget (arxiv 2604.01664) and the Curriculum-Aware Budget
  // Scheduling paper (arxiv 2604.19780).
  const triageMax = loadConfig().triage.max_rounds;
  const triageBudgetLine =
    triageMax === 0
      ? `**TRIAGE has no round limit** (per your config).`
      : `**TRIAGE round budget: ${triageMax}** — deliberation is short by design; LIFT (the next phase) is where you spend rounds. Triage budget resets on every entry, including the \`surface_changed\` re-entry path.`;
  const triageEntryPrelude =
    `\n\n**TRIAGE — read the defense surface first.** You are now in the TRIAGE phase. ` +
    `${triageBudgetLine} ` +
    `Inspect what third-party origins, scripts, and cookies the page uses (use \`get_network_log\`, ` +
    `\`list_loaded_scripts\`, \`get_js_source\`, \`search_js_source\`). Identify the bot-detection posture ` +
    `using your own knowledge — klura runtime never names vendors; you do. ` +
    `Then call \`submit_triage_plan\` with: \`surface_label\` (semantic name like "checkout" or "search"), ` +
    `\`defense_surface\` (observed_origins, observed_scripts, cookies_set, request_patterns, mechanism_hypothesis), ` +
    `\`expected_tier\` (T0=fetch / T1=page-script / T2=recorded-path), ` +
    `\`tier_justification\` citing at least one verbatim observed origin / script / cookie / URL, ` +
    `and \`summary_for_user\`. ` +
    `**Tier suggestion is informational, not gating** — you still aim T0 (fetch) → T1 (page-script) → T2 (recorded-path) in lift. The verdict ` +
    `shapes user expectation + escalation hygiene (on aggressive sites, T0 (fetch) / T1 (page-script) attempts may burn the session — ` +
    `use ephemeral context if you want to retry). Multi-surface flows (e.g. \`/cart\` → \`/checkout\` → \`/payment\`) ` +
    `triage each surface separately; the runtime fires \`surface_changed\` when navigation crosses to an un-triaged surface. ` +
    `RE-active tools (try_generator, set_breakpoint, evaluate_on_frame, install_page_init_script) ` +
    `and \`save_strategy\` are HARD-BLOCKED until the triage_plan is approved.\n\n`;
  const finalMessage = triageEntryPrelude + message + emptyArtifactWarning + ungroundedReadAdvisory;

  // Drive the phase machine: discover/drive → triage on first close-with-
  // unresolved-capabilities. Without this, session.phase stays at default
  // 'drive' and the admissibility middleware hard-blocks save_strategy /
  // submit_triage_plan, leaving the agent
  // boxed in. Idempotent on subsequent close attempts: once phase is
  // already 'triage', dispatch refuses the same event with a transition
  // error — we swallow that case.
  try {
    if (currentPhase(session) === 'drive') {
      dispatch(session, { kind: 'end_drive_unresolved' });
    }
  } catch {
    // Illegal-transition errors are non-fatal — the response prose still
    // tells the agent how to proceed.
  }

  const triageContract = composeTriageAuthoringContract(session);
  return {
    ok: false,
    phase: 'lift',
    session_id: session.id,
    platform,
    unresolved_capabilities: unresolved,
    captures: { http_requests: httpCount, ws_frames: wsCount, actions: actionCount },
    triage: triageByCapability,
    triage_authoring_contract: triageContract,
    ...(Object.keys(triageErrors).length > 0 ? { triage_errors: triageErrors } : {}),
    tools: {
      investigate: [
        'get_network_log',
        'get_action_history',
        'inspect_ws_frame',
        'find_in_page',
        'get_js_source',
        'search_js_source',
        'read_js_function',
      ],
      re_lift: [
        'try_generator',
        'try_generator_in_page',
        'get_send_encoder',
        'js_eval',
        'set_breakpoint',
        'evaluate_on_frame',
      ],
      save: ['save_strategy'],
    },
    end_drive_attempts: endDriveAttempts,
    message: finalMessage,
  };
}

/**
 * No-op close-retry detector. If the agent calls end_drive again without
 * taking ANY action between attempts (no new tool calls, no save_strategy, no
 * get_network_log), the second refusal surfaces a stronger "repeat-close
 * detected" message instead of just re-emitting the same role-shift handoff.
 * Makes the loop visible to the agent rather than quietly re-presenting the
 * same candidate list they ignored once already.
 *
 * Signal: session has `lift` set (first close already hit the handoff) AND
 * `roundsSinceHandoff === 0` AND `endDriveAttempts >= 2`. Since every tool call
 * increments `roundsSinceHandoff` in `pool.getSession`, a zero counter at
 * attempt ≥ 2 means the agent did nothing between closes.
 */
function detectRepeatedNoOpClose(
  session: ReturnType<typeof pool.getSession>,
  _unresolved: CloseHandoff['unresolved_capabilities'],
): boolean {
  if (!session.lift) return false;
  if ((session.endDriveAttempts ?? 1) < 2) return false;
  return session.lift.roundsSinceHandoff <= 1;
}
