import type { PublicCallResultV1 } from '../call';
import { evaluateCollectionPredicate } from '../../public/contracts/collection-predicate';
import { PublicContractError } from '../../public/contracts/common';
import type { JsonValueV1 } from '../../public/contracts/json';
import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import { validateStartUrl } from '../../public/contracts/start-url-template';
import { resolveJsonPointer } from '../../public/contracts/value-expression';
import { outcomeContext } from './task-result';

export function nextPaginationInput(
  task: NonNullable<PublicReadCapabilityV1['collection']>['task_kinds'][number],
  input: JsonValueV1,
  result: Extract<PublicCallResultV1, { kind: 'outcome' }>,
  templates: ReadonlyMap<
    string,
    NonNullable<PublicReadCapabilityV1['collection']>['start_url_templates'][number]
  >,
): JsonValueV1 | null {
  const pagination = task.pagination;
  if (pagination === null) return null;
  const context =
    result.data === null
      ? { task_outcome: outcomeContext(result) }
      : {
          task_data: result.data,
          task_outcome: outcomeContext(result),
        };
  const continueMatches = evaluateCollectionPredicate(pagination.contract.continue_when, context);
  const exhaustedMatches = evaluateCollectionPredicate(pagination.contract.exhausted_when, context);
  if (continueMatches === exhaustedMatches) {
    throw new PublicContractError(
      'run.pagination',
      'continuation and exhaustion predicates are indeterminate',
    );
  }
  if (exhaustedMatches) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublicContractError('run.pagination.input', 'must be a JSON object');
  }
  const next = { ...(input as Record<string, JsonValueV1>) };
  if (result.data === null) {
    throw new PublicContractError('run.pagination', 'continuation requires task data');
  }
  if (pagination.contract.kind === 'counter') {
    const current = next[pagination.contract.bind_input];
    if (typeof current !== 'number' || !Number.isSafeInteger(current)) {
      throw new PublicContractError('run.pagination.counter', 'binding must be a safe integer');
    }
    const incremented = current + pagination.contract.step;
    if (!Number.isSafeInteger(incremented)) {
      throw new PublicContractError('run.pagination.counter', 'increment is out of range');
    }
    next[pagination.contract.bind_input] = incremented;
    return next;
  }
  const value = resolveJsonPointer(
    result.data,
    pagination.contract.value_pointer,
    'run.pagination.value_pointer',
  );
  if (pagination.contract.kind === 'observed_link') {
    const template = templates.get(pagination.contract.start_url_template_id);
    if (!template) {
      throw new PublicContractError('run.pagination.start_url_template_id', 'is unavailable');
    }
    next[pagination.contract.bind_input] = validateStartUrl(template, value, 'run.pagination.link');
    return next;
  }
  next[pagination.contract.bind_input] = value;
  return next;
}
