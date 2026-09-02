// Platform logbook: load / update the per-platform summary file.
//
// logbook.json is the agent-facing surface surfaced through
// get_platform_logbook. Session archives on disk are the source of truth;
// logbook.json is the fast-to-read derived rollup, updated on every session
// flush.

import fs from 'fs';
import {
  type CapabilityLogbookEntry,
  isPlatformLogbook,
  type ObservedPlatformCapability,
  type PlatformLogbook,
  type StrategyEvent,
  type StrategyEventKind,
} from './schema';
import { ensurePlatformDirs, logbookPath } from './layout';
import {
  asBoundedString,
  asNonEmptyString,
  asObject,
  asPlatformSlug,
  asIdentifierSlug,
  ValidationError,
} from '../validators';
import { didYouMeanSuffix } from '../utils/string-distance';
import { STRATEGY_TIERS, type AbortProvenance } from '../vocab';
import { updateJsonFile, writeTextAtomically, type JsonFileCodec } from '../utils/owner-file-lock';
import { onSessionDispose, removeSessionDisposeHook } from '../pool/session-scope';
import type { AbortKind } from './schema';

function emptyLogbook(platform: string): PlatformLogbook {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    platform,
    created_at: now,
    updated_at: now,
    sessions_total: 0,
    per_capability: {},
    platform_wide: {
      signer_functions_seen: [],
      bundle_drift_events: [],
      abort_events: [],
    },
    observed_capabilities: [],
    url_graph: { nodes: [], edges: [] },
    forms_seen: [],
  };
}

function emptyCapabilityEntry(): CapabilityLogbookEntry {
  return {
    sessions_contributed: 0,
    last_session_at: '',
    last_session_id: '',
    lift_attempts: [],
    strategy_events: [],
    current_tier: 'none',
  };
}

function logbookCodec(platform: string): JsonFileCodec<PlatformLogbook> {
  return {
    read: (raw) => {
      if (raw !== null) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isPlatformLogbook(parsed)) return parsed;
        } catch {
          /* unreadable → fall through to empty */
        }
      }
      return emptyLogbook(platform);
    },
    write: (logbook) =>
      JSON.stringify({ ...logbook, updated_at: new Date().toISOString() }, null, 2),
  };
}

/**
 * Load the platform logbook. Returns an empty logbook when the file is missing
 * or has the wrong schema — klura isn't released yet, so we don't attempt to
 * migrate drifted shapes. See feedback_no_backwards_compat.md.
 */
export function loadLogbook(platform: string): PlatformLogbook {
  const codec = logbookCodec(platform);
  try {
    return codec.read(fs.readFileSync(logbookPath(platform), 'utf8'));
  } catch {
    return codec.read(null);
  }
}

/**
 * Serialized read-modify-write over the platform logbook. Every logbook
 * mutation (session flush, strategy events, observed capabilities, abort
 * events, acked noise endpoints, triage plans) routes through here so
 * concurrent writers — including writers in other processes — never lose each
 * other's updates. Bumps updated_at on write; returning `null` from `mutate`
 * skips the write. Creates platform dirs if missing.
 */
export function updateLogbook(
  platform: string,
  mutate: (logbook: PlatformLogbook) => PlatformLogbook | null,
): void {
  ensurePlatformDirs(platform);
  updateJsonFile(logbookPath(platform), logbookCodec(platform), mutate);
}

/**
 * Atomically replace the logbook on disk. Bumps updated_at. Creates platform
 * dirs if missing. Full-replace surface — read-modify-write callers use
 * `updateLogbook`, which serializes against concurrent writers.
 */
export function writeLogbook(logbook: PlatformLogbook): void {
  ensurePlatformDirs(logbook.platform);
  writeTextAtomically(logbookPath(logbook.platform), logbookCodec(logbook.platform).write(logbook));
}

/**
 * Get or create the capability entry on a logbook. Mutates the logbook.
 */
export function ensureCapabilityEntry(
  logbook: PlatformLogbook,
  capability: string,
): CapabilityLogbookEntry {
  let entry = logbook.per_capability[capability];
  if (!entry) {
    entry = emptyCapabilityEntry();
    logbook.per_capability[capability] = entry;
  }
  return entry;
}

/**
 * Recency helpers — recompute days_since_last_attempt +
 * sessions_since_last_attempt from the lift_attempts ledger. Called after every
 * lift_attempt append so the entry's recency stats are always fresh.
 */
export function refreshRecencyStats(
  entry: CapabilityLogbookEntry,
  sessionsTotalAcrossPlatform: number,
): void {
  const last = entry.lift_attempts[entry.lift_attempts.length - 1];
  if (!last) {
    delete entry.last_lift_attempt_at;
    delete entry.days_since_last_attempt;
    delete entry.sessions_since_last_attempt;
    return;
  }
  entry.last_lift_attempt_at = last.attempted_at;
  const lastMs = Date.parse(last.attempted_at);
  if (Number.isFinite(lastMs)) {
    entry.days_since_last_attempt = Math.max(
      0,
      Math.floor((Date.now() - lastMs) / (24 * 60 * 60 * 1000)),
    );
  }
  // sessions_since_last_attempt tracks how many platform sessions have happened
  // since the recorded attempt — tells the agent "has the environment drifted
  // since I tried?" The logbook bumps sessions_total on each session flush, and
  // each lift_attempt snapshots the total at attempt time, so the delta is the
  // true count of intervening sessions. Absent snapshot → leave it unknown
  // rather than report a wrong number.
  if (typeof last.sessions_total_at_attempt === 'number') {
    entry.sessions_since_last_attempt = Math.max(
      0,
      sessionsTotalAcrossPlatform - last.sessions_total_at_attempt,
    );
  } else {
    delete entry.sessions_since_last_attempt;
  }
}

/**
 * Append a strategy life-cycle event (discovered / rediscovered / tier_demote /
 * archived / unarchived / patched / healed) to the per-capability logbook
 * entry. Creates the logbook + capability entry if either is missing.
 *
 * Writers: `saveStrategy`, `patchStep`, `archiveStrategy`, `unarchiveStrategy`,
 * `demoteFetchToPageScript`, `markHealed`. See
 * `runtime/docs/logbook.md#strategy-events`.
 */
export function appendStrategyEvent(
  platform: string,
  capability: string,
  event: { strategy: string; kind: StrategyEventKind; detail?: string },
): void {
  updateLogbook(platform, (logbook) => {
    const entry = ensureCapabilityEntry(logbook, capability);
    if (!Array.isArray(entry.strategy_events)) {
      entry.strategy_events = [];
    }
    const record: StrategyEvent = {
      at: new Date().toISOString(),
      strategy: event.strategy,
      kind: event.kind,
    };
    if (event.detail !== undefined && event.detail !== '') {
      record.detail = event.detail;
    }
    entry.strategy_events.push(record);

    // Keep `current_tier` in sync with the active strategy. Events that establish
    // or change the live tier stamp it; archiving the active tier clears it back
    // to 'none' (a later rediscovery / unarchive re-establishes it).
    const eventTier = STRATEGY_TIERS.find((t) => t === event.strategy);
    if (event.kind === 'archived') {
      if (entry.current_tier === event.strategy) entry.current_tier = 'none';
    } else if (eventTier) {
      entry.current_tier = eventTier;
    }

    return logbook;
  });
}

const OBSERVED_WHY_NOT_LIFTED_VALUES = [
  'separate_capability',
  'turn_budget',
  'unverified',
  'blocked',
  'other',
] as const;
const OBSERVED_HYPOTHESIS_MAX = 800;

/**
 * Per-session tracking of which observed-capability names have already bumped
 * `observed_in_sessions` during the current session. Ensures a single session
 * calling `record_observed_capability` multiple times for the same name only
 * contributes once to the counter.
 */
const observedBumpedPerSession = new Map<string, Set<string>>();

// Session-scope hook name — registered on the first observed-capability bump
// for a session id, so the dedupe set dies with the session on any close
// path. See runtime/src/pool/session-scope.ts.
const OBSERVED_TRACKING_HOOK = 'observed-session-tracking';

/**
 * Clear the per-session dedupe set for observed_capabilities bumps eagerly.
 * Session close paths don't need to call this — the session-scope disposer
 * registered on first write covers every close path via `pool.endDrive`.
 */
export function clearObservedSessionTracking(sessionId: string): void {
  observedBumpedPerSession.delete(sessionId);
  removeSessionDisposeHook(sessionId, OBSERVED_TRACKING_HOOK);
}

/**
 * Capability names this session called `record_observed_capability` on.
 * Used by the end-drive audit's observed-not-lifted detector to refuse close
 * when the agent recorded observations but never lifted them. Returns a
 * snapshot array (order undefined); empty when the session made no
 * observations.
 */
export function getObservedNamesForSession(sessionId: string): string[] {
  const s = observedBumpedPerSession.get(sessionId);
  return s ? [...s] : [];
}
export interface ObservedCapabilityInput {
  name: string;
  evidence: { source: string; [k: string]: unknown };
  why_not_lifted: string;
  hypothesis?: string;
  session_id?: string;
}

/**
 * Record a companion capability the agent observed but didn't lift. Writes to
 * the platform logbook's `observed_capabilities[]` slot (dedup by name). Repeat
 * calls within the same session only bump `observed_in_sessions` once; future
 * sessions bump it again.
 *
 * Shape validation runs here (not in save-time validators) because observed
 * capabilities live on the platform logbook, not in strategy `notes`.
 */
export function recordObservedCapability(platform: string, input: ObservedCapabilityInput): void {
  try {
    asPlatformSlug(platform, 'platform');
    asIdentifierSlug(input.name, 'name');
    const evidence = asObject(input.evidence, 'evidence');
    asNonEmptyString(evidence.source, 'evidence.source');
    const why = asNonEmptyString(input.why_not_lifted, 'why_not_lifted');
    if (!OBSERVED_WHY_NOT_LIFTED_VALUES.includes(why as never)) {
      const allowedValues = OBSERVED_WHY_NOT_LIFTED_VALUES.map((v) => `"${v}"`).join(', ');
      const suggestion = didYouMeanSuffix(why, OBSERVED_WHY_NOT_LIFTED_VALUES as readonly string[]);
      throw new ValidationError('why_not_lifted', `must be one of: ${allowedValues}${suggestion}`);
    }
    if (input.hypothesis !== undefined) {
      asBoundedString(input.hypothesis, 'hypothesis', OBSERVED_HYPOTHESIS_MAX);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_observed_capability: ${e.message}`, { cause: e });
    }
    throw e;
  }

  updateLogbook(platform, (logbook) => {
    if (!Array.isArray(logbook.observed_capabilities)) {
      logbook.observed_capabilities = [];
    }
    const now = new Date().toISOString();

    const sessionBumped = input.session_id
      ? (observedBumpedPerSession.get(input.session_id) ?? new Set<string>())
      : null;
    if (sessionBumped && input.session_id) {
      const sessionId = input.session_id;
      observedBumpedPerSession.set(sessionId, sessionBumped);
      onSessionDispose(sessionId, OBSERVED_TRACKING_HOOK, () => {
        observedBumpedPerSession.delete(sessionId);
      });
    }

    const existing = logbook.observed_capabilities.find((e) => e.name === input.name);
    if (existing) {
      existing.evidence = input.evidence;
      existing.why_not_lifted = input.why_not_lifted;
      if (input.hypothesis !== undefined) existing.hypothesis = input.hypothesis;
      existing.last_observed_at = now;
      if (!sessionBumped || !sessionBumped.has(input.name)) {
        existing.observed_in_sessions += 1;
        sessionBumped?.add(input.name);
      }
    } else {
      const record: ObservedPlatformCapability = {
        name: input.name,
        evidence: input.evidence,
        why_not_lifted: input.why_not_lifted,
        first_observed_at: now,
        last_observed_at: now,
        observed_in_sessions: 1,
      };
      if (input.hypothesis !== undefined) record.hypothesis = input.hypothesis;
      logbook.observed_capabilities.push(record);
      sessionBumped?.add(input.name);
    }
    return logbook;
  });
}

export interface AbortEventInput {
  session_id: string;
  reason: string;
  /** Optional machine-actionable kind discriminator. Older callers omit
   *  this; historical ledger entries also lack it. Readers default to
   *  `'other'` when absent. */
  kind?: AbortKind;
  /** Host that was aborted on. Lets the start_session pre-nav check
   *  match historical aborts to the requested URL by host without
   *  parsing free-text `reason`. */
  host?: string;
  /** Where `kind` came from. Omit for an agent's own classification — the
   *  reader defaults to `'agent_asserted'`, which is what an uncorroborated
   *  claim is. `'runtime_observed'` is reserved for a claim the runtime's own
   *  detector independently corroborated on the same host. */
  provenance?: AbortProvenance;
  /** Structural signals behind a `runtime_observed` entry. */
  signals?: readonly string[];
  captured_actions_count: number;
  phase_at_abort: string;
}

/** Newest N abort events kept per platform. The ledger is a replay surface for
 *  future sessions, not an archive — older entries can neither be read (the
 *  read cap is an order of magnitude smaller) nor scored (the escalation
 *  window is 24h). */
const ABORT_EVENT_CAP = 200;
/** Age past which an abort event is dropped on the next write. */
const ABORT_EVENT_TTL_MS = 30 * 24 * 3_600_000;

/** True when `event` is older than the ledger TTL. Entries whose timestamp
 *  doesn't parse are kept — corrupt data is bounded by the ring buffer, and
 *  silently deleting what we can't reason about is worse. */
function isExpiredAbortEvent(event: { at: string }, now: number): boolean {
  const at = Date.parse(event.at);
  return Number.isFinite(at) && now - at > ABORT_EVENT_TTL_MS;
}

/**
 * Append an abort_session event to the platform-wide log. Cross-session
 * visibility — the agent reads recent_aborts at session start to learn from
 * prior wrong starts on this platform. Defensive-init: pre-existing logbooks
 * (no abort_events field) are upgraded in place rather than discarded, same
 * pattern as `observed_capabilities`.
 *
 * Bounded at write time, no background job: expired entries are pruned, an
 * append that repeats the newest entry's `session_id` + `kind` + `host` is
 * dropped (one session's retried abort must not read as a pattern), and the
 * list is trimmed to the newest `ABORT_EVENT_CAP`.
 */
export function appendAbortEvent(platform: string, input: AbortEventInput): void {
  updateLogbook(platform, (logbook) => {
    const wide = logbook.platform_wide as PlatformLogbook['platform_wide'] & {
      abort_events?: PlatformLogbook['platform_wide']['abort_events'];
    };
    if (!Array.isArray(wide.abort_events)) {
      wide.abort_events = [];
    }
    const now = Date.now();
    const kept = wide.abort_events.filter((e) => !isExpiredAbortEvent(e, now));
    const newest = kept.at(-1);
    const duplicate =
      newest !== undefined &&
      newest.session_id === input.session_id &&
      (newest.kind ?? 'other') === (input.kind ?? 'other') &&
      (newest.host ?? '') === (input.host ?? '');
    if (duplicate) {
      wide.abort_events = kept;
      return logbook;
    }
    kept.push({
      at: new Date(now).toISOString(),
      session_id: input.session_id,
      reason: input.reason,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
      ...(input.signals !== undefined && input.signals.length > 0
        ? { signals: [...input.signals] }
        : {}),
      captured_actions_count: input.captured_actions_count,
      phase_at_abort: input.phase_at_abort,
    });
    wide.abort_events = kept.length > ABORT_EVENT_CAP ? kept.slice(-ABORT_EVENT_CAP) : kept;
    return logbook;
  });
}

/**
 * Append acked-as-noise XHR endpoint paths to the platform-wide log, deduped.
 * The `unsaved_xhr_endpoints` end-drive gate reads these in future sessions and
 * subtracts them so the same telemetry/sensor paths aren't re-prompted every
 * close. Defensive-init: pre-existing logbooks (no field) are upgraded in
 * place, same pattern as `abort_events`.
 */
export function appendAckedNoiseEndpoints(platform: string, paths: readonly string[]): void {
  const clean = paths.filter((p) => typeof p === 'string' && p.length > 0);
  if (clean.length === 0) return;
  updateLogbook(platform, (logbook) => {
    const wide = logbook.platform_wide;
    const existing = Array.isArray(wide.acked_noise_endpoints) ? wide.acked_noise_endpoints : [];
    wide.acked_noise_endpoints = Array.from(new Set([...existing, ...clean]));
    return logbook;
  });
}

/** Read the platform's acked-as-noise XHR endpoint paths (empty if none).
 *  Used by the unsaved_xhr gate to subtract previously-acked noise. */
export function readAckedNoiseEndpoints(platform: string): string[] {
  const logbook = loadLogbook(platform);
  const wide = logbook.platform_wide;
  return Array.isArray(wide.acked_noise_endpoints) ? wide.acked_noise_endpoints : [];
}

/** Computed-enrichment shape on each abort_event the readRecentAborts
 *  caller gets. `hours_since` saves the caller from parsing ISO
 *  timestamps to calibrate freshness. */
export interface AbortEventRead {
  at: string;
  session_id: string;
  reason: string;
  kind?: AbortKind;
  host?: string;
  /** Always present on read: entries persisted without the field are
   *  `'agent_asserted'` — an agent's claim is exactly what an unstamped
   *  historical entry recorded. */
  provenance: AbortProvenance;
  signals?: string[];
  captured_actions_count: number;
  phase_at_abort: string;
  /** Hours since the abort fired, rounded to one decimal. Computed on read. */
  hours_since: number;
}

/**
 * Read the most recent abort events for a platform, newest first. Capped at
 * `limit` (default 10) so the surface stays compact for agent reads.
 * Each entry is enriched with `hours_since` so readers don't have to parse
 * ISO timestamps to calibrate "is this fresh enough to short-circuit on."
 */
export function readRecentAborts(platform: string, limit = 10): AbortEventRead[] {
  const logbook = loadLogbook(platform);
  const wide = logbook.platform_wide as PlatformLogbook['platform_wide'] & {
    abort_events?: PlatformLogbook['platform_wide']['abort_events'];
  };
  const events = Array.isArray(wide.abort_events) ? wide.abort_events : [];
  const now = Date.now();
  return [...events]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, Math.max(0, limit))
    .map((e) => {
      const enriched: AbortEventRead = {
        at: e.at,
        session_id: e.session_id,
        reason: e.reason,
        provenance: e.provenance ?? 'agent_asserted',
        captured_actions_count: e.captured_actions_count,
        phase_at_abort: e.phase_at_abort,
        hours_since: Math.round(((now - Date.parse(e.at)) / 3600000) * 10) / 10,
      };
      if (e.kind !== undefined) enriched.kind = e.kind;
      if (e.host !== undefined) enriched.host = e.host;
      if (Array.isArray(e.signals) && e.signals.length > 0) enriched.signals = [...e.signals];
      return enriched;
    });
}

/**
 * Read the platform's observed_capabilities slot. Surface for list_platform_skills.
 */
export function readObservedCapabilities(platform: string): ObservedPlatformCapability[] {
  const logbook = loadLogbook(platform);
  return Array.isArray(logbook.observed_capabilities) ? [...logbook.observed_capabilities] : [];
}

/**
 * Read the platform's url_graph slot. Empty graph when the logbook is missing.
 */
export function readUrlGraph(platform: string): PlatformLogbook['url_graph'] {
  const logbook = loadLogbook(platform);
  if (!Array.isArray(logbook.url_graph.nodes)) {
    return { nodes: [], edges: [] };
  }
  return {
    nodes: [...logbook.url_graph.nodes],
    edges: [...logbook.url_graph.edges],
  };
}

/**
 * Read the platform's forms_seen slot. Empty list when the logbook is missing.
 */
export function readFormsSeen(platform: string): PlatformLogbook['forms_seen'] {
  const logbook = loadLogbook(platform);
  return Array.isArray(logbook.forms_seen) ? [...logbook.forms_seen] : [];
}

export interface StrategyEventRecord extends StrategyEvent {
  capability: string;
}

/**
 * Read strategy life-cycle events across the platform, most recent first,
 * capped at `limit`. Pass `capability` to narrow to a single capability.
 */
export function readStrategyEvents(
  platform: string,
  capability?: string,
  limit = 50,
): StrategyEventRecord[] {
  const logbook = loadLogbook(platform);
  const out: StrategyEventRecord[] = [];
  const entries = Object.entries(logbook.per_capability);
  for (const [cap, entry] of entries) {
    if (capability && cap !== capability) continue;
    const events = Array.isArray(entry.strategy_events) ? entry.strategy_events : [];
    for (const ev of events) {
      out.push({ capability: cap, ...ev });
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, Math.max(0, limit));
}
