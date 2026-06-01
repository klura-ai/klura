// End-drive audit — second `Audit` instance, mirrors the save-strategy
// audit but operates at the session-tear-down decision point. Absorbs:
//
//   - capability_declaration_required (Detector, ackReason: 'none') — refuses
//     end_drive on attempts 1 and 2 when the session typed/submitted content but
//     never declared a capability. Agent fixes by calling declare_capability;
//     attempt 3 force-tears-down regardless (the orchestrator skips the audit
//     on attempt 3 to provide an escape hatch).
//
//   - save_attempted_none_landed (Detector, ackReason: 'none') — refuses
//     end_drive when at least one save_strategy attempt was made and zero
//     succeeded. Stops the legacy-form-post failure mode where the agent
//     gives up mid-recoverable-loop and end_drive papers over the silent
//     failure with whatever stale strategy was on disk.
//
//   - re_persistence (Detector, ackReason: 'none') — refuses end_drive when the
//     session did heavy reverse-engineering work (set_breakpoint / get_js_source /
//     search_js_source / read_js_function / evaluate_on_frame / full-body
//     get_network_log) with zero persistence calls AND that work isn't reflected
//     on disk (some declared capability is still unresolved, or none was declared).
//     `js_eval` alone never trips this — it's the everyday DOM-read / response-parse
//     tool, not an RE signal in isolation (it folds into the rejection message when
//     heavy RE is also present, but is not the trigger). Agent either persists
//     progress (retry clears the gate naturally — persistCallCount > 0) OR uses
//     `abort_session(reason)` as the honest exit when the work was misguided in the
//     first place. There is NO agent-authored ack escape: klura is
//     always-save-by-default and "I judged this as nothing worth persisting" isn't
//     the agent's verdict to make.
//
//   - triage_acknowledgment (Classifier, token-gated) — fires when end_drive
//     would otherwise skip triage entirely (every declared capability already
//     has a non-stale saved strategy, OR no triage handoff would fire). Triage
//     is mandatory — agent doesn't get to decide "this was a one-off task,
//     teardown without triage." Agent must either submit a triage_plan, or
//     echo {triage_acknowledgment: {acknowledged: true, reason: "<own words
//     explaining why no triage round was warranted, e.g. 'all capabilities
//     have a fetch-tier saved strategy and no graduation candidates surfaced'>"}}.
//     Token binds to {sessionId, declaredCapabilityCount, saveSuccessCount,
//     endDriveAttempts}.
//
// Same machinery as save-strategy-audit, different lifecycle. New
// end-drive concerns become one Detector or Classifier entry on this
// instance — runtime threads the token, formats the rejection, persists
// nothing (end-drive has no on-disk artifact equivalent to a strategy).

import { Audit, type Classifier, type Detector } from '../index';
import { graphFor } from '../../graphs';
import { getObservedNamesForSession } from '../../working-dir/logbook';
import { collectUnsavedHotXhrEndpoints } from './xhr-noise';
import { readPlatformSkillInfo } from '../../strategies/skills-list-helpers';

export const RE_CALL_THRESHOLD = 2;
export const ACTION_CALL_THRESHOLD = 5;

/** Actions that mutate page state. Navigation, clicks on unknown elements,
 *  scrolls, screenshots don't count — a user might just be browsing. Exported
 *  for the auto-synth literal-resolver in
 *  runtime/src/strategies/synthesize-on-close/literals.ts. */
export const WRITE_SHAPED_ACTIONS = new Set(['type', 'fill_editor', 'fill', 'submit']);

export interface EndDrivePayload {
  sessionId: string;
  platform: string;
  endDriveAttempts: number;
  declaredCapabilityCount: number;
  writeActions: ReadonlyArray<{ action: string; value_preview?: string }>;
  /** Heavy reverse-engineering tool calls (set_breakpoint, get_js_source,
   *  search_js_source, read_js_function, evaluate_on_frame, full-body
   *  get_network_log). The re_persistence Detector's trigger count. */
  heavyReCallCount: number;
  /** js_eval calls. Reported alongside heavyReCallCount in the re_persistence
   *  rejection for context, but never the trigger on its own — js_eval is the
   *  everyday DOM-read / response-parse tool, not an RE signal in isolation. */
  jsEvalCallCount: number;
  persistCallCount: number;
  actionCallCount: number;
  /** Total save_strategy calls (success + thrown). Compared against
   *  savedCapabilityCount to detect "agent tried, never landed." */
  saveAttemptCount: number;
  /** Successful save_strategy persistences (entries on
   *  session.savedCapabilities). */
  saveSuccessCount: number;
  /** From the active graph's GraphConfig. When true, the
   *  capability_declaration_required detector short-circuits — surface-mapping
   *  graphs are allowed to land without declaring a capability. */
  skipDeclarationGuard: boolean;
  /** From the active graph's GraphConfig. The re_persistence Detector fires
   *  when `persistCallCount === 0`, not every declared capability has resolved
   *  (`declaredCapabilityCount === 0 || triageWouldFire`), AND EITHER
   *  `heavyReCallCount >= reCalls` (positive `reCalls`) OR
   *  `actionCallCount >= actions` (positive `actions` — the map-graph
   *  "mapped without persisting" trigger). Always set after
   *  buildEndDrivePayload (it supplies a fallback); the `undefined` branch in
   *  shouldRunRePersistence is defensive. */
  rePersistenceThreshold: { reCalls: number; actions: number } | undefined;
  /** Caller-computed: would the post-audit reverse-engineer handoff produce
   *  a non-null triage handoff? When false AND declaredCapabilityCount > 0,
   *  the triage_acknowledgment classifier fires — the runtime forces the
   *  agent to acknowledge that triage was considered even though the
   *  runtime would have skipped it. */
  triageWouldFire: boolean;
  /** Capability names recorded via `record_observed_capability` this session
   *  but NEITHER lifted via `lift_observed_capability` (which would have
   *  pushed them into `session.declaredCapabilities`) NOR landed as a
   *  successful save (`session.savedCapabilities`). The
   *  `observed_capabilities_not_lifted` Detector reads this to refuse close
   *  when the agent breadcrumbed candidates and then walked away — the
   *  loop's primary teach-at-moment surface for the "save every safe
   *  read-only capability" task. */
  observedNotLifted: ReadonlyArray<string>;
  /** Active graph slug. Lets graph-specific detectors fire without each
   *  one reaching back into GraphConfig — payload stays self-contained. */
  graph: import('../../phases/types').GraphName;
  /** Count of `record_observed_capability` calls landed this session.
   *  Distinct from `observedNotLifted.length` (which excludes lifted/saved
   *  ones). Total observed = lifted + saved + observedNotLifted. */
  observedCapabilityCount: number;
  /** Count of intercepted HTTP requests this session whose status was
   *  4xx or 5xx. The map_session_no_observations detector reads this to
   *  discriminate "session against a blocked origin" (failures > 0) from
   *  "session against a site that just doesn't expose machine-readable
   *  surfaces" (no failures — agent might still abort, but it's not a
   *  DOA pattern). */
  httpFailureCount: number;
  /** Capabilities whose post-save validation either failed (strategy archived
   *  to `.broken.json`) or was declined via cancelled-checkpoint, AND which
   *  the agent did NOT subsequently re-save successfully in the same session.
   *  Each entry blocks `end_drive` close — agents who declined or hit a
   *  validation failure and walked away leave warm callers running against
   *  a stale or `.broken` strategy that silently misbehaves. Optional so
   *  pre-existing test payloads that don't set it stay valid; defaults to
   *  `[]` (detector no-ops). */
  abandonedSaveAttemptsNotRetried?: ReadonlyArray<{
    capability: string;
    kind: 'archived' | 'declined';
    at: number;
  }>;
  /** Distinct (method, urlPath) tuples for 2xx XHR responses captured this
   *  session whose path isn't covered by any saved strategy's endpoint
   *  template AND doesn't match an obvious tracking-shape heuristic. The
   *  `unsaved_xhr_endpoints` Detector reads this to refuse close when the
   *  agent observed JSON-bearing surfaces but didn't save (or ack with a
   *  reason). Optional so pre-existing test payloads that don't set it stay
   *  valid; defaults to `[]` (detector no-ops). Capped at 20 entries
   *  (smaller of "noise floor" + "rejection envelope budget"). */
  unsavedHotXhrEndpoints?: ReadonlyArray<{
    method: string;
    urlPath: string;
    sampleUrl: string;
  }>;
}

/** Empty by design — every payload field the audit needs is captured at
 *  payload-build time. The ctx slot exists for symmetry with
 *  save-strategy-audit (which uses it for live-session probes). */
export type EndDriveCtx = Record<string, never>;

// ---------- Detector: capability_declaration_required ----------

const declarationRequiredDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'capability_declaration_required',
  ackReason: 'none',
  detect: (p) => {
    // endDriveAttempts is read PRE-bump (orchestrator bumps on audit success,
    // not before). Pre-bump 0 = first call, 1 = second call, 2 = third
    // call (the force-tear-down attempt — guard releases). Same threshold
    // as the legacy `attempts > 2` post-bump check.
    if (p.endDriveAttempts >= 2) return [];
    if (p.declaredCapabilityCount > 0) return [];
    if (p.skipDeclarationGuard) return [];
    // Fire whenever the agent meaningfully drove the page (any
    // perform_action call) without declaring a capability. Read
    // capabilities deserve a save opportunity too: a fetch strategy for
    // the search XHR is the whole point of klura.
    if (p.actionCallCount === 0) return [];
    // Exploration-session exemption: the session has no declared
    // capability, no save attempt, and no write-shaped actions. The agent
    // navigated to look around and is closing — there is no RE artifact
    // to demand. Forcing a fake capability declaration here produces the
    // surface_triage_missing → unobserved_url deadlock with no path out.
    // Auto-synth still runs at the orchestrator layer and persists
    // anything it can derive; the audit just stops refusing close.
    // Mirrors the parallel exemption in computeSessionObligation
    // (session-obligations.ts).
    if (p.saveAttemptCount === 0 && p.writeActions.length === 0) return [];

    const writeActionsObserved = p.writeActions.length > 0;
    const previews = p.writeActions
      .slice(0, 5)
      .map((a) => (a.value_preview ? `${a.action}(${a.value_preview})` : a.action))
      .join(', ');
    const overflow = p.writeActions.length > 5 ? `, …+${p.writeActions.length - 5} more` : '';

    const observedClause = writeActionsObserved
      ? `Observed write actions (preview): ${previews}${overflow}.`
      : `Observed ${p.actionCallCount} \`perform_action\` call(s) (read-only navigation / clicks). ` +
        `Read capabilities deserve a save too — the captured XHRs the page made while you drove ` +
        `are the substrate for a fetch strategy that next callers warm-execute.`;

    return [
      {
        kind: 'capability_declaration_required',
        message:
          `CANNOT CLOSE: this session drove the UI but no capability was declared. ` +
          `Auto-save needs a capability slug to key under; without one, the session degrades to a ` +
          `keyless recorded-path that nobody can look up at warm execute. ${observedClause}`,
        hint:
          `Call declare_capability({session_id: "${p.sessionId}", capability: "<slug>", ` +
          `args: {...}}) before closing. Pick a slug matching the user's verb phrase ` +
          `(send_message, create_post, submit_form, search_<thing>, list_<thing>), and pass the ` +
          `user's arg values verbatim so auto-save can template them. A third close attempt will ` +
          `force-tear-down and drop the captured work.`,
        context: {
          session_id: p.sessionId,
          platform: p.platform,
          captured_write_actions: p.writeActions,
          action_call_count: p.actionCallCount,
          end_drive_attempts: p.endDriveAttempts,
        },
      },
    ];
  },
};

// ---------- Detector: save_attempted_none_landed ----------
//
// Refuses close when the agent called `save_strategy` at least once during
// the session AND no save succeeded. This is the legacy-form-post failure
// mode: the agent hits a recoverable audit rejection, can't break out of
// the loop, gives up, and `end_drive` would let the session close cleanly
// — but the strategy on disk is whatever was there before the run started
// (often a buggy strategy from a prior session). Future warm-execute
// reuses that stale strategy without ever flagging the silent failure.
//
// Same shape as `capability_declaration_required`: ackReason `'none'`
// (no acceptable ack — agent must save successfully or hit the third
// close attempt to force-tear-down). Releases at endDriveAttempts >= 2 to
// preserve the existing third-attempt escape hatch.

const saveAttemptedNoneLandedDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'save_attempted_none_landed',
  ackReason: 'none',
  detect: (p) => {
    if (p.endDriveAttempts >= 2) return [];
    if (p.saveAttemptCount === 0) return [];
    if (p.saveSuccessCount > 0) return [];
    return [
      {
        kind: 'save_attempted_none_landed',
        message:
          `CANNOT CLOSE: ${p.saveAttemptCount} save_strategy attempt(s) on this session, ` +
          `zero successful saves. Closing now would leave whatever strategy was on disk ` +
          `before this session in place — including buggy strategies from earlier runs that ` +
          `the agent's failed attempts here were trying to overwrite. Future warm execute ` +
          `would silently use the stale strategy.`,
        hint:
          `Read the most recent save_strategy rejection's error message and fix the strategy ` +
          `body / audit_answers before retrying. If the audit keeps rejecting on the same ` +
          `field after 2-3 attempts, the strategy itself has a structural issue: either ` +
          `re-shape it (different tier, different param classification) or persist what ` +
          `you have to the discovery_artifact (save_verified_expression / add_discovery_note ` +
          `/ add_resume_pointer) and let the next session pick up. A third close attempt ` +
          `will force-tear-down and the session's captures will be lost.`,
        context: {
          session_id: p.sessionId,
          platform: p.platform,
          save_attempt_count: p.saveAttemptCount,
          save_success_count: p.saveSuccessCount,
          end_drive_attempts: p.endDriveAttempts,
        },
      },
    ];
  },
};

// ---------- Detector: re_persistence ----------
//
// Refuses close when N RE tool calls have been made with zero persistence
// calls. ackReason: 'none' — there is NO agent-authored escape. Two valid
// next moves:
//   1. Persist progress via save_verified_expression / add_discovery_note /
//      add_resume_pointer; the gate clears naturally on retry
//      (persistCallCount > 0 → detector returns no issues).
//   2. Call `abort_session(session_id, reason)` — bypasses end_drive entirely.
//      The legitimate use case for "no save" is "this session shouldn't have
//      been driving in the first place"; abort_session is the honest exit.
//      "I judged this as nothing worth persisting" is NOT a legitimate
//      LLM-authored verdict — klura is always-save-by-default.

const rePersistenceDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 're_persistence',
  ackReason: 'none',
  detect: (p) => {
    if (!shouldRunRePersistence(p)) return [];
    const t = p.rePersistenceThreshold;
    const firedOnActions = !!t && t.actions > 0 && p.actionCallCount >= t.actions;
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
    const segments: string[] = [];
    if (firedOnActions) segments.push(plural(p.actionCallCount, 'perform_action call'));
    if (p.heavyReCallCount > 0) {
      const heavy = plural(p.heavyReCallCount, 'code-inspection / breakpoint call');
      segments.push(
        p.jsEvalCallCount > 0
          ? `${heavy} (plus ${plural(p.jsEvalCallCount, 'js_eval call')})`
          : heavy,
      );
    } else if (p.jsEvalCallCount > 0) {
      // Reached only via the actions branch — js_eval is context, not the trigger.
      segments.push(plural(p.jsEvalCallCount, 'js_eval call'));
    }
    const what = segments.join(' and ');
    return [
      {
        kind: 're_persistence',
        message:
          `CANNOT CLOSE: ${what} on session ${p.sessionId}, but zero persistence calls. ` +
          `Work that isn't persisted is invisible to the next session.`,
        hint:
          `Two valid next moves: ` +
          `(1) PERSIST: call save_verified_expression({expression, returns, ...}) for confirmed encoder ` +
          `expressions, add_discovery_note({body, kind?}) for prose breadcrumbs, or ` +
          `add_resume_pointer({kind, ref, ...}) for typed pointers (file:line, frame_index, ws_hash). ` +
          `Then retry end_drive — the gate clears naturally once persistCallCount > 0. ` +
          `(2) ABORT: if this session shouldn't have been driving in the first place ` +
          `(existing capability covers the task, user said abort, site dead), call ` +
          `abort_session(session_id, "<reason ≥20 chars>") for the honest exit. ` +
          `NOT legitimate: "I judged this as nothing worth saving" — klura is always-save-by-default ` +
          `and that judgment isn't yours to make.`,
        context: {
          session_id: p.sessionId,
          heavy_re_call_count: p.heavyReCallCount,
          js_eval_call_count: p.jsEvalCallCount,
          re_call_count: p.heavyReCallCount + p.jsEvalCallCount,
          persist_call_count: p.persistCallCount,
          action_call_count: p.actionCallCount,
        },
      },
    ];
  },
};

// ---------- Detector: map_session_no_observations ----------
//
// Refuses close on map-graph sessions where the agent navigated but never
// recorded a single observed capability, never saved anything, and never
// performed a write-shaped action. The session is DOA — typically because
// the origin hard-blocked at landing (anti-bot wall) or the site presented
// no machine-readable surface at the entry URL. Closing via `end_drive`
// silently leaves no signal on the platform's ledger; the next session
// re-discovers the dead end from cold start.
//
// ackReason: 'none' — no LLM-authored ack. The right exit is
// `abort_session({kind: "origin_blocked" | "site_dead" | "other", reason})`
// which writes a machine-actionable entry to the platform's recent_aborts.
// Future sessions reading recent_aborts at session start short-circuit
// known-blocked starts without re-driving the failed flow.
//
// Releases at endDriveAttempts >= 2 per the existing third-attempt
// escape hatch.

const mapSessionNoObservationsDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'map_session_no_observations',
  ackReason: 'none',
  detect: (p) => {
    if (p.endDriveAttempts >= 2) return [];
    if (p.graph !== 'map') return [];
    if (p.observedCapabilityCount > 0) return [];
    if (p.saveSuccessCount > 0) return [];
    if (p.writeActions.length > 0) return [];
    // Require at least one HTTP failure — that's the discriminator
    // between "DOA against a blocked origin" and "agent explored a normal
    // site but found nothing observable." Both shapes might warrant an
    // abort, but the loop's primary failure mode is the blocked one.
    if (p.httpFailureCount === 0) return [];
    return [
      {
        kind: 'map_session_no_observations',
        message:
          `CANNOT CLOSE: map-graph session against \`${p.platform}\` recorded zero observed ` +
          `capabilities, saved zero strategies, and performed zero write-shaped actions. ` +
          `The session is DOA — typically the origin hard-blocked at landing (a bot-management ` +
          `wall or WAF challenge) or the entry URL presents no machine-readable surface.`,
        hint:
          `Use \`abort_session({session_id, reason, kind})\` instead of end_drive. The kind ` +
          `discriminator gets written to the platform's abort_events ledger; future sessions ` +
          `read recent_aborts at start_session and short-circuit known-blocked starts without ` +
          `re-driving the failed flow. Pick the kind that matches:\n` +
          `  - "origin_blocked" — anti-bot wall / captcha / region gate (most common)\n` +
          `  - "site_dead" — site permanently down or no longer exposes the surface\n` +
          `  - "other" — none of the above; explain in reason\n` +
          `If you genuinely think a human-in-the-loop session could unstick this, call ` +
          `\`start_remote_session\` instead so a person can authenticate / solve the captcha.`,
        context: {
          session_id: p.sessionId,
          platform: p.platform,
          graph: p.graph,
        },
      },
    ];
  },
};

// ---------- Detector: observed_capabilities_not_lifted ----------
//
// Refuses close when the agent called `record_observed_capability` on
// capability names that were neither lifted into the session's
// declaredCapabilities (via `lift_observed_capability`) NOR landed as a
// successful save. Agents commonly drop breadcrumbs and walk away — under
// the loop's "save every safe read-only capability" task the leftover
// observations represent missed save opportunities, not deferred ones.
//
// ackReason: 'required' — legitimate ack path: "intentionally deferring
// these for next session because <structural reason>." validateAck demands
// the ack reason names each leftover slug verbatim (anti-canned: agents
// learn fast that `{reason: "deferred"}` won't pass).
//
// Releases at `endDriveAttempts >= 2` per the existing third-attempt
// escape hatch.

const observedNotLiftedDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'observed_capabilities_not_lifted',
  ackReason: 'required',
  detect: (p) => {
    if (p.endDriveAttempts >= 2) return [];
    if (p.observedNotLifted.length === 0) return [];
    const slugs = p.observedNotLifted.slice(0, 20);
    const overflow =
      p.observedNotLifted.length > 20 ? `, …+${p.observedNotLifted.length - 20} more` : '';
    const slugList = slugs.map((s) => `\`${s}\``).join(', ') + overflow;
    return [
      {
        kind: 'observed_capabilities_not_lifted',
        message:
          `CANNOT CLOSE: this session called record_observed_capability on ` +
          `${p.observedNotLifted.length} capability name(s) but never lifted them: ${slugList}. ` +
          `Each is a candidate the agent observed with structural evidence and then walked ` +
          `away from. Closing now drops the captured XHR / DOM context the next session ` +
          `would have to re-discover from cold start.`,
        hint:
          `Two ways forward: ` +
          `(a) call lift_observed_capability({session_id, name: "<slug>"}) for each leftover, ` +
          `walk it through triage + save_strategy this session; ` +
          `(b) if a leftover is genuinely deferral-worthy (auth-walled, ` +
          `paginated-listing-without-cursor, mutating-shape), ack with ` +
          `notes-like input: append to acks {"observed_capabilities_not_lifted": ` +
          `"deferring <slug1>, <slug2>, … because <structural reason>"} — the ack ` +
          `reason MUST name each leftover slug verbatim or the ack fails (anti-canned).`,
        context: {
          session_id: p.sessionId,
          platform: p.platform,
          observed_not_lifted: [...p.observedNotLifted],
        },
      },
    ];
  },
  validateAck: (ack, emittedIssues): string[] => {
    // The ack must mention every leftover slug verbatim in its reason —
    // anti-canned check (a "deferring all" reason that doesn't name a
    // single slug doesn't prove the agent read the rejection).
    const first = emittedIssues[0];
    const ctx = first?.context as { observed_not_lifted?: unknown; platform?: unknown } | undefined;
    const slugs = Array.isArray(ctx?.observed_not_lifted)
      ? (ctx.observed_not_lifted as unknown[]).filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        )
      : [];
    const issues: string[] = [];
    const missing = slugs.filter((s) => !ack.reason.includes(s));
    if (missing.length > 0) {
      issues.push(
        `ack reason must name each leftover observed slug verbatim — missing: ` +
          missing.map((s) => `\`${s}\``).join(', ') +
          `. A canned "deferring all" doesn't pass; the runtime forces the agent ` +
          `to read which slugs they're acking through.`,
      );
    }
    // Anti-fabrication via structured field: when the agent claims a cover
    // ("deferring slug X because it's already covered by saved capability Y"),
    // they pass `covered_by: ["<Y>", ...]` on the ack and the runtime
    // validates each name structurally against the platform's saved set.
    // No prose-parsing — `covered_by` is a list of slug strings, the saved
    // set is a list of slug strings, the check is set-membership.
    const platform = typeof ctx?.platform === 'string' ? ctx.platform : '';
    if (platform && Array.isArray(ack.covered_by) && ack.covered_by.length > 0) {
      let savedNames: Set<string>;
      try {
        const info = readPlatformSkillInfo(platform);
        savedNames = new Set(info.capabilities.map((c) => c.name));
      } catch {
        savedNames = new Set();
      }
      const bogus = ack.covered_by.filter((c) => !savedNames.has(c));
      if (bogus.length > 0) {
        const bogusList = bogus.map((c) => '`' + c + '`').join(', ');
        const subject = bogus.length === 1 ? "that capability isn't" : "those capabilities aren't";
        const platformJson = JSON.stringify(platform);
        issues.push(
          `covered_by names ${bogusList} but ${subject} a saved capability on platform ` +
            `${platformJson}. Either pass real slug(s) (check list_platform_skills({platform: ` +
            `${platformJson}}) for the canonical names), lift the observed slug yourself this ` +
            `session, or drop covered_by and state a structural reason.`,
        );
      }
    }
    return issues;
  },
};

/**
 * The re_persistence Detector fires when this session did reverse-engineering
 * work that isn't reflected on disk and isn't being persisted on close.
 *
 * "Reflected on disk" = a saved strategy. When every declared capability
 * resolved to a non-stale saved strategy the runtime would skip the triage
 * handoff (`triageWouldFire === false`), so the session's RE work is baked
 * into those strategies — nothing is orphaned. (Same predicate the
 * triage_acknowledgment classifier reads for the "all saved" case. Known,
 * accepted gap: speculative graduation RE done in a session that *also*
 * landed a recorded-path slips through — that work should be persisted
 * voluntarily via add_discovery_note / save_verified_expression, and the
 * triage round is the place for it.) A session with NO declared capability
 * (pure exploration / lookup) is NOT exempted: poking the bundle and bailing
 * still owes a breadcrumb.
 *
 * The trigger count is `heavyReCallCount` — code-inspection / breakpoint /
 * frame-eval / full-network-read calls. `js_eval` alone never trips this:
 * it's the everyday DOM-read / response-parse tool, and any RE flow worth
 * persisting first has to *find* the code (a heavy tool). The map graph's
 * `actions` threshold is independent — a mapping session that touched N pages
 * without persisting fires regardless of RE calls.
 */
function shouldRunRePersistence(p: EndDrivePayload): boolean {
  if (p.persistCallCount > 0) return false;
  // A landed saved strategy is itself a persistence artifact — the most
  // concrete one. In map-graph sessions that lift one capability and leave
  // others observed-but-unlifted, the triage handoff would still fire on
  // the unlifted slugs, so the older `!triageWouldFire` check below alone
  // wouldn't clear this gate. But the agent shipped real work; demanding
  // breadcrumbs on top is friction.
  if (p.saveSuccessCount > 0) return false;
  const t = p.rePersistenceThreshold;
  if (!t) return false;
  if (p.declaredCapabilityCount > 0 && !p.triageWouldFire) return false;
  if (t.reCalls > 0 && p.heavyReCallCount >= t.reCalls) return true;
  if (t.actions > 0 && p.actionCallCount >= t.actions) return true;
  return false;
}

// ---------- Classifier: triage_acknowledgment ----------

const TRIAGE_ACK_MIN_REASON_LENGTH = 20;

const triageAcknowledgmentClassifier: Classifier<EndDrivePayload, EndDriveCtx, unknown> = {
  kind: 'triage_acknowledgment',
  expectedAnswerShape:
    'triage_acknowledgment: {acknowledged: true, reason: "<your own words explaining why this session does not warrant a triage round, e.g. \'all declared capabilities have a fetch-tier saved strategy and the captures showed no graduation candidates\'>"}',
  buildItems: (p) => {
    if (!shouldRunTriageAcknowledgment(p)) return null;
    return {
      session_id: p.sessionId,
      declared_capability_count: p.declaredCapabilityCount,
      saved_capability_count: p.saveSuccessCount,
      prompt:
        `end_drive ALWAYS goes through triage. Every declared capability on this session is ` +
        `already saved (no unresolved work, no stale strategies), so the runtime would skip the ` +
        `triage handoff — but triage is the runtime-mandated review point. The agent does not ` +
        `get to decide "this was a one-off task, no triage needed." Echo the audit_token + ` +
        `acknowledge with a non-trivial reason explaining why no further triage is warranted ` +
        `(e.g. "all declared caps are saved at fetch tier, no graduation candidate observed in ` +
        `captures"). NOTE: submit_triage_plan is admissible from drive only when work is still ` +
        `unresolved — when it would route to lift after end_drive. In this all-saved case the ` +
        `audit's only forward path is the ack; observed_capabilities and defense-surface metadata ` +
        `from any triage_plans you submitted earlier this session are auto-recorded by the ` +
        `runtime when end_drive commits.`,
      acknowledge_shape:
        '{triage_acknowledgment: {acknowledged: true, reason: "<your reason, ≥20 chars>"}}',
    };
  },
  validate: (_p, _ctx, answer) => {
    if (typeof answer !== 'object' || answer === null) {
      return [
        `triage_acknowledgment answer must be an object — got ${typeof answer}. ` +
          `Echo {acknowledged: true, reason: "<own words>"} after considering whether triage was warranted.`,
      ];
    }
    const a = answer as { acknowledged?: unknown; reason?: unknown };
    if (a.acknowledged !== true) {
      return [
        `triage_acknowledgment.acknowledged must be \`true\` — explicit assent that you considered ` +
          `triage and chose to skip. Anything else means you have not made the choice consciously.`,
      ];
    }
    if (typeof a.reason !== 'string' || a.reason.trim().length < TRIAGE_ACK_MIN_REASON_LENGTH) {
      return [
        `triage_acknowledgment.reason must be a non-trivial string (≥${TRIAGE_ACK_MIN_REASON_LENGTH} chars) ` +
          `explaining in your own words why this session does not warrant a triage round. ` +
          `Canned answers ("ok", "done", "no triage") do not satisfy.`,
      ];
    }
    return [];
  },
  hashFields: (p) => ({
    sessionId: p.sessionId,
    declaredCapabilityCount: p.declaredCapabilityCount,
    saveSuccessCount: p.saveSuccessCount,
    endDriveAttempts: p.endDriveAttempts,
  }),
  remedy: () => ({
    kind: 'classification_options',
    options: [
      {
        choice: '{triage_acknowledgment: {acknowledged: true, reason: "<own words>"}}',
        rationale:
          'explicit no-triage acknowledgment with a reason a future reader can audit (e.g. "all caps fetch-tier, no graduation candidate observed in captures"). This is the ONLY achievable forward path from this audit moment: submit_triage_plan is admissibility-blocked from drive phase, and after the ack lands the session closes (when triageWouldFire is false there is no LIFT phase to enter). Triage metadata you want to persist for future sessions should have been submitted via submit_triage_plan BEFORE end_drive — the runtime auto-records observed_capabilities and defense-surface notes from those plans when this audit commits.',
      },
    ],
  }),
};

function shouldRunTriageAcknowledgment(p: EndDrivePayload): boolean {
  // Third-attempt force-tear-down releases every gate, mirroring
  // declaration_required / save_attempted_none_landed.
  if (p.endDriveAttempts >= 2) return false;
  // No declared capability → triage has nothing to review structurally.
  if (p.declaredCapabilityCount === 0) return false;
  // Triage handoff will fire — that path already routes the agent into triage,
  // no need for an additional gate.
  if (p.triageWouldFire) return false;
  // NOTE: the all-saved/no-candidate case is DELIBERATELY still gated here —
  // triage is a runtime-mandated review point; the agent does not get to decide
  // "this was a one-off, no triage needed." (See the triage-acknowledgment-gate
  // tests + the always-save / triage-is-planning design.)
  return true;
}

// ---------- Detector: unsaved_xhr_endpoints ----------
//
// Refuses close when the network log carries 2xx XHR responses on URL paths
// that aren't covered by any saved strategy's endpoint template AND don't
// match an obvious tracking-shape heuristic. The agent observed JSON-bearing
// surfaces and walked away from them — under map-graph and any "save every
// safe read-only capability" task framing, leftover hot endpoints represent
// missed lift opportunities, not deferred ones.
//
// Sibling of `observed_capabilities_not_lifted` — that detector reads the
// `record_observed_capability` ledger (what the agent explicitly noted), this
// detector reads the network log (structural evidence the runtime can see
// regardless of what the agent acknowledged). Together they close the gap
// where agents satisfy end_drive by adding cheap notes instead of lifting +
// saving.
//
// ackReason: 'required'. The ack must name at least one URL path verbatim
// from the emitted list (anti-canned: a generic "all noise" answer fails;
// the agent has to read what they're acking through).
//
// Releases at `endDriveAttempts >= 2` per the existing third-attempt escape
// hatch.

const unsavedXhrEndpointsDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'unsaved_xhr_endpoints',
  ackReason: 'required',
  detect: (p) => {
    if (p.endDriveAttempts >= 2) return [];
    const endpoints = p.unsavedHotXhrEndpoints ?? [];
    if (endpoints.length === 0) return [];
    const list = endpoints
      .slice(0, 20)
      .map((e) => `${e.method} \`${e.urlPath}\``)
      .join('\n  ');
    return [
      {
        kind: 'unsaved_xhr_endpoints',
        message:
          `CANNOT CLOSE: this session captured 2xx XHR responses on ` +
          `${endpoints.length} URL path(s) that aren't covered by any saved ` +
          `strategy AND don't match an obvious tracking-shape heuristic ` +
          `(see runtime/docs/principles.md §Allowed runtime heuristics):\n  ${list}\n` +
          `Each is a candidate read-only capability the runtime can see in your network log. ` +
          `add_discovery_note doesn't clear this gate; save_strategy does.`,
        hint:
          `Two ways forward: ` +
          `(a) for each path that's a real capability, call declare_capability + drive a ` +
          `minimal flow to capture the literal-bearing request, then save_strategy at fetch ` +
          `or page-script tier; ` +
          `(b) for paths that are genuine noise (tracking, telemetry, marketing pixel that ` +
          `slipped the heuristic), ack with append to acks ` +
          `{"unsaved_xhr_endpoints": "noise: <urlPath1>, <urlPath2>, … — <structural reason>"}. ` +
          `The ack MUST name each path verbatim from the list above (anti-canned: a generic ` +
          `"all noise" answer fails so the runtime forces you to read which paths you're ` +
          `dismissing).`,
        context: {
          session_id: p.sessionId,
          platform: p.platform,
          unsaved_xhr_endpoints: endpoints.map((e) => ({
            method: e.method,
            url_path: e.urlPath,
            sample_url: e.sampleUrl,
          })),
        },
      },
    ];
  },
  validateAck: (ack, emittedIssues): string[] => {
    const first = emittedIssues[0];
    const ctx = first?.context as { unsaved_xhr_endpoints?: unknown } | undefined;
    const rawList = Array.isArray(ctx?.unsaved_xhr_endpoints)
      ? (ctx.unsaved_xhr_endpoints as unknown[])
      : [];
    const paths: string[] = [];
    for (const e of rawList) {
      if (e && typeof e === 'object' && 'url_path' in e) {
        const candidate = (e as { url_path?: unknown }).url_path;
        if (typeof candidate === 'string' && candidate.length > 0) paths.push(candidate);
      }
    }
    if (paths.length === 0) return [];
    const mentioned = paths.filter((p) => ack.reason.includes(p));
    if (mentioned.length === 0) {
      return [
        `ack reason must name at least one URL path verbatim from the emitted list ` +
          `(anti-canned: a generic "all noise" answer doesn't pass — the runtime forces ` +
          `the agent to read which specific paths they're dismissing). Paths in list: ` +
          paths
            .slice(0, 5)
            .map((p) => `\`${p}\``)
            .join(', ') +
          (paths.length > 5 ? `, …+${paths.length - 5} more` : ''),
      ];
    }
    return [];
  },
};

// ---------- Detector: abandoned_save_attempts_not_retried ----------
//
// Refuses close when post-save validation either failed (strategy archived
// to `.broken.json`) or was declined via `post_save_validation_consent`
// cancellation, AND the agent didn't subsequently re-save that capability
// in the same session. Catches the "silent corruption" failure mode: agent
// hits one validation failure or chooses to decline, walks away, leaves
// warm callers running against a stale or `.broken` strategy that silently
// misbehaves.
//
// ackReason: 'required' — legitimate ack path: "structural reason this
// capability can't be re-saved this session." validateAck demands the
// reason names each abandoned capability slug verbatim (anti-canned).
// Releases at `endDriveAttempts >= 2` per the third-attempt escape hatch.

const abandonedSaveAttemptsDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'abandoned_save_attempts_not_retried',
  ackReason: 'required',
  detect: (p) => {
    if (p.endDriveAttempts >= 2) return [];
    const abandoned = p.abandonedSaveAttemptsNotRetried ?? [];
    if (abandoned.length === 0) return [];
    const lines = abandoned.map(
      (a) =>
        `\`${a.capability}\` (${a.kind === 'archived' ? 'validation failed → .broken' : 'consent declined'})`,
    );
    return [
      {
        kind: 'abandoned_save_attempts_not_retried',
        message:
          `CANNOT CLOSE: ${abandoned.length} capability/capabilities had post-save validation ` +
          `${abandoned.length === 1 ? 'leave them' : 'leave each one'} in a non-working state ` +
          `this session and were not re-saved: ${lines.join(', ')}. Closing now leaves warm ` +
          `callers running against a stale or \`.broken\` strategy that silently returns wrong ` +
          `data — the silent-corruption failure mode.`,
        hint:
          `Two ways forward: ` +
          `(a) for each abandoned capability, fix the rejection reason (most rejection envelopes ` +
          `name a concrete fix verbatim — re-read the post_save_validation.message) and call ` +
          `save_strategy again this session. The new successful save clears the gate. ` +
          `(b) if a capability is genuinely unrecoverable this session (e.g. requires an ` +
          `unavailable prereq, mutating-shape requires user consent klura-loop can't supply), ` +
          `ack with append to acks {"abandoned_save_attempts_not_retried": "abandoning ` +
          `<capability1>, <capability2>, … because <structural reason naming each>"}. The ack ` +
          `MUST name each abandoned capability verbatim (anti-canned: a generic "all unfixable" ` +
          `answer fails — the runtime forces you to read which capabilities you're abandoning).`,
        context: {
          session_id: p.sessionId,
          platform: p.platform,
          abandoned_save_attempts: abandoned.map((a) => ({
            capability: a.capability,
            kind: a.kind,
            at: a.at,
          })),
        },
      },
    ];
  },
  validateAck: (ack, emittedIssues): string[] => {
    const first = emittedIssues[0];
    const ctx = first?.context as { abandoned_save_attempts?: unknown } | undefined;
    const rawList = Array.isArray(ctx?.abandoned_save_attempts)
      ? (ctx.abandoned_save_attempts as unknown[])
      : [];
    const slugs: string[] = [];
    for (const e of rawList) {
      if (e && typeof e === 'object' && 'capability' in e) {
        const candidate = (e as { capability?: unknown }).capability;
        if (typeof candidate === 'string' && candidate.length > 0) slugs.push(candidate);
      }
    }
    const missing = slugs.filter((s) => !ack.reason.includes(s));
    if (missing.length === 0) return [];
    return [
      `ack reason must name each abandoned capability slug verbatim — missing: ` +
        missing.map((s) => `\`${s}\``).join(', ') +
        `. A canned "abandoning all" doesn't pass; the runtime forces the agent to read ` +
        `which capabilities they're walking away from.`,
    ];
  },
};

// ---------- The audit instance ----------

export const endDriveAudit = new Audit<EndDrivePayload, EndDriveCtx>({
  kind: 'end_drive',
  detectors: [
    declarationRequiredDetector,
    saveAttemptedNoneLandedDetector,
    rePersistenceDetector,
    observedNotLiftedDetector,
    mapSessionNoObservationsDetector,
    unsavedXhrEndpointsDetector,
    abandonedSaveAttemptsDetector,
  ],
  classifiers: [triageAcknowledgmentClassifier],
});

// ---------- Helpers for orchestrator-side payload assembly ----------

interface SessionLike {
  id: string;
  platform?: string;
  graph?: import('../../phases/types').GraphName;
  endDriveAttempts?: number;
  declaredCapabilities?: ReadonlyArray<{ capability?: string }>;
  performActionHistory?: ReadonlyArray<{ action?: string; value?: unknown }>;
  saveAttemptCount?: number;
  savedCapabilities?: ReadonlyArray<{ capability?: string; at?: number }>;
  abandonedSaveAttempts?: ReadonlyArray<{
    capability: string;
    kind: 'archived' | 'declined';
    at: number;
  }>;
  /** Read by map_session_no_observations (status discrimination) and by
   *  the unsaved_xhr_endpoints detector (URL/method extraction). */
  intercepted?: ReadonlyArray<{
    status?: number | null;
    method?: string;
    url?: string;
    isNavigation?: boolean;
  }>;
}

/**
 * Walk session.performActionHistory and pluck the write-shaped actions the
 * declaration-required detector consumes. Pure projection — no driver, no
 * pool. Mirrors the legacy collectWriteShapedActions helper.
 */
export function collectWriteActions(
  session: SessionLike,
): Array<{ action: string; value_preview?: string }> {
  const out: Array<{ action: string; value_preview?: string }> = [];
  const history = session.performActionHistory ?? [];
  for (const record of history) {
    const action = record.action;
    if (typeof action !== 'string' || !WRITE_SHAPED_ACTIONS.has(action)) continue;
    const rawValue = record.value;
    let value_preview: string | undefined;
    if (typeof rawValue === 'string' && rawValue.length > 0) {
      value_preview = rawValue.length > 60 ? `${rawValue.slice(0, 60)}…` : rawValue;
    }
    out.push(value_preview ? { action, value_preview } : { action });
  }
  return out;
}

/**
 * Build the end-drive audit payload from a Session + caller-supplied
 * counts (heavyReCallCount, jsEvalCallCount, persistCallCount,
 * actionCallCount). Pure, testable; no side effects.
 *
 * `triageWouldFire` is computed by the orchestrator just before this call
 * (see `wouldReverseEngineerHandoffFire` in end-drive/re-handoff.ts) — the
 * triage_acknowledgment classifier reads it to decide whether to require an
 * explicit ack token from the agent, and the re_persistence detector reads it
 * to decide whether the session's RE work is already reflected in saved
 * strategies.
 */
export function buildEndDrivePayload(
  session: SessionLike,
  counts: {
    heavyReCallCount: number;
    jsEvalCallCount: number;
    persistCallCount: number;
    actionCallCount: number;
  },
  opts: { platform?: string; triageWouldFire: boolean },
): EndDrivePayload {
  // Resolve graph config locally so the payload stays self-contained — the
  // payload is the contract between the orchestrator and the audit detectors,
  // and detectors should never reach back into runtime state.
  const graph = graphFor(session.graph ?? 'discover');
  const cfg = graph.config;
  // Diff observed-this-session against (declaredCapabilities ∪ savedCapabilities):
  // lift_observed_capability pushes onto declaredCapabilities; saveStrategy
  // pushes onto savedCapabilities. A name in either set is "lifted" enough
  // for the audit's purpose.
  const observed = getObservedNamesForSession(session.id);
  const liftedOrSaved = new Set<string>();
  for (const d of session.declaredCapabilities ?? []) {
    if (typeof d.capability === 'string') liftedOrSaved.add(d.capability);
  }
  for (const s of session.savedCapabilities ?? []) {
    if (typeof s.capability === 'string') liftedOrSaved.add(s.capability);
  }
  const observedNotLifted = observed.filter((n) => !liftedOrSaved.has(n));
  const observedCapabilityCount = observed.length;
  let httpFailureCount = 0;
  for (const r of session.intercepted ?? []) {
    if (typeof r.status === 'number' && r.status >= 400) httpFailureCount += 1;
  }
  const platform = opts.platform ?? session.platform ?? '';
  const unsavedHotXhrEndpoints = collectUnsavedHotXhrEndpoints(
    session.intercepted,
    session.savedCapabilities,
    platform,
  );
  // Filter abandoned attempts: an entry "clears" if there is a successful
  // save for the same capability AFTER the abandonment timestamp. The agent
  // recovered — no gate fires.
  const abandonedSaveAttemptsNotRetried = (session.abandonedSaveAttempts ?? []).filter((a) => {
    const recovered = (session.savedCapabilities ?? []).some(
      (s) => s.capability === a.capability && typeof s.at === 'number' && s.at > a.at,
    );
    return !recovered;
  });
  return {
    sessionId: session.id,
    platform: opts.platform ?? session.platform ?? '<platform>',
    endDriveAttempts: session.endDriveAttempts ?? 0,
    declaredCapabilityCount: (session.declaredCapabilities ?? []).length,
    writeActions: collectWriteActions(session),
    heavyReCallCount: counts.heavyReCallCount,
    jsEvalCallCount: counts.jsEvalCallCount,
    persistCallCount: counts.persistCallCount,
    actionCallCount: counts.actionCallCount,
    saveAttemptCount: session.saveAttemptCount ?? 0,
    saveSuccessCount: (session.savedCapabilities ?? []).length,
    skipDeclarationGuard: cfg.skipDeclarationGuard === true,
    // Fallback for graphs that don't set rePersistenceThreshold; both shipped
    // graphs (discover, map) override it. Assembled here so detectors see a
    // consistent payload shape regardless of graph.
    rePersistenceThreshold: cfg.rePersistenceThreshold ?? {
      reCalls: RE_CALL_THRESHOLD,
      actions: 0,
    },
    triageWouldFire: opts.triageWouldFire,
    observedNotLifted,
    graph: session.graph ?? 'discover',
    observedCapabilityCount,
    httpFailureCount,
    unsavedHotXhrEndpoints,
    abandonedSaveAttemptsNotRetried: abandonedSaveAttemptsNotRetried.map((a) => ({
      capability: a.capability,
      kind: a.kind,
      at: a.at,
    })),
  };
}
