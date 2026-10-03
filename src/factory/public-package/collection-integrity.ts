import type { JsonValueV1 } from '../../public/contracts/json';
import type { JsonSchemaV1 } from '../../public/contracts/json-schema';
import type { OutcomeContractV1 } from '../../public/contracts/outcome';

export interface UniformlyNullFieldV1 {
  collection: string;
  field: string;
  rows: number;
}

/** Fields that are null in every row of a returned collection while no sibling
 *  field is null in only some rows. A field that fires on some rows and not
 *  others is principled absence; one that never fires, with no such sibling to
 *  vouch for the extractor, is a broken path wearing the same face. A top-level
 *  array is read as the collection itself. */
export function uniformlyNullCollectionFields(data: JsonValueV1 | null): UniformlyNullFieldV1[] {
  let collections: Array<[string, JsonValueV1]> = [];
  if (Array.isArray(data)) collections = [['items', data]];
  else if (data !== null && typeof data === 'object') collections = Object.entries(data);
  const found: UniformlyNullFieldV1[] = [];
  for (const [name, value] of collections) {
    if (!Array.isArray(value) || value.length < 2) continue;
    const rows = value.filter(
      (row): row is Record<string, JsonValueV1> =>
        row !== null && typeof row === 'object' && !Array.isArray(row),
    );
    if (rows.length !== value.length) continue;
    const fields = Object.keys(rows[0] ?? {}).filter((field) =>
      rows.every((row) => Object.hasOwn(row, field)),
    );
    const nullCounts = new Map(
      fields.map((field) => [field, rows.filter((row) => row[field] === null).length]),
    );
    const mixedSibling = fields.some((field) => {
      const count = nullCounts.get(field) ?? 0;
      return count > 0 && count < rows.length;
    });
    if (mixedSibling) continue;
    for (const field of fields) {
      if (nullCounts.get(field) === rows.length)
        found.push({ collection: name, field, rows: rows.length });
    }
  }
  return found;
}

/** The collections of a result when none of them carries a row: the result's
 *  own array, or every array among its top-level fields. A result with rows in
 *  any collection, or with no collection at all, returns nothing here. */
export function emptyCollections(data: JsonValueV1 | null): string[] {
  if (Array.isArray(data)) return data.length === 0 ? ['items'] : [];
  if (data === null || typeof data !== 'object') return [];
  const collections = Object.entries(data).filter(([, value]) => Array.isArray(value));
  if (collections.length === 0) return [];
  if (collections.some(([, value]) => (value as JsonValueV1[]).length > 0)) return [];
  return collections.map(([name]) => name);
}

/** Whether the outcome named by `outcomeId` declares `field` nullable inside the
 *  collection named by `collection` (or at the top level when the outcome's
 *  data is itself the array). */
export function isNullableCollectionField(
  outcomes: readonly OutcomeContractV1[],
  outcomeId: string,
  collection: string,
  field: string,
): boolean {
  const schema = outcomes.find((outcome) => outcome.outcome_id === outcomeId)?.output_schema;
  if (!schema) return false;
  let collectionSchema: JsonSchemaV1 | undefined;
  if (schema.type === 'array') collectionSchema = schema;
  else if (schema.type === 'object') collectionSchema = schema.properties[collection];
  if (collectionSchema === undefined || collectionSchema.type !== 'array') return false;
  const item = collectionSchema.items;
  if (item.type !== 'object') return false;
  const leaf = item.properties[field];
  return leaf !== undefined && leaf.type !== 'null' && leaf.nullable;
}
