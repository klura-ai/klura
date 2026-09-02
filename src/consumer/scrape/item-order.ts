import type { ItemLogicalOrderV1 } from './journal';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';

/** Compares two pre-assigned item hierarchy positions without inspecting item content. */
export function compareItemLogicalOrder(
  left: ItemLogicalOrderV1,
  right: ItemLogicalOrderV1,
): number {
  if (left.node_ordinal !== right.node_ordinal) {
    return left.node_ordinal - right.node_ordinal;
  }
  if (left.page_ordinal !== right.page_ordinal) {
    return left.page_ordinal - right.page_ordinal;
  }
  return left.item_ordinal - right.item_ordinal;
}

/** Turns one structural item position into an exact durable map key. */
export function itemLogicalOrderKey(order: ItemLogicalOrderV1): string {
  return canonicalJson(order as unknown as JsonValueV1);
}
