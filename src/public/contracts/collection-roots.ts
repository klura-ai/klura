import {
  parseBoundedRecord,
  parseExactRecord,
  parseJsonPointer,
  parseStableContractId,
  PublicContractError,
  type JsonPointerV1,
  type StableContractIdV1,
} from './common';
import { parseCollectionPredicate, type CollectionPredicateV1 } from './collection-predicate';
import { parseScrapeLimit, type ScrapeLimitV1 } from './scrape-policy';
import { parseScrapeValue, type ScrapeValueSourceV1, type ScrapeValueV1 } from './scrape-value';
import type { StartUrlTemplateV1 } from './start-url-template';

export type ScrapeInputMapV1 = Record<StableContractIdV1, ScrapeValueV1>;

export interface ScrapeStartUrlBindingV1 {
  source: {
    from: 'args' | 'seed';
    pointer: JsonPointerV1;
  };
  template_id: StableContractIdV1;
  bind_input: StableContractIdV1;
}

export type ScrapeRootV1 =
  | {
      task_kind: StableContractIdV1;
      seed: {
        kind: 'once';
        input: ScrapeInputMapV1;
        start_url: ScrapeStartUrlBindingV1 | null;
      };
    }
  | {
      task_kind: StableContractIdV1;
      seed: {
        kind: 'for_each_input';
        array_pointer: JsonPointerV1;
        maximum: ScrapeLimitV1;
        input: ScrapeInputMapV1;
        start_url: ScrapeStartUrlBindingV1 | null;
      };
    };

export interface ScrapeInputModeV1 {
  id: StableContractIdV1;
  populated_when: CollectionPredicateV1;
  roots: ScrapeRootV1[];
}

export interface ScrapeInputModesV1 {
  ordered_mode_ids: StableContractIdV1[];
  conflict_policy: 'reject' | 'prefer_first_nonempty';
  modes: ScrapeInputModeV1[];
}

const MAX_INPUT_MODES_V1 = 32;
const MAX_ROOTS_PER_MODE_V1 = 32;
const ARGS_ONLY = new Set<ScrapeValueSourceV1>(['args']);
const ARGS_AND_SEED = new Set<ScrapeValueSourceV1>(['args', 'seed']);
const PREDICATE_ARGS_ONLY = new Set(['args'] as const);

export function parseScrapeInputModes(
  value: unknown,
  field: string,
  startUrlTemplates: readonly StartUrlTemplateV1[],
): ScrapeInputModesV1 {
  const record = parseExactRecord(value, field, ['ordered_mode_ids', 'conflict_policy', 'modes']);
  if (record.conflict_policy !== 'reject' && record.conflict_policy !== 'prefer_first_nonempty') {
    throw new PublicContractError(
      `${field}.conflict_policy`,
      'must be reject or prefer_first_nonempty',
    );
  }
  const templateIds = new Set(startUrlTemplates.map((template) => template.id));
  if (
    !Array.isArray(record.modes) ||
    record.modes.length === 0 ||
    record.modes.length > MAX_INPUT_MODES_V1
  ) {
    throw new PublicContractError(
      `${field}.modes`,
      `must contain one to ${MAX_INPUT_MODES_V1} modes`,
    );
  }
  const modes = record.modes.map((candidate, index) =>
    parseInputMode(candidate, `${field}.modes[${index}]`, templateIds),
  );
  const modeIds = modes.map((mode) => mode.id);
  assertUnique(modeIds, `${field}.modes`);
  const orderedModeIds = parseModeOrder(
    record.ordered_mode_ids,
    `${field}.ordered_mode_ids`,
    modeIds,
  );
  return {
    ordered_mode_ids: orderedModeIds,
    conflict_policy: record.conflict_policy,
    modes,
  };
}

function parseInputMode(
  value: unknown,
  field: string,
  templateIds: ReadonlySet<string>,
): ScrapeInputModeV1 {
  const record = parseExactRecord(value, field, ['id', 'populated_when', 'roots']);
  if (
    !Array.isArray(record.roots) ||
    record.roots.length === 0 ||
    record.roots.length > MAX_ROOTS_PER_MODE_V1
  ) {
    throw new PublicContractError(
      `${field}.roots`,
      `must contain one to ${MAX_ROOTS_PER_MODE_V1} roots`,
    );
  }
  return {
    id: parseStableContractId(record.id, `${field}.id`),
    populated_when: parseCollectionPredicate(
      record.populated_when,
      `${field}.populated_when`,
      PREDICATE_ARGS_ONLY,
    ),
    roots: record.roots.map((root, index) =>
      parseRoot(root, `${field}.roots[${index}]`, templateIds),
    ),
  };
}

function parseRoot(value: unknown, field: string, templateIds: ReadonlySet<string>): ScrapeRootV1 {
  const record = parseExactRecord(value, field, ['task_kind', 'seed']);
  const taskKind = parseStableContractId(record.task_kind, `${field}.task_kind`);
  if (!record.seed || typeof record.seed !== 'object' || Array.isArray(record.seed)) {
    throw new PublicContractError(`${field}.seed`, 'must be a root seed object');
  }
  const kind = (record.seed as Record<string, unknown>).kind;
  if (kind === 'once') {
    const seed = parseExactRecord(record.seed, `${field}.seed`, ['kind', 'input', 'start_url']);
    const input = parseInputMap(seed.input, `${field}.seed.input`, ARGS_ONLY);
    const startUrl = parseStartUrlBinding(
      seed.start_url,
      `${field}.seed.start_url`,
      new Set(['args']),
      templateIds,
      input,
    );
    return { task_kind: taskKind, seed: { kind, input, start_url: startUrl } };
  }
  if (kind === 'for_each_input') {
    const seed = parseExactRecord(record.seed, `${field}.seed`, [
      'kind',
      'array_pointer',
      'maximum',
      'input',
      'start_url',
    ]);
    const input = parseInputMap(seed.input, `${field}.seed.input`, ARGS_AND_SEED);
    const startUrl = parseStartUrlBinding(
      seed.start_url,
      `${field}.seed.start_url`,
      new Set(['args', 'seed']),
      templateIds,
      input,
    );
    return {
      task_kind: taskKind,
      seed: {
        kind,
        array_pointer: parseJsonPointer(seed.array_pointer, `${field}.seed.array_pointer`),
        maximum: parseScrapeLimit(seed.maximum, `${field}.seed.maximum`),
        input,
        start_url: startUrl,
      },
    };
  }
  throw new PublicContractError(`${field}.seed.kind`, 'must be once or for_each_input');
}

function parseInputMap(
  value: unknown,
  field: string,
  allowedSources: ReadonlySet<ScrapeValueSourceV1>,
): ScrapeInputMapV1 {
  const record = parseBoundedRecord(value, field, 64);
  const parsed = {} as ScrapeInputMapV1;
  for (const [key, candidate] of Object.entries(record)) {
    const inputName = parseStableContractId(key, `${field}.${key}`);
    parsed[inputName] = parseScrapeValue(candidate, `${field}.${key}`, allowedSources);
  }
  return parsed;
}

function parseStartUrlBinding(
  value: unknown,
  field: string,
  allowedSources: ReadonlySet<'args' | 'seed'>,
  templateIds: ReadonlySet<string>,
  input: ScrapeInputMapV1,
): ScrapeStartUrlBindingV1 | null {
  if (value === null) return null;
  const record = parseExactRecord(value, field, ['source', 'template_id', 'bind_input']);
  const source = parseExactRecord(record.source, `${field}.source`, ['from', 'pointer']);
  if (source.from !== 'args' && source.from !== 'seed') {
    throw new PublicContractError(`${field}.source.from`, 'must be args or seed');
  }
  if (!allowedSources.has(source.from)) {
    throw new PublicContractError(`${field}.source.from`, 'is not available for this root');
  }
  const templateId = parseStableContractId(record.template_id, `${field}.template_id`);
  if (!templateIds.has(templateId)) {
    throw new PublicContractError(
      `${field}.template_id`,
      'does not name a declared start URL template',
    );
  }
  const bindInput = parseStableContractId(record.bind_input, `${field}.bind_input`);
  if (Object.prototype.hasOwnProperty.call(input, bindInput)) {
    throw new PublicContractError(
      `${field}.bind_input`,
      'must not also appear in the root input map',
    );
  }
  return {
    source: {
      from: source.from,
      pointer: parseJsonPointer(source.pointer, `${field}.source.pointer`),
    },
    template_id: templateId,
    bind_input: bindInput,
  };
}

function parseModeOrder(
  value: unknown,
  field: string,
  modeIds: readonly StableContractIdV1[],
): StableContractIdV1[] {
  if (!Array.isArray(value) || value.length !== modeIds.length) {
    throw new PublicContractError(field, 'must contain every mode exactly once');
  }
  const parsed = value.map((candidate, index) =>
    parseStableContractId(candidate, `${field}[${index}]`),
  );
  assertUnique(parsed, field);
  const expected = new Set(modeIds);
  if (parsed.some((id) => !expected.has(id))) {
    throw new PublicContractError(field, 'must be an exact permutation of mode ids');
  }
  return parsed;
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new PublicContractError(field, 'must not contain duplicate identifiers');
  }
}
