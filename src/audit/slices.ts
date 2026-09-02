import { diffPaths } from '../gate/diff';

export interface AuditSlice {
  kind: string;
  fields: unknown;
}

export function diffSlices(oldInput: unknown, newSlices: AuditSlice[]): string[] {
  // Match slices by classifier kind. A retry can change which classifiers
  // are active (rare but possible — e.g. the new payload no longer triggers
  // a `buildItems` non-empty path). When a kind appears on only one side,
  // surface that as a single bullet rather than diffing into the void.
  const newByKind = new Map<string, unknown>();
  for (const s of newSlices) newByKind.set(s.kind, s.fields);

  const oldByKind = new Map<string, unknown>();
  if (Array.isArray(oldInput)) {
    for (const s of oldInput) {
      if (s !== null && typeof s === 'object' && 'kind' in s) {
        const rec = s as { kind?: unknown; fields?: unknown };
        if (typeof rec.kind === 'string') oldByKind.set(rec.kind, rec.fields);
      }
    }
  }

  const out: string[] = [];
  const allKinds = new Set([...oldByKind.keys(), ...newByKind.keys()]);
  for (const k of [...allKinds].sort((x, y) => x.localeCompare(y))) {
    if (!oldByKind.has(k)) {
      out.push(`(${k}) classifier became active on retry`);
      continue;
    }
    if (!newByKind.has(k)) {
      out.push(`(${k}) classifier no longer active on retry`);
      continue;
    }
    for (const p of diffPaths(oldByKind.get(k), newByKind.get(k))) {
      out.push(`(${k}) ${p}`);
    }
  }
  return out;
}

export function itemsAreNonEmpty(items: unknown): boolean {
  if (items === null || items === undefined) return false;
  if (Array.isArray(items)) return items.length > 0;
  if (typeof items === 'object') return Object.keys(items as Record<string, unknown>).length > 0;
  return true;
}
