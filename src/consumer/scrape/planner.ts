import {
  evaluateCollectionPredicate,
  type CollectionPredicateContextV1,
} from '../../public/contracts/collection-predicate';
import type { CollectionRunContractV1 } from '../../public/contracts/collection';
import {
  PublicContractError,
  parseStableContractId,
  type CapabilityIdV1,
  type JsonPointerV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import type {
  ScrapeInputMapV1,
  ScrapeStartUrlBindingV1,
} from '../../public/contracts/collection-roots';
import type { JsonValueV1 } from '../../public/contracts/json';
import { validateJsonSchema } from '../../public/contracts/json-schema';
import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import {
  resolveEffectiveRunBounds,
  type EffectiveRunBoundsV1,
  type ScrapeLimitV1,
} from '../../public/contracts/scrape-policy';
import { evaluateScrapeValue } from '../../public/contracts/scrape-value';
import { validateStartUrl } from '../../public/contracts/start-url-template';
import { resolveJsonPointer } from '../../public/contracts/value-expression';

export interface PlannedScrapeRootV1 {
  task_kind_id: StableContractIdV1;
  capability: CapabilityIdV1;
  input: JsonValueV1;
  root_ordinal: number;
  seed_ordinal: number | null;
}

export interface ScrapeRunPlanV1 {
  selected_input_mode_id: StableContractIdV1;
  ignored_input_mode_ids: StableContractIdV1[];
  effective_bounds: EffectiveRunBoundsV1;
  roots: PlannedScrapeRootV1[];
}

export class ScrapePlanningError extends PublicContractError {
  constructor(message: string) {
    super('scrape_plan', message);
    this.name = 'ScrapePlanningError';
  }
}

export function planScrapeRun(
  owner: PublicReadCapabilityV1,
  capabilities: Readonly<Record<CapabilityIdV1, PublicReadCapabilityV1>>,
  args: JsonValueV1,
  callerBounds: unknown,
  selectedInputModeId?: string,
): ScrapeRunPlanV1 {
  if (owner.collection === null)
    throw new ScrapePlanningError('capability does not declare a collection');
  try {
    validateJsonSchema(args, owner.input_schema, 'run.input');
  } catch (error) {
    if (error instanceof PublicContractError) throw new ScrapePlanningError(error.message);
    throw error;
  }
  const collection = owner.collection;
  const effectiveBounds = resolveEffectiveRunBounds(
    collection.run_policy,
    collectLimits(collection),
    callerBounds,
    'run.bounds',
  );
  const { selected, ignored } = selectInputMode(collection, args, selectedInputModeId);
  const taskKinds = new Map(collection.task_kinds.map((task) => [task.id, task]));
  const templates = new Map(
    collection.start_url_templates.map((template) => [template.id, template]),
  );
  const roots: PlannedScrapeRootV1[] = [];
  let rootOrdinal = 0;
  for (const root of selected.roots) {
    const task = taskKinds.get(root.task_kind);
    if (!task) throw new ScrapePlanningError(`root ${root.task_kind} is missing its task kind`);
    const target = capabilities[task.capability];
    if (!target) throw new ScrapePlanningError(`task ${task.id} is missing its capability`);
    if (root.seed.kind === 'once') {
      roots.push({
        task_kind_id: task.id,
        capability: task.capability,
        input: materializeInput(root.seed.input, root.seed.start_url, args, undefined, templates),
        root_ordinal: rootOrdinal,
        seed_ordinal: null,
      });
      rootOrdinal += 1;
      continue;
    }
    const seeds = resolveSeedArray(args, root.seed.array_pointer);
    const maximum = effectiveBounds.named_limits[root.seed.maximum.id];
    if (maximum === undefined) throw new ScrapePlanningError('root seed limit is unresolved');
    if (seeds.length > maximum) {
      throw new ScrapePlanningError(
        `root seed array contains ${seeds.length} values, exceeding its declared limit ${maximum}`,
      );
    }
    for (const [seedOrdinal, seed] of seeds.entries()) {
      roots.push({
        task_kind_id: task.id,
        capability: task.capability,
        input: materializeInput(root.seed.input, root.seed.start_url, args, seed, templates),
        root_ordinal: rootOrdinal,
        seed_ordinal: seedOrdinal,
      });
    }
    rootOrdinal += 1;
  }
  if (roots.length > effectiveBounds.policy.max_tasks) {
    throw new ScrapePlanningError('initial root count exceeds the signed task ceiling');
  }
  for (const root of roots) {
    const target = capabilities[root.capability];
    if (!target) throw new ScrapePlanningError(`task capability ${root.capability} is unavailable`);
    try {
      validateJsonSchema(root.input, target.input_schema, `run.roots[${root.root_ordinal}].input`);
    } catch (error) {
      if (error instanceof PublicContractError) throw new ScrapePlanningError(error.message);
      throw error;
    }
  }
  return {
    selected_input_mode_id: selected.id,
    ignored_input_mode_ids: ignored,
    effective_bounds: effectiveBounds,
    roots,
  };
}

function selectInputMode(
  collection: CollectionRunContractV1,
  args: JsonValueV1,
  selectedInputModeId?: string,
): {
  selected: CollectionRunContractV1['input_modes']['modes'][number];
  ignored: StableContractIdV1[];
} {
  const modes = new Map(collection.input_modes.modes.map((mode) => [mode.id, mode]));
  const context: CollectionPredicateContextV1 = { args };
  const matches = collection.input_modes.ordered_mode_ids.filter((id) => {
    const mode = modes.get(id);
    return mode !== undefined && evaluateCollectionPredicate(mode.populated_when, context);
  });
  if (selectedInputModeId !== undefined) {
    const selectedId = parseStableContractId(selectedInputModeId, 'run.input_mode');
    const selected = modes.get(selectedId);
    if (!selected) throw new ScrapePlanningError('selected input mode is not declared');
    if (!matches.includes(selectedId)) {
      throw new ScrapePlanningError('selected input mode is not populated by this input');
    }
    return { selected, ignored: matches.filter((id) => id !== selectedId) };
  }
  if (matches.length === 0)
    throw new ScrapePlanningError('no input mode is populated by this input');
  if (collection.input_modes.conflict_policy === 'reject' && matches.length !== 1) {
    throw new ScrapePlanningError('multiple input modes are populated by this input');
  }
  const selectedId = matches[0];
  if (!selectedId) throw new ScrapePlanningError('no input mode is selected');
  const selected = modes.get(selectedId);
  if (!selected) throw new ScrapePlanningError('selected input mode is not declared');
  return { selected, ignored: matches.slice(1) };
}

function materializeInput(
  inputMap: ScrapeInputMapV1,
  startUrl: ScrapeStartUrlBindingV1 | null,
  args: JsonValueV1,
  seed: JsonValueV1 | undefined,
  templates: ReadonlyMap<string, CollectionRunContractV1['start_url_templates'][number]>,
): JsonValueV1 {
  const context = seed === undefined ? { args } : { args, seed };
  const result: Record<string, JsonValueV1> = {};
  for (const [key, value] of Object.entries(inputMap)) {
    result[key] = evaluateScrapeValue(value, context);
  }
  if (startUrl !== null) {
    const template = templates.get(startUrl.template_id);
    if (!template)
      throw new ScrapePlanningError(`start URL template ${startUrl.template_id} is unavailable`);
    const source = startUrl.source.from === 'args' ? args : seed;
    if (source === undefined) throw new ScrapePlanningError('start URL seed source is unavailable');
    let rawUrl: JsonValueV1;
    try {
      rawUrl = resolveJsonPointer(source, startUrl.source.pointer, 'run.start_url');
    } catch (error) {
      if (error instanceof PublicContractError) throw new ScrapePlanningError(error.message);
      throw error;
    }
    result[startUrl.bind_input] = validateStartUrl(template, rawUrl, 'run.start_url');
  }
  return result;
}

function resolveSeedArray(args: JsonValueV1, pointer: JsonPointerV1): JsonValueV1[] {
  let value: JsonValueV1;
  try {
    value = resolveJsonPointer(args, pointer, 'run.seed_array');
  } catch (error) {
    if (error instanceof PublicContractError) throw new ScrapePlanningError(error.message);
    throw error;
  }
  if (!Array.isArray(value))
    throw new ScrapePlanningError('root seed pointer must resolve to an array');
  return value;
}

function collectLimits(collection: CollectionRunContractV1): ScrapeLimitV1[] {
  const limits: ScrapeLimitV1[] = [];
  for (const mode of collection.input_modes.modes) {
    for (const root of mode.roots) {
      if (root.seed.kind === 'for_each_input') limits.push(root.seed.maximum);
    }
  }
  for (const task of collection.task_kinds) {
    if (task.emit?.limit) limits.push(task.emit.limit.value);
    if (task.pagination) limits.push(task.pagination.max_pages_per_chain);
  }
  return limits;
}
