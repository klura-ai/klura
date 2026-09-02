import { parse, SelectorType, type Selector } from 'css-what';
import { parseString, PublicContractError } from './common';

const MAX_SELECTOR_BYTES_V1 = 512;
const MAX_SELECTOR_GROUPS_V1 = 16;
const MAX_SELECTOR_TOKENS_V1 = 64;

const STANDARD_PSEUDO_CLASSES = new Set([
  'active',
  'any-link',
  'autofill',
  'checked',
  'default',
  'defined',
  'dir',
  'disabled',
  'empty',
  'enabled',
  'first-child',
  'first-of-type',
  'focus',
  'focus-visible',
  'focus-within',
  'has',
  'hover',
  'in-range',
  'indeterminate',
  'invalid',
  'is',
  'lang',
  'last-child',
  'last-of-type',
  'link',
  'not',
  'nth-child',
  'nth-last-child',
  'nth-last-of-type',
  'nth-of-type',
  'only-child',
  'only-of-type',
  'optional',
  'out-of-range',
  'placeholder-shown',
  'read-only',
  'read-write',
  'required',
  'root',
  'scope',
  'target',
  'user-invalid',
  'valid',
  'visited',
  'where',
]);

export function parseCssSelector(value: unknown, field: string): string {
  const selector = parseString(value, field, MAX_SELECTOR_BYTES_V1);
  if (selector.length === 0) throw new PublicContractError(field, 'must not be empty');
  let groups: Selector[][];
  try {
    groups = parse(selector);
  } catch {
    throw new PublicContractError(field, 'must be standards-mode CSS');
  }
  if (groups.length === 0 || groups.length > MAX_SELECTOR_GROUPS_V1) {
    throw new PublicContractError(
      field,
      `must contain one to ${MAX_SELECTOR_GROUPS_V1} selector groups`,
    );
  }
  const state = { tokens: 0 };
  for (const group of groups) validateSelectorGroup(group, field, state);
  return selector;
}

function validateSelectorGroup(
  group: readonly Selector[],
  field: string,
  state: { tokens: number },
): void {
  if (group.length === 0)
    throw new PublicContractError(field, 'must not contain an empty selector group');
  for (const token of group) {
    state.tokens += 1;
    if (state.tokens > MAX_SELECTOR_TOKENS_V1) {
      throw new PublicContractError(
        field,
        `must contain at most ${MAX_SELECTOR_TOKENS_V1} selector tokens`,
      );
    }
    switch (token.type) {
      case SelectorType.Attribute:
      case SelectorType.Tag:
      case SelectorType.Universal:
        if (token.namespace !== null) {
          throw new PublicContractError(field, 'must not use namespace selectors');
        }
        break;
      case SelectorType.Pseudo:
        validatePseudoClass(token.name, token.data, field, state);
        break;
      case SelectorType.Adjacent:
      case SelectorType.Child:
      case SelectorType.Descendant:
      case SelectorType.Sibling:
        break;
      case SelectorType.ColumnCombinator:
      case SelectorType.Parent:
      case SelectorType.PseudoElement:
        throw new PublicContractError(field, 'must not use non-element selector syntax');
    }
  }
}

function validatePseudoClass(
  name: string,
  data: string | Selector[][] | null,
  field: string,
  state: { tokens: number },
): void {
  if (!STANDARD_PSEUDO_CLASSES.has(name)) {
    throw new PublicContractError(field, 'must not use a non-standard CSS pseudo-class');
  }
  if (!Array.isArray(data)) return;
  if (data.length === 0 || data.length > MAX_SELECTOR_GROUPS_V1) {
    throw new PublicContractError(field, 'has an invalid nested CSS selector list');
  }
  for (const group of data) validateSelectorGroup(group, field, state);
}
