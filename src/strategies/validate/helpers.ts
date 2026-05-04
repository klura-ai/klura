import { ValidationError, asEnum } from '../../validators';
import type { Strategy } from '../skills';

export type OptionalFieldKind =
  | 'non-empty-string'
  | 'plain-object'
  | 'object-of-strings'
  | { enum: readonly string[] };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function checkOptionalField(
  tier: string,
  field: string,
  value: unknown,
  kind: OptionalFieldKind,
): void {
  if (kind === 'non-empty-string') {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`invalid_strategy: ${tier}.${field} must be a non-empty string`);
    }
    return;
  }
  if (kind === 'plain-object') {
    if (!isPlainObject(value)) {
      throw new Error(`invalid_strategy: ${tier}.${field} must be an object`);
    }
    return;
  }
  if (kind === 'object-of-strings') {
    if (!isPlainObject(value)) {
      throw new Error(`invalid_strategy: ${tier}.${field} must be an object`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'string') {
        throw new Error(
          `invalid_strategy: ${tier}.${field}["${k}"] must be a string (got ${typeof v})`,
        );
      }
    }
    return;
  }
  // enum
  try {
    asEnum(value, `${tier}.${field}`, kind.enum);
  } catch (e: unknown) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_strategy: ${e.message}`, { cause: e });
    }
    throw e;
  }
}

export interface ScannedField {
  path: string;
  value: string;
}

export function collectScannedFields(data: Strategy): ScannedField[] {
  const out: ScannedField[] = [];
  const obj = data as Record<string, unknown>;
  // Recorded-path locator strings (steps[].selector, steps[].locators.css,
  // steps[].locators.alternatives[].css, steps[].waitSelector) are page anchors,
  // not wire literals. The literal_provenance classifier was designed for HTTP
  // wire fields where the variability axis is "what does each caller send."
  // Locator variability lives in the templated a11y `name` (which the agent
  // picks when scoping the locator), not the CSS string. Scanning locators
  // here surfaces false-positive classification work that the agent can only
  // resolve by re-templating the locator's `name` — same outcome reachable via
  // the structural locator schema, no audit needed.
  const scanStepCollection = (steps: unknown, basePath: string): void => {
    if (!Array.isArray(steps)) return;
    steps.forEach((s, idx) => {
      if (!s || typeof s !== 'object') return;
      const st = s as Record<string, unknown>;
      if (typeof st.url === 'string') out.push({ path: `${basePath}[${idx}].url`, value: st.url });
      if (typeof st.value === 'string') {
        out.push({ path: `${basePath}[${idx}].value`, value: st.value });
      }
    });
  };

  for (const k of ['endpoint', 'wsUrl']) {
    const v = obj[k];
    if (typeof v === 'string') out.push({ path: k, value: v });
  }
  if (typeof obj.body === 'string') out.push({ path: 'body', value: obj.body });

  const generated = obj.generated;
  if (generated && typeof generated === 'object') {
    for (const [name, entry] of Object.entries(generated as Record<string, unknown>)) {
      if (entry && typeof entry === 'object') {
        const code = (entry as Record<string, unknown>).code;
        if (typeof code === 'string') out.push({ path: `generated.${name}.code`, value: code });
      }
    }
  }

  const prereqs = obj.prerequisites;
  if (Array.isArray(prereqs)) {
    prereqs.forEach((p, idx) => {
      if (!p || typeof p !== 'object') return;
      const pr = p as Record<string, unknown>;
      if (typeof pr.url === 'string') {
        out.push({ path: `prerequisites[${idx}].url`, value: pr.url });
      }
      if (typeof pr.selector === 'string') {
        out.push({ path: `prerequisites[${idx}].selector`, value: pr.selector });
      }
      const vars = pr.vars;
      if (vars && typeof vars === 'object') {
        for (const [vname, ventry] of Object.entries(vars as Record<string, unknown>)) {
          if (ventry && typeof ventry === 'object') {
            const sel = (ventry as Record<string, unknown>).selector;
            if (typeof sel === 'string') {
              out.push({ path: `prerequisites[${idx}].vars.${vname}.selector`, value: sel });
            }
          }
        }
      }
    });
  }

  scanStepCollection(obj.steps, 'steps');
  if (obj.wsOpen && typeof obj.wsOpen === 'object' && !Array.isArray(obj.wsOpen)) {
    scanStepCollection((obj.wsOpen as Record<string, unknown>).steps, 'wsOpen.steps');
  }

  return out;
}

export function collectAllowedExampleLiterals(data: Strategy): Set<string> {
  const allowed = new Set<string>();
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return allowed;
  for (const entry of Object.values(params)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const example = (entry as Record<string, unknown>).example;
    if (typeof example === 'string' && example.length > 0) allowed.add(example);
  }
  return allowed;
}

export function exampleLooksOpaque(
  example: string,
  patterns: Array<[RegExp, string]>,
): string | null {
  for (const [re, label] of patterns) {
    if (re.test(example)) return label;
  }
  return null;
}
