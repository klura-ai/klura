import type { PublicCallResultV1 } from '../call';
import type { JsonValueV1 } from '../../public/contracts/json';

export function outcomeContext(
  result: Extract<PublicCallResultV1, { kind: 'outcome' }>,
): JsonValueV1 {
  return { id: result.outcome_id, class: result.outcome_class };
}

export function isAcceptedPageResult(
  result: PublicCallResultV1,
  pageOutcomeIds: readonly string[],
  terminalOutcomeIds: readonly string[],
): result is Extract<PublicCallResultV1, { kind: 'outcome' }> {
  return (
    result.kind === 'outcome' &&
    (pageOutcomeIds.includes(result.outcome_id) || terminalOutcomeIds.includes(result.outcome_id))
  );
}
