// Small regex helpers shared across validators, audits, and synthesis.

/** Escape every regex metacharacter in `s` so it matches literally when
 *  embedded in a `new RegExp(...)`. The canonical
 *  `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` — one copy, imported everywhere
 *  a literal string is spliced into a pattern. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
