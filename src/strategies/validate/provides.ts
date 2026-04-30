// Validator for the optional top-level `provides: ["<tag>"]` declaration on a
// strategy body. Tags advertised here let other capabilities depend on this
// one via `{kind: "tag", tag: "<tag>"}` prereqs — the typed-edge alternative
// to slug-magic. Hint is opt-in; absence is fine.
//
// Shape rules:
//   - Must be an array of non-empty identifier-shaped strings (snake_case).
//   - No duplicates within the list.
//
// See klura://reference#tag-prereq.

import { asIdentifierSlug, ValidationError } from '../../validators';
import { isPlainObject } from './helpers';

export function validateProvidesShape(data: unknown): void {
  if (!isPlainObject(data)) return;
  const provides = (data as { provides?: unknown }).provides;
  if (provides === undefined || provides === null) return;
  if (!Array.isArray(provides)) {
    throw new Error(
      `invalid_strategy: provides must be an array of tag strings (got ${typeof provides}). ` +
        `Each tag is a snake_case identifier other capabilities can depend on via ` +
        `\`{kind: "tag", tag: "<tag>"}\`. See klura://reference#tag-prereq.`,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < provides.length; i += 1) {
    const tag: unknown = provides[i];
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new Error(
        `invalid_strategy: provides[${i}] must be a non-empty string ` +
          `(got ${JSON.stringify(tag)}). See klura://reference#tag-prereq.`,
      );
    }
    try {
      asIdentifierSlug(tag, `provides[${i}]`);
    } catch (e) {
      throw new Error(
        `invalid_strategy: ${e instanceof ValidationError ? e.message : String(e)}. ` +
          `See klura://reference#tag-prereq.`,
        { cause: e },
      );
    }
    if (seen.has(tag)) {
      throw new Error(
        `invalid_strategy: provides[${i}] = "${tag}" appears more than once. ` +
          `Each tag should appear at most once.`,
      );
    }
    seen.add(tag);
  }
}
