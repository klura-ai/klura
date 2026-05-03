// Narrowly-scoped registry of well-known capability slugs and their canonical
// arg keys. Used by start_session and declare_capability to surface a hint
// when the agent supplies args that don't match the canonical shape — common
// failure modes are typos (`message` for `text`) and dropped params
// (`{text}` without `recipient` on a "send X to Y" request).
//
// Per principles.md "Delegate to the LLM, but allow narrowly-scoped runtime
// heuristics" — keep this small and remove entries when SKILL.md alone closes
// the gap. Empirical bar: 3 of 3 runs in the May 2026 audit fumbled
// send_message arg shapes despite SKILL.md showing the canonical example.

export interface WellKnownCapability {
  /** Canonical arg keys, in conventional order. */
  canonical: readonly string[];
  /** Common typo / paraphrase aliases that map to a canonical key. */
  aliases?: Readonly<Record<string, string>>;
}

export const WELL_KNOWN_CAPABILITIES: Readonly<Record<string, WellKnownCapability>> = {
  send_message: {
    canonical: ['recipient', 'text'],
    aliases: {
      message: 'text',
      body: 'text',
      content: 'text',
      to: 'recipient',
      target: 'recipient',
      recipient_name: 'recipient',
    },
  },
};

/**
 * Returns a hint string when supplied args don't match the canonical shape
 * for a well-known capability slug, or null when the slug is unknown / args
 * match. Hint names the canonical keys, the supplied keys, missing canonical
 * keys, and any aliased typos so the agent can fix in one retry.
 */
export function checkCapabilityArgs(
  capability: string,
  args: Record<string, unknown> | undefined,
): string | null {
  const spec = WELL_KNOWN_CAPABILITIES[capability];
  if (!spec) return null;
  const supplied = args ? Object.keys(args) : [];
  const missing = spec.canonical.filter((k) => !supplied.includes(k));
  const unknownKeys = supplied.filter((k) => !spec.canonical.includes(k));
  if (missing.length === 0 && unknownKeys.length === 0) return null;

  const parts: string[] = [
    `Capability '${capability}' canonically takes args {${spec.canonical.join(', ')}}.`,
    `You supplied {${supplied.length === 0 ? '<none>' : supplied.join(', ')}}.`,
  ];
  if (missing.length > 0) {
    parts.push(`Missing: ${missing.join(', ')}.`);
  }
  if (unknownKeys.length > 0) {
    const aliasHints: string[] = [];
    for (const k of unknownKeys) {
      const canonical = spec.aliases?.[k];
      if (canonical) aliasHints.push(`'${k}' → '${canonical}'`);
    }
    parts.push(
      aliasHints.length > 0
        ? `Likely typos: ${aliasHints.join(', ')}.`
        : `Unknown keys: ${unknownKeys.join(', ')}.`,
    );
  }
  parts.push(
    `If the user named one of {${spec.canonical.join(', ')}}, pass it verbatim — auto-save can only template literals you supply.`,
  );
  return parts.join(' ');
}
