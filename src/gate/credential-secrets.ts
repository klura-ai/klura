// Credential-secret leaf-key detection for the literal_provenance audit.
//
// A literal value under a credential-secret field name — `body.api_key`,
// `prerequisites[0].args.password`, a baked bearer token — must never be frozen
// onto a saved strategy: warm execute would replay the secret on every call and
// it persists to disk (including in any `.broken.json` archive). The audit
// forces such fields to be parameterized (caller_input / prereq_output).
//
// Identifiers (username / email) are intentionally NOT secrets here — a
// deliberately single-account strategy can legitimately freeze those via
// single_entity + notes.params.example. It's the secret half of a credential
// pair that can never be static.

import type { LiteralItem, LiteralClassification } from './save-audit';

// Canonical secret key names, compared after lowercasing the leaf segment and
// stripping `_`/`-` (so `api_key`, `api-key`, `apiKey` all normalize to
// `apikey`). A Set keeps this crisp and side-steps the regex-complexity lint.
const SECRET_LEAF_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'pass',
  'secret',
  'clientsecret',
  'apisecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'apikey',
  'privatekey',
]);

function normalizedLeafKey(path: string): string {
  const seg = path.split('.').pop() ?? path;
  return seg
    .replace(/\[\d+\]$/, '')
    .toLowerCase()
    .replace(/[_-]/g, '');
}

/** True when the field's leaf key names an authentication secret. */
export function isSecretLeafKey(path: string): boolean {
  return SECRET_LEAF_KEYS.has(normalizedLeafKey(path));
}

function valueIsTemplated(value: string): boolean {
  return value.includes('{{') && value.includes('}}');
}

/**
 * Returns a rejection string when a `static` / `single_entity` classification
 * freezes a literal secret onto the strategy, else `null`. A `{{placeholder}}`
 * value is already parameterized and passes (the existing static-on-templated
 * check handles the placeholder-classified-static case separately).
 */
export function secretLiteralProvenanceIssue(
  item: LiteralItem,
  answer: LiteralClassification | undefined,
): string | null {
  if (answer !== 'static' && answer !== 'single_entity') return null;
  if (valueIsTemplated(item.value)) return null;
  if (!isSecretLeafKey(item.path)) return null;
  const leaf = (item.path.split('.').pop() ?? item.path).replace(/\[\d+\]$/, '');
  const classname = typeof answer === 'string' ? `"${answer}"` : JSON.stringify(answer);
  return (
    `literal_provenance["${item.path}"] = ${classname} but the field name "${leaf}" ` +
    `is a credential secret (password / token / api_key / secret). A literal secret must NEVER be ` +
    `frozen onto a saved strategy — warm execute would replay it on every call and it persists to disk. ` +
    `Template it: replace the literal with a {{placeholder}} and classify as {caller_input: "<param>"} ` +
    `(the caller supplies the secret each run) or {prereq_output: "<binds>"} (a prereq re-derives it per ` +
    `call), then declare the matching notes.params entry. If this is an auth prereq, the credentials ` +
    `belong in caller-supplied args, not baked into prerequisites[N].args.`
  );
}
