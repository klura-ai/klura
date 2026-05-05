// Structural diff between two values. Returns dotted/bracketed paths where
// values differ. Empty array means equal.
//
// Used by Level-3 gates (`Audit`, `buildTokenGate`) to surface what changed
// between a token's audited payload and the agent's retry payload — so the
// agent doesn't have to play detective on `payload_changed` rejections.

const ROOT = '(root)';

function keyByPath(arr: unknown[]): Map<string, unknown> | null {
  if (arr.length === 0) return null;
  const out = new Map<string, unknown>();
  for (const el of arr) {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) return null;
    const p = (el as Record<string, unknown>).path;
    if (typeof p !== 'string' || out.has(p)) return null;
    out.set(p, el);
  }
  return out;
}

export function diffPaths(oldVal: unknown, newVal: unknown): string[] {
  const out: string[] = [];
  walk(oldVal, newVal, '', out);
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Object.is(a, b)) return;

  const aIsObj = a !== null && typeof a === 'object';
  const bIsObj = b !== null && typeof b === 'object';
  if (!aIsObj || !bIsObj) {
    out.push(path || ROOT);
    return;
  }

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) {
    out.push(path || ROOT);
    return;
  }

  if (aIsArr && bIsArr) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    // Keyed-array diff: when both arrays are arrays of objects each carrying
    // a unique string `path` field, diff by `path` rather than by index.
    // Several Audit classifier hash slices have this shape (literal_provenance
    // emits `[{path, value, ...}]`) — keyed diff yields "endpoint" instead of
    // "[0].value", which is what the agent recognizes from the strategy body.
    const aKeyed = keyByPath(aArr);
    const bKeyed = keyByPath(bArr);
    if (aKeyed && bKeyed) {
      const allKeys = [...new Set([...aKeyed.keys(), ...bKeyed.keys()])].sort((x, y) =>
        x.localeCompare(y),
      );
      for (const k of allKeys) {
        const childPath = path ? `${path}.${k}` : k;
        if (!aKeyed.has(k)) {
          out.push(`${childPath} (added)`);
          continue;
        }
        if (!bKeyed.has(k)) {
          out.push(`${childPath} (removed)`);
          continue;
        }
        walk(aKeyed.get(k), bKeyed.get(k), childPath, out);
      }
      return;
    }
    const maxLen = Math.max(aArr.length, bArr.length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= aArr.length) {
        out.push(`${childPath} (added)`);
        continue;
      }
      if (i >= bArr.length) {
        out.push(`${childPath} (removed)`);
        continue;
      }
      walk(aArr[i], bArr[i], childPath, out);
    }
    return;
  }

  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aRec), ...Object.keys(bRec)]);
  for (const k of [...keys].sort((x, y) => x.localeCompare(y))) {
    const childPath = path ? `${path}.${k}` : k;
    const inA = Object.prototype.hasOwnProperty.call(aRec, k);
    const inB = Object.prototype.hasOwnProperty.call(bRec, k);
    if (!inA) {
      out.push(`${childPath} (added)`);
      continue;
    }
    if (!inB) {
      out.push(`${childPath} (removed)`);
      continue;
    }
    walk(aRec[k], bRec[k], childPath, out);
  }
}
