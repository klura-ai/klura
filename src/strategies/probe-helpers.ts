// Helpers shared between save-time prereq probing (`probe.ts`) and
// observed-URL verification (`verify-observed.ts`). Both phases need to
// resolve `{{template}}` placeholders against `notes.params[*].example`
// before they can compare a strategy URL or selector target against the
// live world.

const TEMPLATE_RE = /\{\{(\w+)\}\}/g;

/**
 * Walk strategy.notes.params and collect {paramName: example} from any param
 * that supplies an `example` field. Used to interpolate {{template}} URLs
 * during the probe and the observation check — both need concrete values for
 * placeholder slots before they can navigate / match against the real world.
 */
export function collectParamExamples(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const notes = data.notes;
  if (!notes || typeof notes !== 'object') return out;
  const params = (notes as Record<string, unknown>).params;
  if (!params || typeof params !== 'object') return out;

  for (const [name, raw] of Object.entries(params as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const doc = raw as Record<string, unknown>;
    if (typeof doc.example === 'string' && doc.example.length > 0) {
      out[name] = doc.example;
    }
  }
  return out;
}

/**
 * Substitute every `{{name}}` placeholder in `template` with `examples[name]`.
 * Throws `invalid_strategy: ...` listing the missing names if any placeholder
 * has no example value, with a pointer to where the agent should add one.
 */
export function resolveTemplate(
  template: string,
  examples: Record<string, string>,
  field: string,
): string {
  const missing: string[] = [];
  const resolved = template.replace(TEMPLATE_RE, (_match, name: string) => {
    const v = examples[name];
    if (v === undefined) {
      missing.push(name);
      return _match;
    }
    return v;
  });
  if (missing.length > 0) {
    const missingList = missing.map((m) => `{{${m}}}`).join(', ');
    throw new Error(
      `invalid_strategy: ${field} contains placeholders ${missingList} ` +
        `but no \`example\` value was provided for them in notes.params. ` +
        `Add \`notes.params.${missing[0]}.example: "<a real value>"\` so the save-time probe can navigate to the real URL.`,
    );
  }
  return resolved;
}
