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
    data_sufficiency: {
      captures_of_target_endpoint: 0,
      field_stability_confidence: 'low',
      known_rotating_fields: [],
      known_stable_fields: [],
      ambiguous_fields: [],
    },
  };
}

/**
 * Load the platform logbook. Returns an empty logbook when the file is missing
 * or has the wrong schema — klura isn't released yet, so we don't attempt to
 * migrate drifted shapes. See feedback_no_backwards_compat.md.
 */
export function loadLogbook(platform: string): PlatformLogbook {
  const p = logbookPath(platform);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isPlatformLogbook(parsed)) return parsed;
  } catch {
    /* file missing / unreadable → fall through to empty */
  }
  return emptyLogbook(platform);
}

/**
 * Atomically write the logbook to disk. Bumps updated_at. Creates platform dirs
 * if missing.
 */
export function writeLogbook(logbook: PlatformLogbook): void {
  ensurePlatformDirs(logbook.platform);
  const updated: PlatformLogbook = {
    ...logbook,
    updated_at: new Date().toISOString(),
  };
  const p = logbookPath(logbook.platform);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
  fs.renameSync(tmp, p);
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
  // since I tried?" The logbook bumps sessions_total on each session flush; we
  // store the delta.
  entry.sessions_since_last_attempt = Math.max(
    0,
    sessionsTotalAcrossPlatform - entry.sessions_contributed,
  );
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
  const logbook = loadLogbook(platform);
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
  writeLogbook(logbook);
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

/**
 * Clear the per-session dedupe set for observed_capabilities bumps. Called at
 * close_session so the session id can be reused cleanly.
 */
export function clearObservedSessionTracking(sessionId: string): void {
  observedBumpedPerSession.delete(sessionId);
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
      throw new ValidationError('why_not_lifted', `must be one of: ${allowedValues}`);
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

  const logbook = loadLogbook(platform);
  if (!Array.isArray(logbook.observed_capabilities)) {
    logbook.observed_capabilities = [];
  }
  const now = new Date().toISOString();

  const sessionBumped = input.session_id
    ? (observedBumpedPerSession.get(input.session_id) ?? new Set<string>())
    : null;
  if (sessionBumped && input.session_id) {
    observedBumpedPerSession.set(input.session_id, sessionBumped);
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
  writeLogbook(logbook);
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
