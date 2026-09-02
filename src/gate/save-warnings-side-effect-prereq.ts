// Detector: a side-effect-only capability/tag prereq (no `vars`) whose target
// is NOT a pure read. The runtime runs the target for its EFFECT and binds
// nothing, so it holds no structural evidence the effect actually happened — a
// consent click that silently misses, a login that lands on an interstitial,
// and a clean success all produce the identical caller-visible shape.
//
// Exact complement of `save-warnings-useless-prereq.ts`, which fires on the
// same prereq shape when the target IS a positively-confirmed pure read. The
// two share one domain — a saved, resolvable target — and partition it on the
// same `isPureReadTarget` predicate, so exactly one of them can fire per
// prereq. A not-yet-saved target, an unresolvable tag, or a missing loader is
// outside the domain and fires neither.
//
// ackReason is 'required' (see save-strategy.ts): a target whose effect is
// genuinely unobservable from the caller is the documented ack escape.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';
import { WARNING_KINDS } from '../vocab';

function strategyMethod(s: Strategy): string | null {
  const obj = s as Record<string, unknown>;
  if (obj.strategy !== 'fetch' && obj.strategy !== 'page-script') return null;
  if (typeof obj.method === 'string') return obj.method.toUpperCase();
  const ep = obj.endpoint;
  if (typeof ep === 'string' && ep.includes(' ')) return (ep.split(' ')[0] ?? 'GET').toUpperCase();
  return 'GET';
}

/**
 * Positive pure-read confirmation: EVERY saved tier is an HTTP GET with no
 * `provides`. Recorded paths have no HTTP method and may intentionally change
 * browser-local state, so they are never classified as pure reads. Byte-for-
 * byte the predicate `save-warnings-useless-prereq.ts` applies — the two
 * detectors must agree on the partition or they double-fire.
 */
function isPureReadTarget(targets: Strategy[]): boolean {
  return targets.every((s) => {
    const provides = (s as { provides?: unknown }).provides;
    const hasProvides = Array.isArray(provides) && provides.length > 0;
    return !hasProvides && strategyMethod(s) === 'GET';
  });
}

function hasBoundVars(prereq: Record<string, unknown>): boolean {
  const vars = prereq.vars;
  return !!vars && typeof vars === 'object' && !Array.isArray(vars) && Object.keys(vars).length > 0;
}

export interface SideEffectPrereqTargets {
  /** Saved tiers for a capability slug on the caller's platform. */
  loadStrategiesForCapability: (capability: string) => Strategy[];
  /** Capability slugs whose `provides` list carries a tag, mirroring execution. */
  resolveTagProviders?: (tag: string) => string[];
}

/**
 * Flag `{kind: "capability" | "tag"}` prereqs that bind nothing and whose
 * target is not a pure read. Returns one warning per offending prereq.
 */
export function detectSideEffectPrereqUnproven(
  data: Strategy,
  targets: SideEffectPrereqTargets | undefined,
): SaveWarning[] {
  if (!targets) return [];
  const prereqs = (data as { prerequisites?: unknown }).prerequisites;
  if (!Array.isArray(prereqs)) return [];

  const out: SaveWarning[] = [];
  for (const raw of prereqs) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (p.kind !== 'capability' && p.kind !== 'tag') continue;
    // Has vars → its output is consumed, so a bound value already proves the
    // sub-execute ran. Out of scope here.
    if (hasBoundVars(p)) continue;

    const reference = resolveTargetCapability(p, targets);
    if (!reference) continue;

    let saved: Strategy[];
    try {
      saved = targets.loadStrategiesForCapability(reference.capability);
    } catch {
      continue;
    }
    // Not saved → nothing to classify → never flag. The sibling detector holds
    // the same guard.
    if (!Array.isArray(saved) || saved.length === 0) continue;
    // Pure read → the sibling detector owns this prereq.
    if (isPureReadTarget(saved)) continue;

    const prereqName =
      typeof p.name === 'string' && p.name.length > 0 ? p.name : reference.capability;
    out.push(buildWarning(reference, prereqName));
  }
  return out;
}

interface ResolvedTarget {
  capability: string;
  /** How the prereq addressed the target, for prose that matches the strategy. */
  via: 'capability' | 'tag';
  tag?: string;
}

function resolveTargetCapability(
  prereq: Record<string, unknown>,
  targets: SideEffectPrereqTargets,
): ResolvedTarget | null {
  if (prereq.kind === 'capability') {
    const capability = prereq.capability;
    if (typeof capability !== 'string' || capability.length === 0) return null;
    return { capability, via: 'capability' };
  }
  const tag = prereq.tag;
  if (typeof tag !== 'string' || tag.length === 0) return null;
  if (!targets.resolveTagProviders) return null;
  let providers: string[];
  try {
    providers = targets.resolveTagProviders(tag);
  } catch {
    return null;
  }
  // Zero providers is a save-time shape problem the tag validator owns; more
  // than one is ambiguous and execution refuses to pick, so neither is a
  // target this detector can reason about.
  if (!Array.isArray(providers) || providers.length !== 1) return null;
  const [only] = providers;
  if (typeof only !== 'string' || only.length === 0) return null;
  return { capability: only, via: 'tag', tag };
}

function buildWarning(reference: ResolvedTarget, prereqName: string): SaveWarning {
  const addressed =
    reference.via === 'tag'
      ? `tag "${reference.tag}" (resolving to "${reference.capability}")`
      : `capability "${reference.capability}"`;
  return {
    kind: WARNING_KINDS.sideEffectPrereqUnproven,
    message:
      `prerequisite "${prereqName}" references ${addressed} with no \`vars\`, and "${reference.capability}" ` +
      `is not a pure read — it has a side effect the caller depends on. Nothing is bound from it, so the ` +
      `runtime has no structural evidence the effect happened: a consent click that silently missed, a login ` +
      `that landed on an interstitial, and a clean success are indistinguishable to every later step.`,
    hint:
      `Bind one value that only exists once the effect landed — \`vars: {<name>: "<dot.path>"}\` on a field ` +
      `the response carries only post-effect (a session id, an account handle, a flipped flag) — and reference ` +
      `\`{{<name>}}\` in the request. Alternatively fold the step into this strategy's own prereq chain, where ` +
      `its result is checked in line. If the effect genuinely leaves no observable trace in the target's ` +
      `response, ack with a one-sentence reason.`,
    context: {
      capability: reference.capability,
      prereq: prereqName,
      ...(reference.tag ? { tag: reference.tag } : {}),
    },
  };
}
