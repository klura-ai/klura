import type { CollectionRunContractV1 } from '../../public/contracts/collection';
import { PublicContractError, type StableContractIdV1 } from '../../public/contracts/common';
import type { JsonValueV1 } from '../../public/contracts/json';
import {
  compareSemanticValues,
  parseSemanticStopItemValue,
  resolveSemanticStops,
  type ResolvedSemanticStopV1,
  type SemanticComparableValueV1,
} from '../../public/contracts/semantic-stop';
import { resolveJsonPointer } from '../../public/contracts/value-expression';

export class SemanticStopItemError extends Error {}

/** Applies signed monotonic cutoff rules to schema-validated emitted items. */
export class SemanticStopTrackerV1 {
  private readonly previous = new Map<StableContractIdV1, SemanticComparableValueV1>();

  private readonly active: readonly ResolvedSemanticStopV1[];

  constructor(
    collection: CollectionRunContractV1,
    input: JsonValueV1,
    priorItems: readonly JsonValueV1[],
  ) {
    this.active = resolveSemanticStops(collection.semantic_stops, input);
    for (const item of priorItems) {
      const reached = this.observe(item);
      if (reached !== null) {
        throw new SemanticStopItemError('committed item is outside its active semantic cutoff');
      }
    }
  }

  observe(item: JsonValueV1): StableContractIdV1 | null {
    for (const { stop, bound } of this.active) {
      let rawValue: JsonValueV1;
      try {
        rawValue = resolveJsonPointer(item, stop.item_value_pointer, 'run.semantic_stop.item');
      } catch (error) {
        if (error instanceof PublicContractError) throw new SemanticStopItemError(error.message);
        throw error;
      }
      let current: SemanticComparableValueV1;
      try {
        current = parseSemanticStopItemValue(rawValue, stop);
      } catch (error) {
        if (error instanceof PublicContractError) throw new SemanticStopItemError(error.message);
        throw error;
      }
      const previous = this.previous.get(stop.id);
      if (previous !== undefined) {
        const direction = compareSemanticValues(current, previous);
        if (
          (stop.order === 'ascending' && direction < 0) ||
          (stop.order === 'descending' && direction > 0)
        ) {
          throw new SemanticStopItemError('semantic stop ordering is not monotonic');
        }
      }
      this.previous.set(stop.id, current);
      if (!isInSemanticScope(compareSemanticValues(current, bound), stop.order, stop.inclusive)) {
        return stop.id;
      }
    }
    return null;
  }
}

function isInSemanticScope(
  comparisonToBound: -1 | 0 | 1,
  order: 'ascending' | 'descending',
  inclusive: boolean,
): boolean {
  if (order === 'ascending') {
    return inclusive ? comparisonToBound <= 0 : comparisonToBound < 0;
  }
  return inclusive ? comparisonToBound >= 0 : comparisonToBound > 0;
}
