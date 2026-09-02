import {
  containsSecretReferenceMarker,
  parseSecretReference,
  SECRET_REFERENCE_SYNTAX,
} from '../../identity/secret-reference';

const NON_EXECUTABLE_TOP_LEVEL_FIELDS = new Set([
  'notes',
  'runtime_meta',
  'schema_version',
  'tier_stamp',
]);

function childPath(parent: string, key: string, index: number): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) {
    return parent.length === 0 ? key : `${parent}.${key}`;
  }
  return `${parent}[field_${index}]`;
}

function validateValue(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (!containsSecretReferenceMarker(value)) return;
    if (parseSecretReference(value)) return;
    throw new Error(
      `invalid_strategy: ${path} contains secret-reference syntax but is not exactly one valid ` +
        `${SECRET_REFERENCE_SYNTAX} token. A secret reference must occupy the whole string; store ` +
        `any required prefix or suffix in the resolver's returned value.`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateValue(entry, `${path}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value as Record<string, unknown>).forEach(([key, entry], index) => {
    validateValue(entry, childPath(path, key, index));
  });
}

/**
 * Secret references are portable strategy tokens. Save-time validation checks
 * their shape without consulting the machine's configured resolver schemes.
 */
export function validateSecretReferences(data: Record<string, unknown>): void {
  Object.entries(data).forEach(([key, value], index) => {
    if (NON_EXECUTABLE_TOP_LEVEL_FIELDS.has(key)) return;
    validateValue(value, childPath('', key, index));
  });
}
