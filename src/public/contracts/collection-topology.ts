import {
  parseBoundedRecord,
  parseCapabilityId,
  parseExactRecord,
  parseInteger,
  parseJsonPointer,
  parseStableContractId,
  PublicContractError,
  type CapabilityIdV1,
  type JsonPointerV1,
  type StableContractIdV1,
} from './common';
import { parseCollectionPredicate, type CollectionPredicateV1 } from './collection-predicate';
import { parseScrapeLimit, type ScrapeLimitV1 } from './scrape-policy';
import { parseScrapeValue, type ScrapeValueV1 } from './scrape-value';

export interface ScrapeEmitV1 {
  items_pointer: JsonPointerV1;
  cardinality: 'one' | 'array';
  projection: ScrapeValueV1;
  limit: { scope: 'run' | 'task_chain'; value: ScrapeLimitV1 } | null;
}

export type ScrapePaginationV1 =
  | {
      kind: 'cursor';
      continue_when: CollectionPredicateV1;
      exhausted_when: CollectionPredicateV1;
      value_pointer: JsonPointerV1;
      bind_input: StableContractIdV1;
    }
  | {
      kind: 'counter';
      continue_when: CollectionPredicateV1;
      exhausted_when: CollectionPredicateV1;
      bind_input: StableContractIdV1;
      step: number;
    }
  | {
      kind: 'observed_link';
      continue_when: CollectionPredicateV1;
      exhausted_when: CollectionPredicateV1;
      value_pointer: JsonPointerV1;
      bind_input: StableContractIdV1;
      start_url_template_id: StableContractIdV1;
    };

export interface ScrapeFanoutV1 {
  id: StableContractIdV1;
  child_task_kind: StableContractIdV1;
  when: CollectionPredicateV1 | null;
  input: Record<StableContractIdV1, ScrapeValueV1>;
  child_tasks_per_parent: 1;
}

export interface ScrapeTaskKindV1 {
  id: StableContractIdV1;
  capability: CapabilityIdV1;
  task_role: 'page' | 'detail';
  page_outcome_ids: StableContractIdV1[];
  terminal_outcome_ids: StableContractIdV1[];
  emit: ScrapeEmitV1 | null;
  pagination: { contract: ScrapePaginationV1; max_pages_per_chain: ScrapeLimitV1 } | null;
  fanout: ScrapeFanoutV1[];
  on_failure: 'stop_run' | 'continue_independent';
}

const TASK_DATA_AND_OUTCOME = new Set(['task_data', 'task_outcome'] as const);
const PARENT_ITEM_AND_ARGS = new Set(['parent_item', 'args'] as const);
const TASK_DATA_AND_RAW_ITEM = new Set(['task_data', 'raw_item'] as const);
const PARENT_ITEM_ONLY = new Set(['parent_item'] as const);

export function parseScrapeTaskKinds(value: unknown, field: string): ScrapeTaskKindV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new PublicContractError(field, 'must contain one to 32 task kinds');
  }
  const tasks = value.map((candidate, index) => parseTaskKind(candidate, `${field}[${index}]`));
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) {
    throw new PublicContractError(field, 'must not contain duplicate task ids');
  }
  const knownTaskIds = new Set(ids);
  for (const task of tasks) {
    const fanoutIds = new Set<string>();
    for (const edge of task.fanout) {
      if (fanoutIds.has(edge.id)) {
        throw new PublicContractError(
          `${field}.${task.id}.fanout`,
          'must not contain duplicate edge ids',
        );
      }
      fanoutIds.add(edge.id);
      if (!knownTaskIds.has(edge.child_task_kind)) {
        throw new PublicContractError(
          `${field}.${task.id}.fanout.${edge.id}.child_task_kind`,
          'does not name a declared task kind',
        );
      }
    }
  }
  assertAcyclic(tasks, field);
  return tasks;
}

function parseTaskKind(value: unknown, field: string): ScrapeTaskKindV1 {
  const record = parseExactRecord(value, field, [
    'id',
    'capability',
    'task_role',
    'page_outcome_ids',
    'terminal_outcome_ids',
    'emit',
    'pagination',
    'fanout',
    'on_failure',
  ]);
  if (record.task_role !== 'page' && record.task_role !== 'detail') {
    throw new PublicContractError(`${field}.task_role`, 'must be page or detail');
  }
  if (record.on_failure !== 'stop_run' && record.on_failure !== 'continue_independent') {
    throw new PublicContractError(
      `${field}.on_failure`,
      'must be stop_run or continue_independent',
    );
  }
  const emit = record.emit === null ? null : parseEmit(record.emit, `${field}.emit`);
  const pagination =
    record.pagination === null ? null : parsePagination(record.pagination, `${field}.pagination`);
  if (record.task_role === 'detail' && pagination !== null) {
    throw new PublicContractError(`${field}.pagination`, 'is only allowed on a page task');
  }
  if (record.task_role === 'detail' && emit?.cardinality === 'array') {
    throw new PublicContractError(`${field}.emit.cardinality`, 'must be one for a detail task');
  }
  const pageOutcomeIds = parseOutcomeIds(
    record.page_outcome_ids,
    `${field}.page_outcome_ids`,
    true,
  );
  const terminalOutcomeIds = parseOutcomeIds(
    record.terminal_outcome_ids,
    `${field}.terminal_outcome_ids`,
    false,
  );
  if (terminalOutcomeIds.some((id) => pageOutcomeIds.includes(id))) {
    throw new PublicContractError(field, 'page and terminal outcome ids must be disjoint');
  }
  return {
    id: parseStableContractId(record.id, `${field}.id`),
    capability: parseCapabilityId(record.capability, `${field}.capability`),
    task_role: record.task_role,
    page_outcome_ids: pageOutcomeIds,
    terminal_outcome_ids: terminalOutcomeIds,
    emit,
    pagination,
    fanout: parseFanout(record.fanout, `${field}.fanout`),
    on_failure: record.on_failure,
  };
}

function parseEmit(value: unknown, field: string): ScrapeEmitV1 {
  const record = parseExactRecord(value, field, [
    'items_pointer',
    'cardinality',
    'projection',
    'limit',
  ]);
  if (record.cardinality !== 'one' && record.cardinality !== 'array') {
    throw new PublicContractError(`${field}.cardinality`, 'must be one or array');
  }
  return {
    items_pointer: parseJsonPointer(record.items_pointer, `${field}.items_pointer`),
    cardinality: record.cardinality,
    projection: parseScrapeValue(record.projection, `${field}.projection`, TASK_DATA_AND_RAW_ITEM),
    limit: record.limit === null ? null : parseEmitLimit(record.limit, `${field}.limit`),
  };
}

function parseEmitLimit(value: unknown, field: string): ScrapeEmitV1['limit'] {
  const record = parseExactRecord(value, field, ['scope', 'value']);
  if (record.scope !== 'run' && record.scope !== 'task_chain') {
    throw new PublicContractError(`${field}.scope`, 'must be run or task_chain');
  }
  return { scope: record.scope, value: parseScrapeLimit(record.value, `${field}.value`) };
}

function parsePagination(
  value: unknown,
  field: string,
): NonNullable<ScrapeTaskKindV1['pagination']> {
  const record = parseExactRecord(value, field, ['contract', 'max_pages_per_chain']);
  return {
    contract: parsePaginationContract(record.contract, `${field}.contract`),
    max_pages_per_chain: parseScrapeLimit(
      record.max_pages_per_chain,
      `${field}.max_pages_per_chain`,
    ),
  };
}

function parsePaginationContract(value: unknown, field: string): ScrapePaginationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a pagination contract object');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'cursor') {
    const record = parseExactRecord(value, field, [
      'kind',
      'continue_when',
      'exhausted_when',
      'value_pointer',
      'bind_input',
    ]);
    return {
      kind,
      ...parsePaginationPredicates(record, field),
      value_pointer: parseJsonPointer(record.value_pointer, `${field}.value_pointer`),
      bind_input: parseStableContractId(record.bind_input, `${field}.bind_input`),
    };
  }
  if (kind === 'counter') {
    const record = parseExactRecord(value, field, [
      'kind',
      'continue_when',
      'exhausted_when',
      'bind_input',
      'step',
    ]);
    return {
      kind,
      ...parsePaginationPredicates(record, field),
      bind_input: parseStableContractId(record.bind_input, `${field}.bind_input`),
      step: parseInteger(record.step, `${field}.step`, 1, 1_000_000),
    };
  }
  if (kind === 'observed_link') {
    const record = parseExactRecord(value, field, [
      'kind',
      'continue_when',
      'exhausted_when',
      'value_pointer',
      'bind_input',
      'start_url_template_id',
    ]);
    return {
      kind,
      ...parsePaginationPredicates(record, field),
      value_pointer: parseJsonPointer(record.value_pointer, `${field}.value_pointer`),
      bind_input: parseStableContractId(record.bind_input, `${field}.bind_input`),
      start_url_template_id: parseStableContractId(
        record.start_url_template_id,
        `${field}.start_url_template_id`,
      ),
    };
  }
  throw new PublicContractError(`${field}.kind`, 'must be cursor, counter, or observed_link');
}

function parsePaginationPredicates(
  record: Record<string, unknown>,
  field: string,
): Pick<ScrapePaginationV1, 'continue_when' | 'exhausted_when'> {
  return {
    continue_when: parseCollectionPredicate(
      record.continue_when,
      `${field}.continue_when`,
      TASK_DATA_AND_OUTCOME,
    ),
    exhausted_when: parseCollectionPredicate(
      record.exhausted_when,
      `${field}.exhausted_when`,
      TASK_DATA_AND_OUTCOME,
    ),
  };
}

function parseFanout(value: unknown, field: string): ScrapeFanoutV1[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new PublicContractError(field, 'must contain at most 32 fan-out edges');
  }
  return value.map((candidate, index) => {
    const record = parseExactRecord(candidate, `${field}[${index}]`, [
      'id',
      'child_task_kind',
      'when',
      'input',
      'child_tasks_per_parent',
    ]);
    if (record.child_tasks_per_parent !== 1) {
      throw new PublicContractError(`${field}[${index}].child_tasks_per_parent`, 'must be 1');
    }
    return {
      id: parseStableContractId(record.id, `${field}[${index}].id`),
      child_task_kind: parseStableContractId(
        record.child_task_kind,
        `${field}[${index}].child_task_kind`,
      ),
      when:
        record.when === null
          ? null
          : parseCollectionPredicate(record.when, `${field}[${index}].when`, PARENT_ITEM_AND_ARGS),
      input: parseParentInputMap(record.input, `${field}[${index}].input`),
      child_tasks_per_parent: 1,
    };
  });
}

function parseParentInputMap(
  value: unknown,
  field: string,
): Record<StableContractIdV1, ScrapeValueV1> {
  const record = parseBoundedRecord(value, field, 64);
  const parsed = {} as Record<StableContractIdV1, ScrapeValueV1>;
  for (const [key, candidate] of Object.entries(record)) {
    const inputId = parseStableContractId(key, `${field}.${key}`);
    parsed[inputId] = parseScrapeValue(candidate, `${field}.${key}`, PARENT_ITEM_ONLY);
  }
  return parsed;
}

function parseOutcomeIds(value: unknown, field: string, requireOne: boolean): StableContractIdV1[] {
  if (!Array.isArray(value) || value.length > 32 || (requireOne && value.length === 0)) {
    throw new PublicContractError(field, requireOne ? 'must not be empty' : 'must be an array');
  }
  const ids = value.map((candidate, index) =>
    parseStableContractId(candidate, `${field}[${index}]`),
  );
  if (new Set(ids).size !== ids.length)
    throw new PublicContractError(field, 'must not contain duplicates');
  return ids;
}

function assertAcyclic(tasks: readonly ScrapeTaskKindV1[], field: string): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<StableContractIdV1>();
  const visited = new Set<StableContractIdV1>();
  const visit = (id: StableContractIdV1): void => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new PublicContractError(field, 'fan-out task graph must be acyclic');
    const task = byId.get(id);
    if (!task) throw new PublicContractError(field, 'contains an unresolved fan-out task');
    visiting.add(id);
    for (const edge of task.fanout) visit(edge.child_task_kind);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}
