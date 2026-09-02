import { lookupPlaceholderPath } from '../execution/placeholders';
import { isMutatingStrategy } from '../gate/save-warnings-mutating-verification';
import * as skills from './skills';
import type { Strategy } from './skills';
import {
  collectPlaceholderUses,
  collectPrerequisiteProducedNames,
  type PlaceholderUse,
} from './placeholder-semantics';

export interface ReadCandidateEligibility {
  eligible: boolean;
  reason: 'eligible' | 'safe_read_unproven' | 'unsatisfied_placeholders';
  unsatisfied_placeholders: string[];
}

interface SafeReadProofState {
  visiting: Set<string>;
  proven: Set<string>;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function providesAuth(strategy: Strategy): boolean {
  const provides = (strategy as { provides?: unknown }).provides;
  return Array.isArray(provides) && provides.includes('auth');
}

function isReadOnlyBrowserPrerequisite(raw: Record<string, unknown>): boolean {
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return false;
  return raw.steps.every((step) => {
    if (!step || typeof step !== 'object') return false;
    const action = (step as { action?: unknown }).action;
    return action === 'navigate' || action === 'extract';
  });
}

function proveCapabilitySafeRead(
  platform: string,
  capability: string,
  state: SafeReadProofState,
): boolean {
  const key = `${platform}\u0000${capability}`;
  if (state.proven.has(key)) return true;
  if (state.visiting.has(key)) return false;

  const targets = skills.loadStrategies(platform, capability);
  if (targets.length === 0) return false;

  state.visiting.add(key);
  const safe = targets.every((target) => proveStrategySafeRead(target, platform, state));
  state.visiting.delete(key);
  if (safe) state.proven.add(key);
  return safe;
}

function provePrerequisiteSafeRead(
  raw: Record<string, unknown>,
  callerPlatform: string,
  state: SafeReadProofState,
): boolean {
  switch (raw.kind) {
    case 'cached':
    case 'page-extract':
      return true;
    case 'fetch-extract': {
      const method =
        typeof raw.method === 'string' && raw.method.length > 0 ? raw.method.toUpperCase() : 'GET';
      return method === 'GET';
    }
    case 'browser':
      return isReadOnlyBrowserPrerequisite(raw);
    case 'js-eval':
      return true;
    case 'capability': {
      if (typeof raw.capability !== 'string' || raw.capability.length === 0) return false;
      const targetPlatform =
        typeof raw.platform === 'string' && raw.platform.length > 0 ? raw.platform : callerPlatform;
      return proveCapabilitySafeRead(targetPlatform, raw.capability, state);
    }
    case 'tag': {
      if (typeof raw.tag !== 'string' || raw.tag.length === 0 || raw.tag === 'auth') return false;
      const targetPlatform =
        typeof raw.platform === 'string' && raw.platform.length > 0 ? raw.platform : callerPlatform;
      const providers = skills.findCapabilitiesProviding(targetPlatform, raw.tag);
      if (providers.length !== 1 || !providers[0]) return false;
      return proveCapabilitySafeRead(targetPlatform, providers[0], state);
    }
    default:
      return false;
  }
}

function proveStrategySafeRead(
  strategy: Strategy,
  platform: string,
  state: SafeReadProofState,
): boolean {
  if (strategy.strategy !== 'fetch' && strategy.strategy !== 'page-script') return false;
  if ((strategy as { protocol?: unknown }).protocol === 'websocket') return false;
  if (isMutatingStrategy(strategy) || providesAuth(strategy)) return false;

  const responseFrom = (strategy as { response?: { from?: unknown } }).response?.from;
  if (typeof responseFrom !== 'string' || responseFrom.length === 0) {
    const rawMethod = (strategy as { method?: unknown }).method;
    const method =
      typeof rawMethod === 'string' && rawMethod.length > 0 ? rawMethod.toUpperCase() : 'GET';
    if (method !== 'GET') return false;
  }

  const prerequisites = (strategy as { prerequisites?: unknown }).prerequisites;
  if (prerequisites === undefined) return true;
  if (!Array.isArray(prerequisites)) return false;
  return prerequisites.every(
    (raw) =>
      !!raw &&
      typeof raw === 'object' &&
      provePrerequisiteSafeRead(raw as Record<string, unknown>, platform, state),
  );
}

export function proveReadCandidateSafe(
  strategy: Strategy,
  platform: string,
  capability: string,
): boolean {
  return proveStrategySafeRead(strategy, platform, {
    visiting: new Set([`${platform}\u0000${capability}`]),
    proven: new Set(),
  });
}

function optionalParamNames(strategy: Strategy): Set<string> {
  const optional = new Set<string>();
  const params = (strategy as { notes?: { params?: unknown } }).notes?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return optional;
  for (const [name, doc] of Object.entries(params as Record<string, unknown>)) {
    if (
      doc &&
      typeof doc === 'object' &&
      !Array.isArray(doc) &&
      (doc as { optional?: unknown }).optional === true
    ) {
      optional.add(name);
    }
  }
  return optional;
}

function useIsSatisfied(
  use: PlaceholderUse,
  args: Record<string, unknown>,
  produced: ReadonlySet<string>,
  optional: ReadonlySet<string>,
  generated: ReadonlySet<string>,
): boolean {
  if (use.ref.startsWith('__gen.')) {
    return generated.has(use.ref.slice('__gen.'.length));
  }
  if (produced.has(use.ref) || isPresent(lookupPlaceholderPath(args, use.ref))) return true;
  const root = use.ref.split('.')[0] ?? use.ref;
  return optional.has(root) && use.optionalOmittable;
}

export function findUnsatisfiedReadCandidatePlaceholders(
  strategy: Strategy,
  args: Record<string, unknown>,
): Set<string> {
  const uses = collectPlaceholderUses(strategy);
  const optional = optionalParamNames(strategy);
  const generatedRaw = (strategy as { generated?: unknown }).generated;
  const generated = new Set(
    generatedRaw && typeof generatedRaw === 'object' && !Array.isArray(generatedRaw)
      ? Object.keys(generatedRaw as Record<string, unknown>)
      : [],
  );
  const produced = new Set<string>();
  const missing = new Set<string>();
  const prereqs = (strategy as { prerequisites?: unknown }).prerequisites;
  const prereqList = Array.isArray(prereqs) ? prereqs : [];
  const usesByPrerequisite = new Map<number, PlaceholderUse[]>();
  const nonPrerequisiteUses: PlaceholderUse[] = [];

  for (const use of uses) {
    const match = /^prerequisites\[(\d+)\]/.exec(use.path);
    if (!match?.[1]) {
      nonPrerequisiteUses.push(use);
      continue;
    }
    const index = Number(match[1]);
    const current = usesByPrerequisite.get(index) ?? [];
    current.push(use);
    usesByPrerequisite.set(index, current);
  }

  prereqList.forEach((raw, index) => {
    const prereqUses = usesByPrerequisite.get(index) ?? [];
    const runnable = prereqUses.every((use) =>
      useIsSatisfied(use, args, produced, optional, generated),
    );
    if (!runnable) {
      for (const use of prereqUses) {
        if (!useIsSatisfied(use, args, produced, optional, generated)) missing.add(use.ref);
      }
      return;
    }
    for (const name of collectPrerequisiteProducedNames(raw)) produced.add(name);
  });

  for (const use of nonPrerequisiteUses) {
    if (!useIsSatisfied(use, args, produced, optional, generated)) missing.add(use.ref);
  }
  return missing;
}

export function assessReadCandidateEligibility(
  strategy: Strategy,
  platform: string,
  capability: string,
  args: Record<string, unknown>,
): ReadCandidateEligibility {
  if (!proveReadCandidateSafe(strategy, platform, capability)) {
    return {
      eligible: false,
      reason: 'safe_read_unproven',
      unsatisfied_placeholders: [],
    };
  }
  const missing = [...findUnsatisfiedReadCandidatePlaceholders(strategy, args)].sort((a, b) =>
    a.localeCompare(b),
  );
  if (missing.length > 0) {
    return {
      eligible: false,
      reason: 'unsatisfied_placeholders',
      unsatisfied_placeholders: missing,
    };
  }
  return { eligible: true, reason: 'eligible', unsatisfied_placeholders: [] };
}
