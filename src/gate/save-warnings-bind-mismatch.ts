// `prereq_bind_key_mismatch` detector + helpers. Split out of save-warnings.ts
// to keep the per-file line cap.

import type { Strategy } from '../strategies/skills';
import { getCapturedRequestsProvider } from '../strategies/validate/providers';
import type { SaveWarning } from './save-warnings';

type BindSlot = 'query' | 'body' | 'header';

export function detectPrereqBindKeyMismatch(data: Strategy, sessionId?: string): SaveWarning[] {
  const warnings: SaveWarning[] = [];
  const obj = data as Record<string, unknown>;
  const prereqs = obj.prerequisites;
  if (!Array.isArray(prereqs)) return warnings;

  // Collect every bind name declared by a prereq.
  const binds = new Set<string>();
  for (const raw of prereqs) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.binds === 'string' && p.binds.length > 0) binds.add(p.binds);
    if (
      (p.kind === 'page-extract' ||
        p.kind === 'fetch-extract' ||
        p.kind === 'capability' ||
        p.kind === 'tag') &&
      p.vars &&
      typeof p.vars === 'object'
    ) {
      for (const v of Object.keys(p.vars as Record<string, unknown>)) binds.add(v);
    }
  }
  if (binds.size === 0) return warnings;

  // For each bind, record which slots (query / body / header) its
  // placeholder appears in. This is the set of places the detector needs
  // to cross-check against wire keys.
  const bindSlots = new Map<string, Set<BindSlot>>();
  const addSlot = (name: string, slot: BindSlot): void => {
    if (!binds.has(name)) return;
    const cur = bindSlots.get(name) ?? new Set();
    cur.add(slot);
    bindSlots.set(name, cur);
  };

  const scanString = (s: string, slot: BindSlot): void => {
    const re = /\{\{([\w.]+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m[1]) addSlot(m[1], slot);
    }
  };

  const endpoint = typeof obj.endpoint === 'string' ? obj.endpoint : '';
  const qIdx = endpoint.indexOf('?');
  if (qIdx >= 0) scanString(endpoint.slice(qIdx + 1), 'query');

  const body = obj.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (typeof v === 'string') scanString(v, 'body');
    }
  } else if (typeof body === 'string') {
    // Raw form-urlencoded or stringified JSON body — still scannable.
    scanString(body, 'body');
  }

  const headers = obj.headers;
  if (headers && typeof headers === 'object') {
    for (const v of Object.values(headers as Record<string, unknown>)) {
      if (typeof v === 'string') scanString(v, 'header');
    }
  }

  if (bindSlots.size === 0) return warnings;

  // Pull the captured XHR shape and narrow to the request whose origin +
  // path matches the strategy's endpoint template.
  const captured = readCapturedRequestsForStrategy(data, sessionId);
  if (!captured) return warnings;

  for (const [name, slots] of bindSlots) {
    for (const slot of slots) {
      const wireKeys = keysForSlot(captured, slot);
      if (wireKeys.size === 0) continue;
      const lookupName = slot === 'header' ? name.toLowerCase() : name;
      if (wireKeys.has(lookupName)) continue; // exact match — fine.
      const suggestion = closestWireKey(lookupName, wireKeys);
      if (!suggestion) continue;
      warnings.push({
        kind: 'prereq_bind_key_mismatch',
        message:
          `prereq binds "${name}" but the captured ${slot} has "${suggestion}" instead ` +
          `— did you mean "${suggestion}"? The strategy references {{${name}}} in the ${slot}, ` +
          `but the captured request on this endpoint carries no ${slot} key named "${name}". ` +
          `Warm execute will fill the placeholder, but the wire key the server expects is "${suggestion}".`,
        hint:
          `Rename the prereq's binds to "${suggestion}" (and update every {{placeholder}} to match), ` +
          `or keep "${name}" and re-template the ${slot} to use key "${suggestion}" with ` +
          `value {{${name}}}. If the rename doesn't apply (e.g. the bind is intentionally ` +
          `renamed for readability or reused across endpoints with different wire names), ack ` +
          `with a one-sentence reason.`,
      });
      // One warning per (bind, slot) pair.
    }
  }

  return warnings;
}

function keysForSlot(snapshot: CapturedRequestSnapshot, slot: BindSlot): Set<string> {
  if (slot === 'query') return snapshot.queryKeys;
  if (slot === 'body') return snapshot.bodyKeys;
  return snapshot.headerKeys;
}

/** Normalize a key to its canonical shape for "did you mean" matching: lowercase,
 *  strip non-alphanumeric (merges `thread_id` / `threadId` / `thread-id`). */
function canonKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function closestWireKey(bindName: string, wireKeys: Set<string>): string | null {
  const target = canonKey(bindName);
  if (!target) return null;
  let best: { key: string; distance: number } | null = null;
  for (const k of wireKeys) {
    const canon = canonKey(k);
    if (!canon) continue;
    if (canon === target) return k; // Same canonical form — strong signal.
    const d = editDistance(canon, target);
    const maxLen = Math.max(canon.length, target.length);
    let threshold = 4;
    if (maxLen <= 6) threshold = 2;
    else if (maxLen <= 12) threshold = 3;
    if (d <= threshold && (!best || d < best.distance)) {
      best = { key: k, distance: d };
    }
  }
  return best?.key ?? null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

interface CapturedRequestSnapshot {
  queryKeys: Set<string>;
  bodyKeys: Set<string>;
  headerKeys: Set<string>;
}

function readCapturedRequestsForStrategy(
  data: Strategy,
  sessionId: string | undefined,
): CapturedRequestSnapshot | null {
  if (!sessionId) return null;
  const provider = getCapturedRequestsProvider();
  if (!provider) return null;
  const raw = provider(sessionId);
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const obj = data as Record<string, unknown>;
  const baseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl : '';
  const endpoint = typeof obj.endpoint === 'string' ? obj.endpoint : '';
  if (!baseUrl || !endpoint) return null;

  // Strategy endpoint template may carry `{{X}}` tokens — strip the query
  // entirely and match on origin+path prefix so we find the captured XHR
  // regardless of which arg values it fired with.
  const endpointPath = endpoint.split('?')[0] ?? endpoint;
  let targetOrigin: string;
  let targetPathPrefix: string;
  try {
    const u = new URL(baseUrl);
    targetOrigin = u.origin;
    // baseUrl's path prefix + endpoint path (strip leading slash dup).
    const basePath = u.pathname.replace(/\/$/, '');
    const placeholderIdx = (basePath + endpointPath).indexOf('{{');
    const combined = basePath + endpointPath;
    targetPathPrefix = placeholderIdx >= 0 ? combined.slice(0, placeholderIdx) : combined;
  } catch {
    return null;
  }

  const snapshot: CapturedRequestSnapshot = {
    queryKeys: new Set(),
    bodyKeys: new Set(),
    headerKeys: new Set(),
  };
  let matched = false;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const url = (entry as Record<string, unknown>).url;
    if (typeof url !== 'string') continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.origin !== targetOrigin) continue;
    if (!parsed.pathname.startsWith(targetPathPrefix)) continue;
    matched = true;
    for (const k of parsed.searchParams.keys()) snapshot.queryKeys.add(k);
    const headers = (entry as Record<string, unknown>).headers;
    if (headers && typeof headers === 'object') {
      for (const k of Object.keys(headers as Record<string, unknown>)) {
        snapshot.headerKeys.add(k.toLowerCase());
      }
    }
    const postData = (entry as Record<string, unknown>).postData;
    if (typeof postData === 'string' && postData.length > 0) {
      const trimmed = postData.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsedBody = JSON.parse(trimmed) as unknown;
          if (parsedBody && typeof parsedBody === 'object') {
            for (const k of Object.keys(parsedBody as Record<string, unknown>)) {
              snapshot.bodyKeys.add(k);
            }
          }
        } catch {
          // not JSON — skip body-key extraction
        }
      } else {
        // form-urlencoded shape
        for (const pair of trimmed.split('&')) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx <= 0) continue;
          snapshot.bodyKeys.add(decodeURIComponent(pair.slice(0, eqIdx)));
        }
      }
    }
  }
  return matched ? snapshot : null;
}
