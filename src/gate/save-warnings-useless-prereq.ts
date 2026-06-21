// Detector: a side-effect-only capability prereq (kind:"capability", no `vars`)
// whose target is a PURE READ — a saved GET capability that declares no
// `provides`. A side-effect-only prereq runs the target for its EFFECT; a pure
// read has none, so it fires a wasted HTTP call on every warm execute and the
// caller gets nothing from it.
//
// SAFETY: only flags when the target is POSITIVELY confirmed a pure read. A
// not-yet-saved target (can't verify), a target declaring `provides:[...]`
// (auth / session establishment), or any non-GET tier (mutation, real side
// effect) is NEVER flagged — so a legitimate login / auth / session-warming /
// mutation prereq stays silent. ackReason is 'required' (see save-strategy.ts):
// the rare GET-that-sets-a-cookie case is the documented ack escape.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';

function strategyMethod(s: Strategy): string {
  const obj = s as Record<string, unknown>;
  if (typeof obj.method === 'string') return obj.method.toUpperCase();
  const ep = obj.endpoint;
  if (typeof ep === 'string' && ep.includes(' ')) return (ep.split(' ')[0] ?? 'GET').toUpperCase();
  return 'GET';
}

export function detectUselessCapabilityPrereq(
  data: Strategy,
  loadStrategiesForCapability: ((capability: string) => Strategy[]) | undefined,
): SaveWarning[] {
  if (!loadStrategiesForCapability) return [];
  const prereqs = (data as { prerequisites?: unknown }).prerequisites;
  if (!Array.isArray(prereqs)) return [];

  const out: SaveWarning[] = [];
  for (const raw of prereqs) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (p.kind !== 'capability') continue;
    if (typeof p.capability !== 'string' || p.capability.length === 0) continue;
    // Has vars → not side-effect-only; its output is consumed (or already
    // flagged by unreferenced_prereq_binding). Out of scope here.
    const vars = p.vars;
    if (vars && typeof vars === 'object' && !Array.isArray(vars) && Object.keys(vars).length > 0) {
      continue;
    }

    let targets: Strategy[];
    try {
      targets = loadStrategiesForCapability(p.capability);
    } catch {
      continue;
    }
    // Not saved → can't verify it's a pure read → never flag.
    if (!Array.isArray(targets) || targets.length === 0) continue;

    // Positive pure-read confirmation: EVERY saved tier is a GET with no
    // `provides`. Any `provides`, or any non-GET tier, means the prereq may
    // carry a real side effect (auth, session cookie, mutation) → don't flag.
    const allPureRead = targets.every((s) => {
      const provides = (s as { provides?: unknown }).provides;
      const hasProvides = Array.isArray(provides) && provides.length > 0;
      return !hasProvides && strategyMethod(s) === 'GET';
    });
    if (!allPureRead) continue;

    out.push({
      kind: 'useless_capability_prereq',
      message:
        `prerequisites references capability "${p.capability}" with no \`vars\` (declared side-effect-only), ` +
        `but "${p.capability}" is a pure READ (GET, declares no \`provides\`). A side-effect-only prereq runs ` +
        `the target for its EFFECT — a read has none, so this fires a wasted HTTP call on every warm execute and ` +
        `the caller gets nothing back from it.`,
      hint:
        `Drop the "${p.capability}" prereq if it isn't needed. If you meant to USE its returned data, add ` +
        `\`vars: {<name>: "<dot.path>"}\` and reference \`{{<name>}}\` in the request. If "${p.capability}" ` +
        `genuinely establishes session state the read doesn't advertise (a GET that sets a cookie), ack with a ` +
        `one-sentence reason.`,
      context: { capability: p.capability },
    });
  }
  return out;
}
