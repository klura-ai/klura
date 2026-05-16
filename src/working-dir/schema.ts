// Platform working dir — capture-event model + disk schema.
//
// The working dir is klura's per-platform persistent archive. Every session
// (today: agent-driven) flushes a stream of CaptureEvents at end_drive;
// these modules partition them into session archives and update a platform-
// level logbook. Cross-run derived signals (field-stability, bundle-drift,
// signer-history) are computed from the archives.
//
// Critical design rule: this module accepts a CaptureEvent[] stream. It has
// zero dependency on runtime Session / pool / driver / MCP types. The only
// bridge is a thin adapter in runtime/src/index.ts that reshapes live session
// state into CaptureEvents at end_drive time. Keep the asymmetry: the
// adapter knows about both layers, these modules don't.

// ---------------------------------------------------------------------------
// Capture event stream — the only input shape these modules accept.
// ---------------------------------------------------------------------------

export type CaptureEventKind =
  | 'http_request'
  | 'ws_frame'
  | 'perform_action'
  | 'tool_call'
  | 'bundle_seen'
  | 'storage_state'
  | 'session_meta'
  | 'lift_attempt'
  | 'dom_navigation'
  | 'dom_form_observed';

export interface CaptureEvent {
  /** Unix-ms timestamp of the observation. */
  at: number;
  /**
   * Caller-chosen session identifier. Not tied to any pool; any opaque string.
   */
  session_id: string;
  /** Platform slug the event belongs to. */
  platform: string;
  /** Optional capability slug. Bound when the session declared a capability. */
  capability?: string;
  kind: CaptureEventKind;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Per-event payload shapes. Narrowed by discriminating on `kind`.
// ---------------------------------------------------------------------------

export interface HttpRequestPayload {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Optional request body; stringified JSON or raw string. */
  postData?: string | null;
  status?: number;
  contentType?: string;
  /** Response body size or string — caller decides. */
  responseBody?: unknown;
  responseSize?: number;
}

export interface WsFramePayload {
  direction: 'sent' | 'received';
  url: string;
  /** Base64-encoded for binary frames, utf-8 string for text frames. */
  payload: string;
  encoding: 'text' | 'binary';
  /** Optional send-site callstack if capture included one. */
  js_callstack?: Array<{ file: string; line?: number; column?: number }>;
}

export interface PerformActionPayload {
  action: string;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
}

export interface ToolCallPayload {
  tool: string;
  /** Short digest of args — not the args themselves (PII-aware). */
  args_digest: string;
  outcome: 'ok' | 'error';
  /** Extra structured detail per-tool (e.g. byte-diff on try_generator). */
  detail?: Record<string, unknown>;
}

export interface BundleSeenPayload {
  url: string;
  sha256: string;
  /** Optional size in bytes, if known at capture time. */
  size?: number;
  /** Raw source bytes; written to the content-addressable archive. Omit to
   *  just record the sighting without archiving. */
  bytes?: string;
}

export interface StorageStatePayload {
  /** JSON blob in Playwright's storage-state shape. */
  storage_state: unknown;
}

export interface SessionMetaPayload {
  started_at: number;
  ended_at: number;
  /** Primary capability the session declared, if any. */
  capability?: string;
  /** Caller-supplied args for the capability. */
  args?: Record<string, string>;
  /** Final outcome reported by the caller. */
  outcome:
    | 'fetch_saved'
    | 'page_script_saved'
    | 'recorded_path_saved'
    | 'no_save'
    | 'user_deferred'
    | 'error';
  /** Free-text prose, ≤500 chars, optional. */
  notes?: string;
}

/**
 * Agent- or driver-observed navigation. One event per URL the session lands
 * on; the writer folds the stream into the platform url_graph by pairing
 * adjacent entries into edges.
 *
 * Emitted from runtime/src/index.ts on `start_session` navigate and
 * `perform_action({action: "navigate"})`, plus from the playwright driver's
 * SPA-route init script (history.pushState / replaceState / popstate /
 * hashchange) which feeds the same `pendingNavs` buffer that
 * `consumePendingNavs` drains.
 */
export interface DomNavigationPayload {
  url: string;
  title?: string;
  /** Transition kind into this URL. `nav` = top-level navigation; `click` =
   *  clicked link; `submit` = form submission; `pushState` / `replaceState`
   *  / `popstate` / `hashchange` = SPA client-side routing. */
  via?: 'nav' | 'click' | 'submit' | 'pushState' | 'replaceState' | 'popstate' | 'hashchange';
}

/**
 * A form surfaced in the DOM. Observed once per (url, action, method) tuple;
 * the writer merges field lists across sessions.
 *
 * Driver-side form capture is pending — see the `platform-map: emit
 * dom_form_observed` note in runtime/src/index.ts. Once wired, the driver
 * snapshots `<form>` elements after each perform_action / a11y read and
 * folds them onto `session.domFormsObserved`.
 */
export interface DomFormObservedPayload {
  /** Page URL the form lives on. */
  url: string;
  /** Form `action` attribute. */
  action: string;
  method: string;
  fields: Array<{ name: string; type: string; required?: boolean }>;
}

export interface LiftAttemptPayload {
  /** The tier the attempt landed on (or 'none' if no save). */
  outcome: SessionMetaPayload['outcome'];
  rounds_spent: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// On-disk shapes.
// ---------------------------------------------------------------------------

/**
 * Per-session archive written to
 * `~/.klura/workdir/<platform>/sessions/<session_id>/`. Each field is a
 * separate JSON file on disk so readers can pick the slice they need without
 * loading the whole archive.
 */
export interface SessionArchive {
  schema_version: 1;
  session_id: string;
  platform: string;
  meta: SessionMetaPayload;
  /** Raw HTTP requests as captured. No size trimming here — disk is cheap;
   *  readers use sliceLargeString when surfacing through agent-facing tools. */
  http: HttpRequestPayload[];
  ws: WsFramePayload[];
  actions: PerformActionPayload[];
  /** Per-tool call ledger. Shape matches what ArtifactAccumulator tracks
   *  in-session, flattened + persisted here. */
  tool_trace: ToolCallPayload[];
  /** SHA list of bundles this session loaded. Actual bytes live in the
   *  platform-level content-addressable bundles/ dir. */
  bundle_shas: Array<{ url: string; sha256: string; size?: number }>;
  /** Path to the storage-state snapshot for this session (relative to the
   *  session dir). null when no snapshot was taken. */
  storage_state_file: string | null;
}

/**
 * Platform-level summary written to `~/.klura/workdir/<platform>/logbook.json`.
 * The agent-facing surface reads this directly. Derived signals
 * (field-stability, bundle-history, signer-history) are computed lazily from
 * session archives and stored in derived/ for fast re-reads.
 */
export interface PlatformLogbook {
  schema_version: 1;
  platform: string;
  created_at: string;
  updated_at: string;
  sessions_total: number;
  per_capability: Record<string, CapabilityLogbookEntry>;
  platform_wide: {
    signer_functions_seen: Array<{
      name: string;
      first_seen: string;
      last_seen: string;
      sessions: number;
    }>;
    bundle_drift_events: Array<{
      at: string;
      bundle_url: string;
      prior_sha: string;
      new_sha: string;
    }>;
    /**
     * Sessions the agent explicitly aborted via `abort_session`. Cross-session
     * visibility — future agents starting on the same platform can read
     * `recent_aborts` (capped server-side) to learn from prior wrong starts
     * (e.g. "session N aborted because existing capability search_products
     * covers this — use execute next time").
     */
    abort_events: Array<{
      at: string;
      session_id: string;
      reason: string;
      captured_actions_count: number;
      phase_at_abort: string;
    }>;
  };
  /**
   * Platform-level record of "sibling capabilities the agent saw across
   * sessions but didn't lift." Dedup-by-name: repeated observations update
   * `last_observed_at` and bump `observed_in_sessions` once per session.
   * Agent-written via the `record_observed_capability` MCP tool. Readers
   * surface these through `list_platform_skills` as a per-platform slot.
   */
  observed_capabilities: ObservedPlatformCapability[];
  /**
   * Cross-session URL graph. Nodes are normalized URLs (see
   * `normalizeUrlForGraph` in working-dir/url-graph.ts); edges pair adjacent
   * navigations within a single session. `session_count` on a node counts
   * distinct sessions that visited the URL.
   */
  url_graph: {
    nodes: Array<{
      url: string;
      title?: string;
      first_visited: string;
      last_visited: string;
      session_count: number;
    }>;
    edges: Array<{
      from: string;
      to: string;
      via?: DomNavigationPayload['via'];
    }>;
  };
  /**
   * Cross-session form inventory. One entry per (normalized url, normalized
   * action, method) tuple. `fields` is the union of field specs seen across
   * observations — latest type wins on conflict.
   */
  forms_seen: Array<{
    url: string;
    action: string;
    method: string;
    fields: Array<{ name: string; type: string; required?: boolean }>;
    first_seen: string;
    last_seen: string;
  }>;
}

export interface ObservedPlatformCapability {
  /** Canonical capability name, slug-shaped. */
  name: string;
  /** Evidence pointer. `source` identifies where the observation came from
   *  ('network' captured XHR/WS, 'ui' DOM affordance, etc.); additional
   *  fields are source-specific and carried opaquely. */
  evidence: { source: string; [k: string]: unknown };
  /** Agent's closed-enum reason the observation wasn't lifted. */
  why_not_lifted: string;
  /** Optional structural hypothesis, ≤800 chars. */
  hypothesis?: string;
  first_observed_at: string;
  last_observed_at: string;
  observed_in_sessions: number;
}

export type StrategyEventKind =
  | 'discovered'
  | 'rediscovered'
  | 'tier_demote'
  | 'archived'
  | 'unarchived'
  | 'patched'
  | 'healed';

export interface StrategyEvent {
  /** ISO timestamp. */
  at: string;
  /**
   * Strategy tier the event is about (e.g. 'fetch', 'page-script',
   * 'recorded-path').
   */
  strategy: string;
  kind: StrategyEventKind;
  /** Optional free-text context (e.g. "graduated from recorded-path"). */
  detail?: string;
}

/** Defense-surface observations the agent gathered during triage. The
 *  agent draws `mechanism_hypothesis` and `request_patterns` from its own
 *  knowledge of bot-detection technology — the runtime never names
 *  vendors. The other arrays are concrete cite-able artifacts that
 *  `tier_justification` is validated against. */
export interface DefenseSurface {
  observed_origins: string[];
  observed_scripts: string[];
  cookies_set: string[];
  request_patterns: string[];
  mechanism_hypothesis: string;
}

/** Durable plan written by the agent during the triage phase. One plan per
 *  surface (agent-supplied `surface_label`, e.g. `"checkout"`,
 *  `"product_page"`); a single capability can carry several plans when it
 *  spans multiple surfaces with different defense postures. The shorter
 *  `summary_for_user` is what the `triage_plan` checkpoint surfaces for
 *  user ack — the full plan is never shown verbatim to a non-developer
 *  user.
 *
 *  Tier suggestion is informational, not gating: the agent still aims
 *  T0 → T1 → T2 in order. The justified verdict shapes user expectation +
 *  escalation hygiene, not the attempt order. */
export interface TriagePlan {
  recorded_at: string;
  session_id: string;
  /** Agent-supplied semantic name for the surface this plan covers. */
  surface_label: string;
  /** URLs that were live in the session at submit time (server-derived
   *  from `session.domNavigations` between triage entry and submission).
   *  Drives the URL→surface binding the runtime uses to detect when a
   *  later navigation crosses to an un-triaged surface. */
  observed_at_urls: string[];
  defense_surface: DefenseSurface;
  expected_tier: 'fetch' | 'page-script' | 'recorded-path';
  /** Free-text justification for the tier suggestion. Runtime cite-validated
   *  to reference at least one entry in `defense_surface.observed_origins`,
   *  `defense_surface.observed_scripts`, `defense_surface.cookies_set`, or
   *  `observed_at_urls` (verbatim substring, word-bounded). */
  tier_justification: string;
  summary_for_user: string;
}

export interface CapabilityLogbookEntry {
  sessions_contributed: number;
  last_session_at: string;
  last_session_id: string;
  lift_attempts: Array<{
    session_id: string;
    attempted_at: string;
    outcome: LiftAttemptPayload['outcome'];
    rounds_spent: number;
    notes?: string;
  }>;
  /**
   * Strategy life-cycle events for this capability — discovered, rediscovered,
   * tier_demote, archived, unarchived, patched, healed. Append-only; producers
   * are `saveStrategy`, `patchStep`, `archiveStrategy`, `unarchiveStrategy`,
   * `demoteFetchToPageScript`, `markHealed`.
   */
  strategy_events: StrategyEvent[];
  current_tier: 'fetch' | 'page-script' | 'recorded-path' | 'none';
  data_sufficiency: {
    captures_of_target_endpoint: number;
    field_stability_confidence: 'low' | 'medium' | 'high';
    known_rotating_fields: string[];
    known_stable_fields: string[];
    ambiguous_fields: string[];
  };
  last_lift_attempt_at?: string;
  days_since_last_attempt?: number;
  sessions_since_last_attempt?: number;
  /** Most recent plan submitted via `submit_triage_plan` for this capability,
   *  keyed by `surface_label`. Re-plans for the same surface overwrite the
   *  current entry and rotate the prior into `triage_plan_history_by_surface`. */
  triage_plans_by_surface?: Record<string, TriagePlan>;
  /** Per-surface history. Capped at the last 5 plans per surface, oldest
   *  dropped on overflow. */
  triage_plan_history_by_surface?: Record<string, TriagePlan[]>;
}

// ---------------------------------------------------------------------------
// Hard validation on read. klura isn't released yet — on-disk shape drift is
// handled by discarding and rebuilding, not by tolerant migration. See
// feedback_no_backwards_compat.md.
//
// Validation depth mirrors the runtime's write surface: the top-level keys
// the writers populate are checked, nested item shapes ride .loose() so a
// minor field addition to e.g. a strategy_event doesn't blast the whole
// logbook on the next read.
// ---------------------------------------------------------------------------

import { z } from 'zod';

const platformLogbookSchemaZ = z.looseObject({
  schema_version: z.literal(1),
  platform: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  sessions_total: z.number(),
  per_capability: z.record(z.string(), z.unknown()),
  platform_wide: z.looseObject({}),
  observed_capabilities: z.array(z.unknown()),
  url_graph: z.looseObject({
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
  }),
  forms_seen: z.array(z.unknown()),
});

const sessionArchiveSchemaZ = z.looseObject({
  schema_version: z.literal(1),
  session_id: z.string(),
  platform: z.string(),
  meta: z.looseObject({}),
  http: z.array(z.unknown()),
  ws: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  tool_trace: z.array(z.unknown()),
  bundle_shas: z.array(z.unknown()),
});

export function isPlatformLogbook(v: unknown): v is PlatformLogbook {
  return platformLogbookSchemaZ.safeParse(v).success;
}

export function isSessionArchive(v: unknown): v is SessionArchive {
  return sessionArchiveSchemaZ.safeParse(v).success;
}
