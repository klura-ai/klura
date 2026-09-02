const SECRET_REFERENCE_SCHEME_SOURCE = '[A-Za-z0-9_-]+';
const SECRET_REFERENCE_REF_SOURCE = '[^{}\\r\\n]+';
const SECRET_REFERENCE_TOKEN_SOURCE = `\\{\\{secret:(${SECRET_REFERENCE_SCHEME_SOURCE}):(${SECRET_REFERENCE_REF_SOURCE})\\}\\}`;

const SECRET_REFERENCE_EXACT_RE = new RegExp(`^${SECRET_REFERENCE_TOKEN_SOURCE}$`);
const SECRET_REFERENCE_SCHEME_RE = new RegExp(`^${SECRET_REFERENCE_SCHEME_SOURCE}$`);

export const SECRET_REFERENCE_SYNTAX = '{{secret:<scheme>:<ref>}}';

export interface SecretReference {
  scheme: string;
  ref: string;
}

export function isValidSecretReferenceScheme(scheme: string): boolean {
  return SECRET_REFERENCE_SCHEME_RE.test(scheme);
}

export function containsSecretReferenceMarker(value: string): boolean {
  return value.includes('{{secret:');
}

/** Parse a secret reference only when it occupies the complete string. */
export function parseSecretReference(value: string): SecretReference | null {
  const match = SECRET_REFERENCE_EXACT_RE.exec(value);
  const scheme = match?.[1];
  const ref = match?.[2];
  return scheme !== undefined && ref !== undefined ? { scheme, ref } : null;
}

/** Replace valid secret-reference tokens embedded in a serialization envelope. */
export function replaceSecretReferences(
  value: string,
  replacer: (reference: SecretReference) => string,
): string {
  const tokenRe = new RegExp(SECRET_REFERENCE_TOKEN_SOURCE, 'g');
  return value.replace(tokenRe, (_match, scheme: string, ref: string) => replacer({ scheme, ref }));
}
