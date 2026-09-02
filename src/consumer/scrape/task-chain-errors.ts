import type { StableContractIdV1 } from '../../public/contracts/common';
import type { JsonValueV1 } from '../../public/contracts/json';

export class ItemValidationError extends Error {}

export class RunBudgetExceededError extends Error {}

export interface ItemEmissionV1 {
  items: JsonValueV1[];
  retained_item_bytes: number;
  semantic_stop_id: StableContractIdV1 | null;
}
