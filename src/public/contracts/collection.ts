import {
  parseExactRecord,
  parseInteger,
  parseJsonPointer,
  parseString,
  sha256Digest,
  PublicContractError,
  type JsonPointerV1,
} from './common';
import { parseScrapeInputModes, type ScrapeInputModesV1 } from './collection-roots';
import { parseScrapeTaskKinds, type ScrapeTaskKindV1 } from './collection-topology';
import { parseJsonSchema, type JsonSchemaV1 } from './json-schema';
import { parseInlineOutputBound, type InlineOutputBoundV1 } from './inline-output-bound';
import { canonicalJson, type JsonValueV1 } from './json';
import { parseScrapeRunPolicy, type ScrapeRunPolicyV1 } from './scrape-policy';
import { parseSemanticStops, type SemanticStopV1 } from './semantic-stop';
import { parseStartUrlTemplate, type StartUrlTemplateV1 } from './start-url-template';

export interface CollectionRunContractV1 {
  collection_schema_version: 1;
  input_modes: ScrapeInputModesV1;
  start_url_templates: StartUrlTemplateV1[];
  item_schema: JsonSchemaV1;
  item_identity: { pointers: JsonPointerV1[] };
  inline_output_bound: InlineOutputBoundV1 | null;
  semantic_stops: SemanticStopV1[];
  csv_columns: CsvColumnV1[] | null;
  task_kinds: ScrapeTaskKindV1[];
  max_fanout_depth: number;
  run_policy: ScrapeRunPolicyV1;
}

export interface CsvColumnV1 {
  name: string;
  pointer: JsonPointerV1;
}

/** Every key a collection run contract carries, in canonical order. */
export const COLLECTION_CONTRACT_KEYS = [
  'collection_schema_version',
  'input_modes',
  'start_url_templates',
  'item_schema',
  'item_identity',
  'inline_output_bound',
  'semantic_stops',
  'csv_columns',
  'task_kinds',
  'max_fanout_depth',
  'run_policy',
] as const;

export function parseCollectionRunContract(value: unknown, field: string): CollectionRunContractV1 {
  const record = parseExactRecord(value, field, COLLECTION_CONTRACT_KEYS);
  if (record.collection_schema_version !== 1) {
    throw new PublicContractError(`${field}.collection_schema_version`, 'must be 1');
  }
  if (!Array.isArray(record.start_url_templates) || record.start_url_templates.length > 32) {
    throw new PublicContractError(
      `${field}.start_url_templates`,
      'must contain at most 32 templates',
    );
  }
  const startUrlTemplates = record.start_url_templates.map((candidate, index) =>
    parseStartUrlTemplate(candidate, `${field}.start_url_templates[${index}]`),
  );
  const templateIds = startUrlTemplates.map((template) => template.id);
  if (new Set(templateIds).size !== templateIds.length) {
    throw new PublicContractError(
      `${field}.start_url_templates`,
      'must not contain duplicate template ids',
    );
  }
  const itemSchema = parseJsonSchema(record.item_schema, `${field}.item_schema`);
  const taskKinds = parseScrapeTaskKinds(record.task_kinds, `${field}.task_kinds`);
  const contract: CollectionRunContractV1 = {
    collection_schema_version: 1,
    input_modes: parseScrapeInputModes(
      record.input_modes,
      `${field}.input_modes`,
      startUrlTemplates,
    ),
    start_url_templates: startUrlTemplates,
    item_schema: itemSchema,
    item_identity: parseItemIdentity(record.item_identity, `${field}.item_identity`),
    inline_output_bound: parseInlineOutputBound(
      record.inline_output_bound,
      itemSchema,
      `${field}.inline_output_bound`,
    ),
    semantic_stops: parseSemanticStops(record.semantic_stops, `${field}.semantic_stops`),
    csv_columns: parseCsvColumns(record.csv_columns, `${field}.csv_columns`),
    task_kinds: taskKinds,
    max_fanout_depth: parseInteger(record.max_fanout_depth, `${field}.max_fanout_depth`, 0, 3),
    run_policy: parseScrapeRunPolicy(record.run_policy, `${field}.run_policy`),
  };
  validateTemplateReferences(contract, field);
  validateCollectionLimitIds(contract, field);
  validateSemanticStopTopology(contract, field);
  return contract;
}

export function calculateCollectionContractDigest(
  contract: CollectionRunContractV1,
): ReturnType<typeof sha256Digest> {
  return sha256Digest(canonicalJson(contract as unknown as JsonValueV1));
}

function parseItemIdentity(value: unknown, field: string): { pointers: JsonPointerV1[] } {
  const record = parseExactRecord(value, field, ['pointers']);
  if (
    !Array.isArray(record.pointers) ||
    record.pointers.length === 0 ||
    record.pointers.length > 8
  ) {
    throw new PublicContractError(`${field}.pointers`, 'must contain one to eight pointers');
  }
  const pointers = record.pointers.map((pointer, index) =>
    parseJsonPointer(pointer, `${field}.pointers[${index}]`),
  );
  if (new Set(pointers).size !== pointers.length) {
    throw new PublicContractError(`${field}.pointers`, 'must not contain duplicates');
  }
  return { pointers };
}

function parseCsvColumns(value: unknown, field: string): CsvColumnV1[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new PublicContractError(field, 'must contain one to 128 declared columns');
  }
  const names = new Set<string>();
  return value.map((candidate, index) => {
    const column = parseExactRecord(candidate, `${field}[${index}]`, ['name', 'pointer']);
    const name = parseString(column.name, `${field}[${index}].name`, 128);
    if (name.length === 0)
      throw new PublicContractError(`${field}[${index}].name`, 'must not be empty');
    if (names.has(name)) {
      throw new PublicContractError(`${field}[${index}].name`, 'must not be duplicated');
    }
    names.add(name);
    return { name, pointer: parseJsonPointer(column.pointer, `${field}[${index}].pointer`) };
  });
}

function validateTemplateReferences(contract: CollectionRunContractV1, field: string): void {
  const templateIds = new Set(contract.start_url_templates.map((template) => template.id));
  for (const task of contract.task_kinds) {
    if (
      task.pagination?.contract.kind === 'observed_link' &&
      !templateIds.has(task.pagination.contract.start_url_template_id)
    ) {
      throw new PublicContractError(
        `${field}.task_kinds.${task.id}.pagination.contract.start_url_template_id`,
        'does not name a declared start URL template',
      );
    }
  }
}

function validateCollectionLimitIds(contract: CollectionRunContractV1, field: string): void {
  const ids = new Set<string>();
  const add = (id: string): void => {
    if (ids.has(id))
      throw new PublicContractError(field, 'limit ids must be unique across the collection');
    ids.add(id);
  };
  for (const mode of contract.input_modes.modes) {
    for (const root of mode.roots) {
      if (root.seed.kind === 'for_each_input') add(root.seed.maximum.id);
    }
  }
  for (const task of contract.task_kinds) {
    if (task.emit?.limit) add(task.emit.limit.value.id);
    if (task.pagination) add(task.pagination.max_pages_per_chain.id);
  }
}

/** Semantic cutoffs require one globally ordered page chain. */
function validateSemanticStopTopology(contract: CollectionRunContractV1, field: string): void {
  if (contract.semantic_stops.length === 0) return;
  if (contract.task_kinds.length !== 1) {
    throw new PublicContractError(
      `${field}.semantic_stops`,
      'requires exactly one task kind without fan-out',
    );
  }
  const task = contract.task_kinds[0] as ScrapeTaskKindV1;
  if (task.fanout.length !== 0) {
    throw new PublicContractError(
      `${field}.semantic_stops`,
      'requires exactly one task kind without fan-out',
    );
  }
  for (const mode of contract.input_modes.modes) {
    if (mode.roots.length !== 1) {
      throw new PublicContractError(
        `${field}.semantic_stops`,
        'requires one once-seeded root for the ordered task in every input mode',
      );
    }
    const root = mode.roots[0] as (typeof mode.roots)[number];
    if (root.task_kind !== task.id || root.seed.kind !== 'once') {
      throw new PublicContractError(
        `${field}.semantic_stops`,
        'requires one once-seeded root for the ordered task in every input mode',
      );
    }
  }
}
