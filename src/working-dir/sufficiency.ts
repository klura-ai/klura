// Data-sufficiency detector — given N captures of the same endpoint, classify
// each URL query param as stable / caller-varying / rotating / ambiguous.
// Drives the triage step's "do we have enough data to lift?" verdict.
//
// Pure function over a list of captured HTTP requests (no disk I/O; the caller
// reads session archives and hands in the slice for one endpoint).

export type FieldStability =
  | { verdict: 'stable'; value: string }
  | { verdict: 'caller_varying'; correlates_with: string }
  | { verdict: 'rotating'; shape: RotatingShape }
  | { verdict: 'ambiguous'; reason: 'too_few_captures' | 'values_differ_caller_unknown' };

export type RotatingShape =
  | 'timestamp_digits'
  | 'uuid'
  | 'hex_blob'
  | 'base64_token'
  | 'mixed_case_alphanumeric'
  | 'unknown';

export interface CaptureSample {
  /** URL of the captured fire. */
  url: string;
  /** Args the capability was called with for this fire (if known). */
  caller_args?: Record<string, string>;
}

export interface EndpointFieldStability {
  /** Canonical endpoint key (host+path, no query). */
  endpoint: string;
  /** Number of captures contributing. */
  n_captures: number;
  /** Per-param verdict. */
  params: Record<string, FieldStability>;
}

/**
 * Classify each URL param's behavior across a batch of same-endpoint captures.
 * Returns `endpoint` keyed by host+path (no query), with per-param verdicts.
 */
export function classifyFieldStability(samples: CaptureSample[]): EndpointFieldStability | null {
  if (samples.length === 0) return null;
  const firstSample = samples[0];
  if (!firstSample) return null;
  const first = parseUrl(firstSample.url);
  if (!first) return null;
  const endpointKey = `${first.origin}${first.pathname}`;

  // Collect per-param value lists AND their caller_args at that fire.
  const valuesByParam = new Map<string, Array<{ value: string; args?: Record<string, string> }>>();
  for (const s of samples) {
    const parsed = parseUrl(s.url);
    if (!parsed) continue;
    const endpointThis = `${parsed.origin}${parsed.pathname}`;
    if (endpointThis !== endpointKey) continue; // mismatched endpoints — caller should have filtered
    for (const [name, value] of parsed.searchParams.entries()) {
      let list = valuesByParam.get(name);
      if (!list) {
        list = [];
        valuesByParam.set(name, list);
      }
      list.push({ value, args: s.caller_args });
    }
  }

  const n = samples.length;
  const params: Record<string, FieldStability> = {};
  for (const [name, list] of valuesByParam) {
    params[name] = classifyOne(list, n);
  }
  return { endpoint: endpointKey, n_captures: n, params };
}

function classifyOne(
  list: Array<{ value: string; args?: Record<string, string> }>,
  n: number,
): FieldStability {
  const distinct = new Set(list.map((e) => e.value));
  if (distinct.size === 1) {
    const firstEntry = list[0];
    return { verdict: 'stable', value: firstEntry ? firstEntry.value : '' };
  }

  // Caller-varying? If every distinct value maps 1:1 to a distinct caller arg
  // value, it's varying with that arg. Check each arg slot across the sample
  // list.
  const knownArgNames = new Set<string>();
  for (const e of list) {
    for (const k of Object.keys(e.args ?? {})) knownArgNames.add(k);
  }
  for (const arg of knownArgNames) {
    const argValueByFire = list.map((e) => e.args?.[arg]);
    const paramValueByFire = list.map((e) => e.value);
    if (argValueByFire.every((v) => typeof v === 'string')) {
      // 1:1 correlation check — same arg value → same param value in every
      // fire.
      const pairs = argValueByFire.map((a, i) => `${a}→${paramValueByFire[i]}`);
      const pairSet = new Set(pairs);
      const argSet = new Set(argValueByFire);
      if (pairSet.size === argSet.size) {
        return { verdict: 'caller_varying', correlates_with: arg };
      }
    }
  }

  // Rotating — values differ across fires with no caller correlation. Need n >=
  // 3 to confidently call it rotating vs caller-varying with an unobserved arg.
  // n == 2 is ambiguous.
  if (n < 3) {
    return { verdict: 'ambiguous', reason: 'too_few_captures' };
  }
  const shape = classifyShape(list.map((e) => e.value));
  return { verdict: 'rotating', shape };
}

function classifyShape(values: string[]): RotatingShape {
  // Pick the dominant shape across samples. Runtime stays generic — no
  // site-specific header/token names. Shapes are structural only.
  let tsCount = 0;
  let uuidCount = 0;
  let hexCount = 0;
  let b64Count = 0;
  let mixCount = 0;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const v of values) {
    if (/^\d{10,}$/.test(v)) tsCount++;
    else if (uuidRe.test(v)) uuidCount++;
    else if (/^[0-9a-f]{24,}$/i.test(v)) hexCount++;
    else if (v.length >= 20 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v)) mixCount++;
    else if (v.length >= 20 && /^[A-Za-z0-9+/=_-]+$/.test(v)) b64Count++;
  }
  const max = Math.max(tsCount, uuidCount, hexCount, b64Count, mixCount);
  if (max === 0) return 'unknown';
  if (max === tsCount) return 'timestamp_digits';
  if (max === uuidCount) return 'uuid';
  if (max === hexCount) return 'hex_blob';
  if (max === mixCount) return 'mixed_case_alphanumeric';
  return 'base64_token';
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * High-level sufficiency verdict from per-param stabilities. Collapses the
 * param-level detail into a single ternary for triage. Counts ambiguous fields
 * as a gate — if any param's verdict is 'ambiguous', the overall verdict is
 * 'needs_more_data' regardless of others.
 */
export function overallSufficiency(
  s: EndpointFieldStability | null,
): 'sufficient' | 'needs_more_data' | 'no_data' {
  if (!s) return 'no_data';
  if (s.n_captures === 0) return 'no_data';
  if (s.n_captures < 2) return 'no_data';
  const vals = Object.values(s.params);
  if (vals.some((v) => v.verdict === 'ambiguous')) return 'needs_more_data';
  return 'sufficient';
}
