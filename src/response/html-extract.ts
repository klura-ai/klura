// Pure Node HTML extraction via cheerio. Single-purpose helper the Node execute
// paths, the strategy probe, and the old in-browser HTML response path all
// route through.
//
// Before this module: `driver.extractFromDocument` ran a DOMParser closure
// inside a Playwright page context just to do `querySelector` on an HTML string
// that was already in the Node process. It shipped the string through CDP,
// parsed in-browser, shipped the result back. That made sense when klura had a
// browser for everything and `page.evaluate` was "free" — now that the warm
// path is Node-native, the in-browser detour is absurd overhead. Cheerio gives
// us the same selector semantics (jQuery-compatible CSS selectors + attribute
// access) as a pure Node function with zero driver interaction.
//
// The contract matches what `extractFromDocument` promised so callers don't
// have to reason about two different shapes: - selectors is a map of varName →
// { selector, attr?, multiple? } - return value is a map of varName → string
// (single) or string[] (multiple) - missing matches return '' (single) or []
// (multiple), NEVER undefined, because the probe relies on emptiness detection
// to reject all-empty extracts as auth-wall interstitials

import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';

interface HtmlExtractSpec {
  selector: string;
  /** Read this attribute instead of the element text content. Mutually
   *  exclusive with `fields`. */
  attr?: string;
  /** When true, return all matches as an array. When false/unset, return the
   *  first match. */
  multiple?: boolean;
  /** Per-row sub-extract. When set, the spec defines a ROW selector and a map
   *  of per-row field extracts, each scoped to that row. With `multiple:true`
   *  produces `Array<Record<string,string>>`; with explicit `multiple:false`
   *  produces a single `Record<string,string>` for the first match. Field
   *  specs are flat (one level of nesting only) — `fields` inside `fields` is
   *  rejected at save time. Mutually exclusive with `attr`. */
  fields?: HtmlExtractFlatSelectors;
}

/** Flat selector spec used inside `fields` — no further nesting. */
type HtmlExtractFlatSpec = Omit<HtmlExtractSpec, 'fields'>;
type HtmlExtractFlatSelectors = Record<string, HtmlExtractFlatSpec>;

type HtmlExtractSelectors = Record<string, HtmlExtractSpec>;
type HtmlExtractRow = Record<string, string>;
type HtmlExtractValue = string | string[] | HtmlExtractRow | HtmlExtractRow[];
type HtmlExtractResult = Record<string, HtmlExtractValue>;

/**
 * Apply a set of CSS selector specs to an HTML string and return a flat map of
 * varName → extracted value(s).
 *
 * Thin wrapper around cheerio's `load()` + jQuery-like selector API. The HTML
 * is parsed once per call; cheerio's parser (parse5 via htmlparser2) handles
 * malformed HTML gracefully the same way Chrome's quirks-mode recovery does, so
 * we don't need to pre-sanitize input.
 *
 * Does not mutate the input string. Safe to call concurrently; each call owns
 * its own cheerio document.
 *
 * Spec shapes:
 *  - Leaf: `{selector, attr?, multiple?}` — extracts a string or string[].
 *  - Row group: `{selector, multiple:true, fields: {...}}` — iterates over
 *    matches of `selector` and runs each `fields` entry scoped to that row,
 *    producing `Array<Record<string,string>>`.
 *  - Single row: `{selector, fields:{...}}` (or `multiple:false`) — scopes
 *    the fields to the first match, producing a `Record<string,string>`.
 */
export function extractFromHtml(html: string, selectors: HtmlExtractSelectors): HtmlExtractResult {
  const $ = cheerio.load(html);
  const out: HtmlExtractResult = {};

  for (const [name, spec] of Object.entries(selectors)) {
    out[name] = extractEntry($, $.root(), spec);
  }

  return out;
}

function extractEntry(
  $: CheerioAPI,
  scope: Cheerio<Element> | ReturnType<CheerioAPI['root']>,
  spec: HtmlExtractSpec,
): HtmlExtractValue {
  const matches = (scope as Cheerio<Element>).find(spec.selector);
  let out: HtmlExtractValue;
  if (spec.fields) {
    if (spec.multiple) {
      const rows: HtmlExtractRow[] = [];
      const fields = spec.fields;
      matches.each((_, el) => {
        rows.push(extractRowFields($, $(el), fields));
      });
      out = rows;
    } else if (matches.length === 0) {
      out = {};
    } else {
      out = extractRowFields($, matches.first(), spec.fields);
    }
  } else if (spec.multiple) {
    const values: string[] = [];
    matches.each((_, el) => {
      const value = spec.attr ? $(el).attr(spec.attr) : $(el).text().trim();
      values.push(value ?? '');
    });
    out = values;
  } else if (matches.length === 0) {
    out = '';
  } else {
    const first = matches.first();
    const value = spec.attr ? first.attr(spec.attr) : first.text().trim();
    out = value ?? '';
  }
  return out;
}

function extractRowFields(
  $: CheerioAPI,
  row: Cheerio<Element>,
  fields: HtmlExtractFlatSelectors,
): HtmlExtractRow {
  const out: HtmlExtractRow = {};
  for (const [fieldName, fieldSpec] of Object.entries(fields)) {
    // Empty selector means "this row's own element" — read attr/text directly
    // from `row` rather than running a `.find()` that would skip self.
    let matches: Cheerio<Element>;
    if (fieldSpec.selector.length === 0) {
      matches = row;
    } else {
      matches = row.find(fieldSpec.selector);
    }
    if (fieldSpec.multiple) {
      // multiple inside fields collapses to a comma-joined string so the
      // overall return shape stays `Record<string,string>` (callers that
      // need arrays should declare the array at the top level).
      const parts: string[] = [];
      matches.each((_, el) => {
        const v = fieldSpec.attr ? $(el).attr(fieldSpec.attr) : $(el).text().trim();
        parts.push(v ?? '');
      });
      out[fieldName] = parts.join(',');
      continue;
    }
    if (matches.length === 0) {
      out[fieldName] = '';
      continue;
    }
    const first = matches.first();
    const value = fieldSpec.attr ? first.attr(fieldSpec.attr) : first.text().trim();
    out[fieldName] = value ?? '';
  }
  return out;
}
