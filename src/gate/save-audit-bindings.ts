import type { Strategy } from '../strategies/skills';

export function declaredCallerParamName(data: Strategy, ref: string): string | null {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return null;
  const [head] = ref.split('.');
  if (!head) return null;
  if (/^\d+$/.test(head)) {
    return Object.keys(params)[Number(head)] ?? null;
  }
  return head in params ? head : null;
}

/**
 * Return the wire-level param names a `{{placeholder}}` is templated as in the
 * strategy. The runtime records `ParamObservation`s under the WIRE name
 * (`category` in `/api/restaurants?category=italian`) but `notes.params` is
 * keyed by the agent's chosen PLACEHOLDER name (`{{cuisine}}`). Without this
 * resolution, audits that look up "observations for the placeholder" miss
 * everything when the agent renames the placeholder away from the wire name —
 * which is the common case for self-documenting strategy authoring.
 *
 * Covers query params (`?wire={{ph}}`) and JSON-body fields
 * (`{wire: "{{ph}}"}`). Path-segment placeholders have no wire-param name
 * (the URL path doesn't carry key→value structure), so they return [].
 */
export function wireParamNamesForPlaceholder(data: Strategy, placeholderName: string): string[] {
  const found = new Set<string>();
  const ph = `{{${placeholderName}}}`;

  const endpoint = (data as { endpoint?: unknown }).endpoint;
  if (typeof endpoint === 'string' && endpoint.includes(ph)) {
    // Query-string scan: ?wire={{ph}} or &wire={{ph}}.
    const re = new RegExp(`[?&]([^=&]+)=${ph.replace(/[{}]/g, '\\$&')}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(endpoint)) !== null) {
      const wire = m[1];
      if (wire) found.add(decodeURIComponent(wire));
    }
  }

  const body = (data as { body?: unknown }).body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    walkJsonForKeyWithPlaceholder(body as Record<string, unknown>, ph, (k) => found.add(k));
  }
  return [...found];
}

function walkJsonForKeyWithPlaceholder(
  obj: Record<string, unknown>,
  ph: string,
  emit: (key: string) => void,
): void {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.includes(ph)) emit(k);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      walkJsonForKeyWithPlaceholder(v as Record<string, unknown>, ph, emit);
    }
  }
}

export function listDeclaredParamNames(data: Strategy): string[] {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return [];
  return Object.keys(params);
}

export function listDeclaredPrereqBinds(data: Strategy): string[] {
  const prereqs = (data as Record<string, unknown>).prerequisites;
  if (!Array.isArray(prereqs)) return [];
  const out = new Set<string>();
  for (const p of prereqs) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    if (typeof rec.binds === 'string' && rec.binds.length > 0) out.add(rec.binds);
    if (
      (rec.kind === 'page-extract' ||
        rec.kind === 'fetch-extract' ||
        rec.kind === 'capability' ||
        rec.kind === 'tag') &&
      rec.vars &&
      typeof rec.vars === 'object' &&
      !Array.isArray(rec.vars)
    ) {
      for (const k of Object.keys(rec.vars as Record<string, unknown>)) out.add(k);
    }
  }
  return Array.from(out);
}

export function prereqWithBindsExists(data: Strategy, binds: string): boolean {
  const prereqs = (data as Record<string, unknown>).prerequisites;
  if (!Array.isArray(prereqs)) return false;
  return prereqs.some((p) => {
    if (!p || typeof p !== 'object') return false;
    const rec = p as Record<string, unknown>;
    if (rec.binds === binds) return true;
    // page-extract / fetch-extract / capability bind under vars:{name: path}.
    if (
      (rec.kind === 'page-extract' ||
        rec.kind === 'fetch-extract' ||
        rec.kind === 'capability' ||
        rec.kind === 'tag') &&
      rec.vars &&
      typeof rec.vars === 'object' &&
      !Array.isArray(rec.vars)
    ) {
      return binds in (rec.vars as Record<string, unknown>);
    }
    return false;
  });
}
