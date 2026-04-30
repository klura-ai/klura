// Helpers for list_platform_skills — file-walk + per-capability merge of
// notes/params/warnings/signature/example. Split out of skills.ts to keep the
// per-file line cap.

import fs from 'fs';
import path from 'path';
import { SKILLS_DIR } from '../paths';
import { readObservedCapabilities } from '../working-dir/logbook';
import type {
  CapabilityInfo,
  ObservedCapabilitySummary,
  SkillInfo,
  Strategy,
  StrategyInfo,
} from './skills';

const SUBDIRS = ['fetch', 'scripts', 'paths'] as const;

/** Cap on `example_response_preview` size — keeps list_platform_skills
 *  output under the MCP budget when many capabilities have examples. */
const EXAMPLE_PREVIEW_BUDGET = 220;

type CapabilityWarning = NonNullable<CapabilityInfo['save_warnings']>[number];

function addStrategyInfo(
  capMap: Map<string, StrategyInfo[]>,
  capability: string,
  type: string,
): void {
  const strategies = capMap.get(capability) ?? [];
  strategies.push({ type });
  capMap.set(capability, strategies);
}

function mergeCapabilityParams(
  capability: string,
  params: Record<string, unknown> | undefined,
  capParams: Map<string, Record<string, unknown>>,
): void {
  if (!params || typeof params !== 'object') return;

  const existing = capParams.get(capability) ?? {};
  for (const [k, v] of Object.entries(params)) {
    if (!(k in existing)) existing[k] = v;
  }
  capParams.set(capability, existing);
}

function mergeCapabilityWarnings(
  capability: string,
  warnings: CapabilityWarning[] | undefined,
  capWarnings: Map<string, CapabilityWarning[]>,
): void {
  if (!Array.isArray(warnings) || warnings.length === 0) return;

  const existing = capWarnings.get(capability) ?? [];
  const seen = new Set(existing.map((w) => `${w.kind}::${w.message}`));
  for (const w of warnings) {
    if (typeof w.kind !== 'string' || typeof w.message !== 'string') continue;
    const key = `${w.kind}::${w.message}`;
    if (seen.has(key)) continue;

    seen.add(key);
    existing.push(
      typeof w.hint === 'string' && w.hint.length > 0
        ? { kind: w.kind, message: w.message, hint: w.hint }
        : { kind: w.kind, message: w.message },
    );
  }
  capWarnings.set(capability, existing);
}

function mergeCapabilityNotes(
  capability: string,
  notes: Strategy['notes'],
  capParams: Map<string, Record<string, unknown>>,
  capWarnings: Map<string, CapabilityWarning[]>,
): void {
  if (!notes || typeof notes !== 'object') return;

  const rawNotes = notes as {
    params?: Record<string, unknown>;
    save_warnings?: CapabilityWarning[];
  };
  mergeCapabilityParams(capability, rawNotes.params, capParams);
  mergeCapabilityWarnings(capability, rawNotes.save_warnings, capWarnings);
}

function readCapabilityStrategyFile(
  platform: string,
  subdir: (typeof SUBDIRS)[number],
  file: string,
  capMap: Map<string, StrategyInfo[]>,
  capParams: Map<string, Record<string, unknown>>,
  capWarnings: Map<string, CapabilityWarning[]>,
  capSignatures: Map<string, string>,
  capExamples: Map<string, string>,
): void {
  const capability = file.replace('.json', '');
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(SKILLS_DIR, platform, subdir, file), 'utf-8'),
    ) as Strategy;
    addStrategyInfo(capMap, capability, data.strategy);
    mergeCapabilityNotes(capability, data.notes, capParams, capWarnings);
    // Signature + example preview from the highest-tier file — fetch
    // beats page-script beats recorded-path. Keep the first observed
    // (highest tier) entry, since we iterate SUBDIRS in fetch→scripts→paths
    // order.
    if (!capSignatures.has(capability)) {
      const sig = deriveSignature(data);
      if (sig) capSignatures.set(capability, sig);
    }
    if (!capExamples.has(capability)) {
      const ex = deriveExamplePreview(data);
      if (ex) capExamples.set(capability, ex);
    }
  } catch {
    addStrategyInfo(capMap, capability, subdir);
  }
}

/** Build a one-line "what does this capability do" signature from a
 *  saved strategy. fetch/page-script: `<METHOD> <full URL>`; recorded
 *  -path: `recorded-path (<n> steps)`. Empty when the strategy is too
 *  malformed to summarize. */
function deriveSignature(data: Strategy): string {
  const tier = (data as { strategy?: unknown }).strategy;
  if (tier === 'fetch' || tier === 'page-script') {
    const baseUrl = (data as { baseUrl?: unknown }).baseUrl;
    const endpoint = (data as { endpoint?: unknown }).endpoint;
    if (typeof endpoint !== 'string' || endpoint.length === 0) return '';
    const methodRaw = (data as { method?: unknown }).method;
    const method = typeof methodRaw === 'string' ? methodRaw.toUpperCase() : 'GET';
    let url = endpoint;
    if (typeof baseUrl === 'string' && baseUrl.length > 0) {
      try {
        url = new URL(endpoint, baseUrl).toString();
      } catch {
        const trimmedBase = baseUrl.replace(/\/$/, '');
        const joinedPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        url = `${trimmedBase}${joinedPath}`;
      }
    }
    return `${method} ${url}`;
  }
  if (tier === 'recorded-path') {
    const steps = (data as { steps?: unknown }).steps;
    const count = Array.isArray(steps) ? steps.length : 0;
    return `recorded-path (${count} step${count === 1 ? '' : 's'})`;
  }
  return '';
}

/** Compact preview of `notes.example_responses[0].response_excerpt`.
 *  Byte-capped to EXAMPLE_PREVIEW_BUDGET. Empty when the strategy
 *  has no example responses on disk. */
function deriveExamplePreview(data: Strategy): string {
  const examples = (data as { notes?: { example_responses?: unknown } }).notes?.example_responses;
  if (!Array.isArray(examples) || examples.length === 0) return '';
  const first = examples[0] as { response_excerpt?: unknown } | undefined;
  if (!first || typeof first !== 'object') return '';
  const excerpt = first.response_excerpt;
  if (excerpt === undefined) return '';
  let serialized: string;
  try {
    serialized = typeof excerpt === 'string' ? excerpt : JSON.stringify(excerpt);
  } catch {
    return '';
  }
  if (serialized.length > EXAMPLE_PREVIEW_BUDGET) {
    return `${serialized.slice(0, EXAMPLE_PREVIEW_BUDGET - 3)}...`;
  }
  return serialized;
}

function observedCapabilitySummary(platform: string): ObservedCapabilitySummary[] {
  return readObservedCapabilities(platform).map((o) => ({
    name: o.name,
    why_not_lifted: o.why_not_lifted,
    observed_in_sessions: o.observed_in_sessions,
    last_observed_at: o.last_observed_at,
  }));
}

function buildCapabilityInfo(
  name: string,
  strategies: StrategyInfo[],
  capParams: Map<string, Record<string, unknown>>,
  capWarnings: Map<string, CapabilityWarning[]>,
  capSignatures: Map<string, string>,
  capExamples: Map<string, string>,
): CapabilityInfo {
  const out: CapabilityInfo = { name, strategies };
  const params = capParams.get(name);
  const warnings = capWarnings.get(name);
  const signature = capSignatures.get(name);
  const example = capExamples.get(name);
  if (params) out.params = params as CapabilityInfo['params'];
  if (signature) out.signature = signature;
  if (example) out.example_response_preview = example;
  if (warnings && warnings.length > 0) out.save_warnings = warnings;
  return out;
}

export function readPlatformSkillInfo(platform: string): SkillInfo {
  const capMap = new Map<string, StrategyInfo[]>();
  const capParams = new Map<string, Record<string, unknown>>();
  const capWarnings = new Map<string, CapabilityWarning[]>();
  const capSignatures = new Map<string, string>();
  const capExamples = new Map<string, string>();

  for (const subdir of SUBDIRS) {
    const dir = path.join(SKILLS_DIR, platform, subdir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      readCapabilityStrategyFile(
        platform,
        subdir,
        file,
        capMap,
        capParams,
        capWarnings,
        capSignatures,
        capExamples,
      );
    }
  }

  const observedSummary = observedCapabilitySummary(platform);
  const info: SkillInfo = {
    platform,
    capabilities: [...capMap.entries()].map(([name, strategies]) =>
      buildCapabilityInfo(name, strategies, capParams, capWarnings, capSignatures, capExamples),
    ),
  };
  if (observedSummary.length > 0) info.observed_capabilities = observedSummary;
  return info;
}
