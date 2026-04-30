// Shared placeholder-token utilities. The executor and save-time validators
// must agree on the exact `{{name}}` syntax; centralizing the collector +
// replacer keeps regex drift out of both paths.

const PLACEHOLDER_REF_RE = /\{\{([\w.]+)\}\}/g;

export function lookupPlaceholderPath(args: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return args[path];
  const parts = path.split('.');
  let cur: unknown = args;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function collectInlinePlaceholderRefs(value: string): Set<string> {
  const refs = new Set<string>();
  const re = new RegExp(PLACEHOLDER_REF_RE);
  for (const match of value.matchAll(re)) {
    if (match[1]) refs.add(match[1]);
  }
  return refs;
}

export function replacePlaceholders(
  value: string,
  replacer: (path: string, match: string) => string,
): string {
  const re = new RegExp(PLACEHOLDER_REF_RE);
  return value.replace(re, (match, path: string) => replacer(path, match));
}
