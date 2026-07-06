// End-drive detectors for unsaved read-only capabilities: the two siblings
// that refuse close (or, in the map graph, ask the agent to confirm deferral)
// when a session surfaced read candidates it never saved.
// `observed_capabilities_not_lifted` reads the record_observed_capability
// ledger; `unsaved_xhr_endpoints` reads the network log. Both register on the
// endDriveAudit instance in ./end-drive.

import type { Detector } from '../index';
import type { EndDrivePayload, EndDriveCtx } from './end-drive';
import { readPlatformSkillInfo } from '../../strategies/skills-list-helpers';

// ---------- Detector: observed_capabilities_not_lifted ----------
//
// Surfaces observed capabilities (via `record_observed_capability`) that were
// neither lifted into the session's declaredCapabilities (via
// `lift_observed_capability`) NOR landed as a successful save, so the agent
// can't drop breadcrumbs and silently walk away.
//
// Framing is graph-aware. The map graph carries both observe-only scans and
// "save every safe read-only capability" sweeps — the runtime can't tell them
// apart (both are graph 'map'), so unlifted observations are a legitimate
// terminal state: the message is a confirm-you-meant-to-defer, defer-ack
// leads, and lifting is opt-in. Other graphs keep the stronger "you dropped a
// save opportunity" framing with lifting as the primary path.
//
// ackReason: 'required' — legitimate ack path: "intentionally deferring
// these for next session because <structural reason>." validateAck demands
// the ack reason names each leftover slug verbatim (anti-canned: agents
// learn fast that `{reason: "deferred"}` won't pass).
//
// Releases at `endDriveAttempts >= 2` per the existing third-attempt
// escape hatch.

export const observedNotLiftedDetector: Detector<EndDrivePayload, EndDriveCtx> = {
  kind: 'observed_capabilities_not_lifted',
  ackReason: 'required',
  detect: (p) => {
    if (p.endDriveAttempts >= 2) return [];
    if (p.observedNotLifted.length === 0) return [];
    const slugs = p.observedNotLifted.slice(0, 20);
    const overflow =
      p.observedNotLifted.length > 20 ? `, …+${p.observedNotLifted.length - 20} more` : '';
    const slugList = slugs.map((s) => `\`${s}\``).join(', ') + overflow;
    // In the map graph the runtime can't tell an observe-only scan from a
    // "save every safe capability" sweep — both drive graph 'map'. Leaving
    // observations unlifted is a legitimate terminal state for the former, so
    // defer-ack leads and lifting is the opt-in. Other graphs keep the
    // save-first framing: there an unlifted candidate usually is a dropped
    // save opportunity.
    const mapGraph = p.graph === 'map';
    const ackClause =
      `ack with notes-like input: append to acks {"observed_capabilities_not_lifted": ` +
      `"deferring <slug1>, <slug2>, … because <structural reason>"} — the ack ` +
      `reason MUST name each leftover slug verbatim or the ack fails (anti-canned)`;
    const liftClause =
      `call lift_observed_capability({session_id, name: "<slug>"}) for each leftover, ` +
      `walk it through triage + save_strategy this session`;
    return [
      {
        kind: 'observed_capabilities_not_lifted',
        message: mapGraph
          ? `Before closing: this session recorded ${p.observedNotLifted.length} observed ` +
            `capability name(s) that weren't lifted into strategies: ${slugList}. That's a fine ` +
            `terminal state for an observe-only map — the observations persist to the logbook ` +
            `either way. Confirm you're deferring them (rather than dropping them by oversight).`
          : `CANNOT CLOSE: this session called record_observed_capability on ` +
            `${p.observedNotLifted.length} capability name(s) but never lifted them: ${slugList}. ` +
            `Each is a candidate the agent observed with structural evidence and then walked ` +
            `away from. Closing now drops the captured XHR / DOM context the next session ` +
            `would have to re-discover from cold start.`,
        hint: mapGraph
          ? `Default: defer them — ${ackClause}. ` +
            `Only if the user's task was to save these read-only capabilities, instead ` +
            `${liftClause}.`
          : `Two ways forward: (a) ${liftClause}; ` +
            `(b) if a leftover is genuinely deferral-worthy (auth-walled, ` +
            `paginated-listing-without-cursor, mutating-shape), ${ackClause}.`,
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

// ---------- Detector: unsaved_xhr_endpoints ----------
//
// Surfaces 2xx XHR responses on URL paths not covered by any saved strategy's
// endpoint template that also don't match an obvious tracking-shape heuristic —
// candidate read-only capabilities the runtime can see in the network log.
//
// Sibling of `observed_capabilities_not_lifted` — that detector reads the
// `record_observed_capability` ledger (what the agent explicitly noted), this
// detector reads the network log (structural evidence the runtime can see
// regardless of what the agent acknowledged). Together they close the gap
// where agents satisfy end_drive by adding cheap notes instead of lifting +
// saving. Framing is graph-aware for the same reason as the sibling: the map
// graph carries observe-only scans as well as save-everything sweeps, so a
// deferred read endpoint is a legitimate terminal state there — defer-ack
// leads, saving is the opt-in. Other graphs keep the save-first framing.
//
// ackReason: 'required'. The ack must name at least one URL path verbatim
// from the emitted list (anti-canned: a generic answer fails; the agent has
// to read what they're deferring). The reason text is free-form — "deferring
// <paths>" and "noise: <paths>" both pass, so the map-graph defer path needs
// no machinery change, only the hint that names it.
//
// Releases at `endDriveAttempts >= 2` per the existing third-attempt escape
// hatch.

export const unsavedXhrEndpointsDetector: Detector<EndDrivePayload, EndDriveCtx> = {
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
    // Graph-aware, same rationale as observed_capabilities_not_lifted: in the
    // map graph an observed-but-unsaved read endpoint is a legitimate deferred
    // terminal state (the session may have been an observe-only scan), so the
    // ack-defer path leads. validateAck only requires the reason to name the
    // paths verbatim — it never required the word "noise", so "deferring
    // <paths> — mapped for a future lift session" already passes; the map-graph
    // hint makes that explicit instead of implying save-or-call-it-noise.
    const mapGraph = p.graph === 'map';
    const saveClause =
      `for each path that's a real capability, call declare_capability + drive a ` +
      `minimal flow to capture the literal-bearing request, then save_strategy at fetch ` +
      `or page-script tier`;
    const ackClause =
      `ack with append to acks ` +
      `{"unsaved_xhr_endpoints": "<deferring|noise>: <urlPath1>, <urlPath2>, … — <structural reason>"}. ` +
      `The ack MUST name each path verbatim from the list above (anti-canned: a generic ` +
      `answer fails so the runtime forces you to read which paths you're deferring)`;
    return [
      {
        kind: 'unsaved_xhr_endpoints',
        message: mapGraph
          ? `Before closing: this session captured 2xx XHR responses on ${endpoints.length} ` +
            `URL path(s) not covered by any saved strategy:\n  ${list}\n` +
            `For an observe-only map that's fine — deferring them (naming the paths in an ack) ` +
            `is a clean close; they stay in the logbook for a future lift session. Confirm you're ` +
            `deferring rather than dropping them by oversight.`
          : `CANNOT CLOSE: this session captured 2xx XHR responses on ` +
            `${endpoints.length} URL path(s) that aren't covered by any saved ` +
            `strategy AND don't match an obvious tracking-shape heuristic ` +
            `(see runtime/docs/principles.md §Allowed runtime heuristics):\n  ${list}\n` +
            `Each is a candidate read-only capability the runtime can see in your network log. ` +
            `add_discovery_note doesn't clear this gate; save_strategy does.`,
        hint: mapGraph
          ? `Default: defer them — ${ackClause}. ` +
            `Only if the user's task was to save these read-only capabilities, instead ${saveClause}.`
          : `Two ways forward: (a) ${saveClause}; ` +
            `(b) for paths that are genuine noise (tracking, telemetry, marketing pixel that ` +
            `slipped the heuristic), ${ackClause}.`,
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
