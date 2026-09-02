import type { Locator, Page } from 'playwright';
import { PublicContractError } from '../../../public/contracts/common';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../../../public/contracts/json';
import type { DomProjectionFieldV1, DomProjectionV1 } from '../../../public/contracts/package';
import { resolveJsonPointer } from '../../../public/contracts/value-expression';

const MAX_PROJECTED_ITEMS_V1 = 256;

export class BrowserProjectionError extends PublicContractError {
  constructor(message: string) {
    super('browser_projection', message);
    this.name = 'BrowserProjectionError';
  }
}

export async function projectBrowserDom(
  page: Page,
  projection: DomProjectionV1,
  maximumBytes: number,
): Promise<JsonValueV1> {
  const items = page.locator(projection.item_selector);
  const count = await items.count();
  if (projection.cardinality === 'one' && count !== 1) {
    throw new BrowserProjectionError('item selector must resolve to exactly one element');
  }
  if (projection.cardinality === 'array' && count > MAX_PROJECTED_ITEMS_V1) {
    throw new BrowserProjectionError(
      `item selector exceeds ${MAX_PROJECTED_ITEMS_V1} projected items`,
    );
  }
  const projected: JsonValueV1[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    projected.push(await projectItem(page, item, projection));
  }
  const result = projection.cardinality === 'one' ? (projected[0] ?? null) : projected;
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > maximumBytes) {
    throw new BrowserProjectionError('projected browser result exceeds its signed byte ceiling');
  }
  return result;
}

async function projectItem(
  page: Page,
  item: Locator,
  projection: DomProjectionV1,
): Promise<JsonValueV1> {
  const output: Record<string, JsonValueV1> = {};
  for (const [name, field] of Object.entries(projection.fields)) {
    const target = field.selector === null ? item : item.locator(field.selector);
    const count = await target.count();
    if (count === 0) {
      if (field.required) {
        throw new BrowserProjectionError(
          `required projected field ${JSON.stringify(name)} is absent`,
        );
      }
      output[name] = null;
      continue;
    }
    if (count !== 1) {
      throw new BrowserProjectionError(
        `projected field ${JSON.stringify(name)} must resolve to exactly one element`,
      );
    }
    const value = await projectField(page, target, field);
    if (value === null && field.required) {
      throw new BrowserProjectionError(`required projected field ${JSON.stringify(name)} is empty`);
    }
    output[name] = value;
  }
  return output;
}

async function projectField(
  page: Page,
  target: Locator,
  field: DomProjectionFieldV1,
): Promise<JsonValueV1> {
  if (field.kind === 'text') return target.textContent();
  if (field.kind === 'attribute') return target.getAttribute(field.attribute);
  if (field.kind === 'resolved_url') {
    const value = await target.getAttribute(field.attribute);
    if (value === null) return null;
    try {
      return new URL(value, page.url()).toString();
    } catch {
      throw new BrowserProjectionError('resolved URL field does not contain a valid URL');
    }
  }
  const contents = await target.textContent();
  if (contents === null) return null;
  let json: JsonValueV1;
  try {
    json = parseStrictJson(contents, 'json_ld', Buffer.byteLength(contents, 'utf8'), 32);
  } catch (error) {
    throw new BrowserProjectionError(
      `JSON-LD field is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  try {
    return resolveJsonPointer(json, field.pointer, 'json_ld.pointer');
  } catch {
    return null;
  }
}
