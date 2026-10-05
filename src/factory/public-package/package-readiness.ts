// Whether a saved strategy can be packaged, asked at the moment it is saved.
//
// A strategy that works here is not yet one a package can carry: the public
// profile admits one page program or one static request, a literal origin, and
// an outcome inside fixed bounds. Finding that out when a package is compiled
// costs a second authoring session, long after the page that would have
// answered the question was closed. The checks here are the exporter's own —
// the same compile step and the same schema bounds — so a strategy that passes
// them at save is one the exporter will accept, and one that fails is told why
// while its author can still change it.
//
// Two questions, asked at different moments:
//   - structure, from the strategy alone, before it is committed;
//   - result, from the response its verification run returned.
// Neither needs the network.
import { PublicContractError } from '../../public/contracts/common';
import type { Strategy } from '../../strategies/skills';
import { exportReviewedLocalFetchStrategySource } from './http-export';
import { exportReviewedLocalPageScriptStrategySource } from './page-script-export';
import {
  boundedListing,
  encodedBytes,
  inferOutcomeSchema,
  isHollowRecord,
  MAX_OUTCOME_BYTES_V1,
  OutcomeShapeError,
} from './outcome-shape';

const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

/** Strategy fields that declare where a request goes. Read from the fields
 *  that declare an origin, never scanned out of the document: scanning matches
 *  URLs in evidence excerpts and prose. */
const ORIGIN_FIELDS = new Set(['baseUrl', 'url', 'origin']);

interface ParamSpec {
  example?: unknown;
  optional?: unknown;
}

function paramsOf(strategy: Strategy): Record<string, ParamSpec | null | undefined> {
  const params: unknown = strategy.notes?.params;
  return params !== null && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, ParamSpec | null | undefined>)
    : {};
}

function firstPrerequisite(strategy: Strategy): Record<string, unknown> | null {
  const list = (strategy as { prerequisites?: unknown }).prerequisites;
  const first: unknown = Array.isArray(list) ? list[0] : undefined;
  return first !== null && typeof first === 'object' ? (first as Record<string, unknown>) : null;
}

/**
 * Inputs a page script's own templates read. A template slot with nothing to
 * fill it has no public meaning, so a param the author marked optional is
 * required of a package caller whenever the page URL or the argument template
 * names it.
 */
function templatedInputs(strategy: Strategy): Set<string> {
  const names = new Set<string>();
  if (strategy.strategy !== 'page-script') return names;
  const prerequisite = firstPrerequisite(strategy);
  if (!prerequisite) return names;
  const text = JSON.stringify([prerequisite.url ?? '', prerequisite.args_template ?? {}]);
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

/**
 * The input schema a package declares for a strategy, from its documented
 * params. The example is the ground truth for the type: it is the value the
 * capability was verified with.
 */
export function inputSchemaFromParams(strategy: Strategy): Record<string, unknown> {
  const templated = templatedInputs(strategy);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(paramsOf(strategy))) {
    const example = spec?.example;
    let schema: Record<string, unknown> = { type: 'string' };
    if (typeof example === 'number') schema = { type: 'number' };
    else if (typeof example === 'boolean') schema = { type: 'boolean' };
    else if (example === null) schema = { type: 'string', nullable: true };
    properties[name] = schema;
    if (spec?.optional !== true || templated.has(name)) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** The literal https origin a URL template starts with, or null. A templated
 *  host is not an origin anyone can sign. */
function literalOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(https:\/\/[^/?#]+)/.exec(value);
  const origin = match?.[1];
  return origin && !origin.includes('{{') ? origin : null;
}

function declaredOrigins(strategy: Strategy): string[] {
  const origins = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && ORIGIN_FIELDS.has(key)) {
        const origin = literalOrigin(value);
        if (origin) origins.add(origin);
      } else if (value && typeof value === 'object') {
        visit(value, depth + 1);
      }
    }
  };
  visit(strategy, 0);
  return [...origins];
}

/** The review block the exporter compiles a strategy under when nobody has
 *  written one: the settings a first export starts from. */
function compileWithDefaults(strategy: Strategy, capability: string): void {
  const common = {
    local_strategy: strategy,
    input_schema: inputSchemaFromParams(strategy),
    strategy_id: `${capability}_v1`,
    replay: 'safe_read',
  };
  if (strategy.strategy === 'fetch') {
    exportReviewedLocalFetchStrategySource({
      ...common,
      context: 'node',
      response_body_limit_bytes: 1_000_000,
    });
    return;
  }
  exportReviewedLocalPageScriptStrategySource({
    ...common,
    wait: { kind: 'dom_content_loaded' },
    interaction: null,
    expect: {
      wait: null,
      egress_rule_ids: [],
      minimum_matching_requests: 0,
      maximum_matching_requests: 0,
    },
    request_body_limits: {
      max_encoded_request_body_bytes_per_script: 0,
      max_single_request_body_bytes: 0,
      max_encoded_request_body_bytes_by_rule: {},
    },
    // Whether a program's JSON string holds an object or an array is read off
    // the response it returns, which this question does not have; either
    // answer compiles the same structure.
    result_kind: 'object',
  });
}

/**
 * Whether packaging applies to a strategy at all. A package is a read: a
 * strategy that changes something on the site is saved for local use and is
 * never a candidate, whatever its shape.
 */
export function isPackageCandidate(strategy: Strategy): boolean {
  const effect = (strategy as { effect?: unknown }).effect;
  return effect === undefined || effect === 'read';
}

/**
 * Why a strategy's structure cannot be packaged, read from the strategy
 * alone. Empty when the exporter would compile it.
 */
export function packageStructureIssues(strategy: Strategy, capability: string): string[] {
  if (strategy.strategy !== 'fetch' && strategy.strategy !== 'page-script') {
    return [
      `a ${strategy.strategy} strategy replays interface actions, which a package cannot carry — ` +
        `save the capability as \`fetch\` or \`page-script\``,
    ];
  }
  const issues: string[] = [];
  if (strategy.strategy === 'page-script') {
    const prerequisite = firstPrerequisite(strategy);
    const page = prerequisite?.url ?? (strategy as { url?: unknown }).url;
    if (literalOrigin(page) === null) {
      issues.push(
        'the page program names no page with a literal https origin to open — give its ' +
          'prerequisite a `url` that starts with the site origin and builds the rest from the arguments',
      );
    }
  } else if (declaredOrigins(strategy).length === 0) {
    issues.push(
      'the request has no literal https origin — an argument that is a whole URL cannot be ' +
        "signed; take the site's own id and build the URL from it",
    );
  }
  try {
    compileWithDefaults(strategy, capability);
  } catch (error) {
    if (!(error instanceof PublicContractError)) throw error;
    issues.push(error.message);
  }
  return issues;
}

/**
 * Why the response a strategy returned cannot be signed as its outcome. Empty
 * when a schema inside the contract's bounds describes it.
 */
export function packageResultIssues(strategy: Strategy, body: unknown, args: unknown): string[] {
  if (isHollowRecord(body, args)) {
    return [
      'every field came back empty — the documented example names nothing the site has, so ' +
        'the call proves only that the capability can report an absence. Document an example ' +
        'that returns a real record',
    ];
  }
  let described = body;
  const bytes = encodedBytes(body);
  if (bytes > MAX_OUTCOME_BYTES_V1) {
    // A static request's listing is cut to the rows that fit when the package
    // is built. A page program's result is bounded before any such cut, so it
    // has to arrive inside the bound.
    const bounded = strategy.strategy === 'fetch' ? boundedListing(body) : null;
    if (!bounded) {
      return [
        `one call returned ${bytes} bytes and a packaged capability may return ${MAX_OUTCOME_BYTES_V1} — ` +
          `return the fields a caller reads, and give a listing \`page\` / \`page_size\` arguments`,
      ];
    }
    described = bounded.projected;
  }
  try {
    inferOutcomeSchema(described);
  } catch (error) {
    if (!(error instanceof OutcomeShapeError)) throw error;
    return [error.message];
  }
  return [];
}
