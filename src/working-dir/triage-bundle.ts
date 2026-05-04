// Minimal triage bundle for end_drive's LIFT handoff. Returns only
// cross-session facts the LLM cannot re-derive from this session's captures:
// the capability's current saved tier, a summary of prior lift attempts, and
// the capability's own discovery artifact (the agent's scratchpad from earlier
// sessions).
//
// No heuristics — no field-stability classification, no round estimation, no
// next_action decision tree. The LLM reads the raw captures, the cross-session
// memory via get_platform_logbook, and decides. The handoff's `message` field
// points at the tools.

import type { Session } from '../drivers/types/session';
import * as skills from '../strategies/skills';
import {
  type DiscoveryArtifact,
  readArtifactFromDisk,
  inlineArtifactForResponse,
  LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET,
  type InlinedArtifact,
} from '../strategies/discovery-artifact';
import type { CapabilityLogbookEntry } from './schema';
import { loadLogbook as loadLogbookForPlatform } from './logbook';

export interface TriageBundle {
  current_tier: 'fetch' | 'page-script' | 'recorded-path' | 'none';
  prior_attempts: {
    count: number;
    last_attempt_days_ago: number | null;
    sessions_since_last: number | null;
    last_outcome: string | null;
  };
  discovery_artifact?: InlinedArtifact;
}

export function computeTriageBundle(
  _session: Session,
  platform: string,
  capability: string,
): TriageBundle {
  const strategies = skills.loadStrategies(platform, capability);
  let current_tier: TriageBundle['current_tier'] = 'none';
  if (strategies.some((s) => s.strategy === 'fetch')) {
    current_tier = 'fetch';
  } else if (strategies.some((s) => s.strategy === 'page-script')) {
    current_tier = 'page-script';
  } else if (strategies.some((s) => s.strategy === 'recorded-path')) {
    current_tier = 'recorded-path';
  }

  const logbook = loadLogbookForPlatform(platform);
  const prior_attempts = summarizePriorAttempts(logbook.per_capability[capability]);

  const artifact: DiscoveryArtifact | null = readArtifactFromDisk(platform, capability);
  if (artifact) {
    const discovery_artifact = inlineArtifactForResponse(
      platform,
      capability,
      artifact,
      LIST_PLATFORM_SKILLS_ARTIFACT_BUDGET,
      skills.loadStrategies,
    );
    return { current_tier, prior_attempts, discovery_artifact };
  }
  return { current_tier, prior_attempts };
}

function summarizePriorAttempts(
  capEntry: CapabilityLogbookEntry | undefined,
): TriageBundle['prior_attempts'] {
  if (!capEntry || capEntry.lift_attempts.length === 0) {
    return {
      count: 0,
      last_attempt_days_ago: null,
      sessions_since_last: null,
      last_outcome: null,
    };
  }
  const last = capEntry.lift_attempts[capEntry.lift_attempts.length - 1];
  return {
    count: capEntry.lift_attempts.length,
    last_attempt_days_ago: capEntry.days_since_last_attempt ?? null,
    sessions_since_last: capEntry.sessions_since_last_attempt ?? null,
    last_outcome: last ? last.outcome : null,
  };
}
