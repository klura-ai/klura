// URL-bypass detector: caller_input on URL query VALUE with kind:"text" or
// kind:"id", zero observations, no source:capability, example appears
// verbatim in runtime_meta.discovered_from_url, AND zero mutating
// perform_actions on the session → reject. The conjunction catches the
// "agent skipped UI exploration and baked their landing URL into the save"
// shape from v10 llm-tests/enum-grounding while leaving legitimate search
// endpoints alone (those have ≥1 mutating action — type + click).
//
// Lives in its own file to keep gate/save-audit.ts under the 1000-line cap;
// the function is invoked by validateCallerInputKindsAndEnums for each
// caller_input param.

import type { Strategy } from '../strategies/skills';
import { wireParamNamesForPlaceholder } from './save-audit';

/** Local structural shape of a notes.params entry. The canonical type lives
 *  in save-audit.ts; redeclaring here keeps the import graph acyclic. */
interface NotesParamLite {
  kind?: unknown;
  source?: unknown;
  example?: unknown;
}

const URL_QUERY_VALUE_BODY_KINDS: ReadonlyArray<string> = ['text', 'id'];

/**
 * True when {{paramName}} (or one of its wire names) appears as a URL query
 * VALUE in the strategy's endpoint — e.g. `?category={{cuisine}}` or
 * `?type={{kind}}`. Query VALUE positions are where filter/enum-shape params
 * live; body / path-segment / header positions don't trigger the
 * URL-bypass gate. Returns false when endpoint is missing / unparseable or
 * the placeholder isn't a query value.
 */
function paramIsUrlQueryValue(data: Strategy, paramName: string): boolean {
  const endpoint = (data as { endpoint?: unknown }).endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return false;
  const queryIdx = endpoint.indexOf('?');
  if (queryIdx < 0) return false;
  const queryString = endpoint.slice(queryIdx + 1);
  const names = new Set<string>([paramName, ...wireParamNamesForPlaceholder(data, paramName)]);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match `<key>={{<name>}}` or `<key>={{<name>}}&...` shapes — the
    // placeholder must be the entire value, not a substring of one.
    const re = new RegExp(`(?:^|&)[^=&]+=\\{\\{${escaped}\\}\\}(?:&|$)`);
    if (re.test(queryString)) return true;
  }
  return false;
}

/**
 * Returns the URL-bypass rejection issue string when the strategy / param /
 * session combination matches the structural shape, or `null` when at least
 * one conjunct fails. Caller appends the issue to the broader
 * literal_provenance validation issue list.
 *
 * The `mutatingActionCount` argument is optional: when omitted, the
 * detector falls through to the broader check (other conjuncts only) and
 * the rejection still fires when discovered_from_url matches verbatim. The
 * mutating-action gate tightens the discrimination between v10's
 * navigate-only shape and a legitimate search flow.
 */
export function detectUrlBypassedFilter(
  data: Strategy,
  paramName: string,
  declared: NotesParamLite,
  observationsLength: number,
  mutatingActionCount: number | undefined,
): string | null {
  const kindVal = declared.kind;
  if (typeof kindVal !== 'string' || !URL_QUERY_VALUE_BODY_KINDS.includes(kindVal)) return null;
  if (observationsLength !== 0) return null;

  const sourceVal = declared.source;
  const hasCapabilitySource = typeof sourceVal === 'string' && sourceVal.startsWith('capability:');
  if (hasCapabilitySource) return null;

  if (!paramIsUrlQueryValue(data, paramName)) return null;

  const exampleVal = declared.example;
  const runtimeMeta = (data as { runtime_meta?: Record<string, unknown> }).runtime_meta;
  const discoveredFromUrl =
    runtimeMeta && typeof runtimeMeta.discovered_from_url === 'string'
      ? runtimeMeta.discovered_from_url
      : undefined;
  if (
    typeof exampleVal !== 'string' ||
    exampleVal.length === 0 ||
    typeof discoveredFromUrl !== 'string' ||
    !discoveredFromUrl.includes(encodeURIComponent(exampleVal))
  ) {
    return null;
  }

  // Mutating-action gate: when the session captured 0 mutating
  // perform_actions, the agent skipped UI exploration entirely — the v10
  // enum-grounding shape. Search endpoints have ≥1 type + ≥1 click before
  // the XHR fires; their mutatingActionCount is non-zero. When the caller
  // didn't supply the count, the gate is treated as unknown and the other
  // conjuncts still trigger the rejection.
  const skippedUiExploration = typeof mutatingActionCount === 'number' && mutatingActionCount === 0;
  const mutatingGateUnknown = typeof mutatingActionCount !== 'number';
  if (!skippedUiExploration && !mutatingGateUnknown) return null;

  return (
    `notes.params.${paramName}.kind = ${JSON.stringify(kindVal)} with example=${JSON.stringify(
      exampleVal,
    )} appears verbatim in runtime_meta.discovered_from_url (${JSON.stringify(
      discoveredFromUrl,
    )}) — the agent navigated to that pre-filtered URL directly without exploring the site's ` +
    `category-tile UI, then baked the landing-URL value into the save as example/text. ` +
    `Warm-time fuzzy-match against caller intent has nothing to map against without observed ` +
    `alternatives — a caller passing a synonym (e.g. "pizza" when the saved example is ` +
    `"italian") gets their literal sent to the API verbatim and the call fails.\n\n` +
    `Pick the right shape:\n` +
    `  • re-do discovery: drive the UI from the listing page (click category tiles / browse ` +
    `the catalogue) to capture alternatives, then save with kind:"enum" + observed_values: ` +
    `[{value, label}, ...].\n` +
    `  • capability source: save the listing endpoint as a sibling capability (e.g. ` +
    `list_categories) and declare \`source:"capability:list_categories"\` on this param so ` +
    `warm-execute fetches fresh values on every call.\n\n` +
    `There is no ack path for this rejection. A strategy whose param example came from the ` +
    `agent's own landing URL rather than from exploration is structurally a stub for one ` +
    `captured value.`
  );
}
