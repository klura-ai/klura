// Strategy-aware assessment of collection INTEGRITY: "this result IS a
// collection the strategy declared, and here is what is structurally wrong
// with it." Emptiness is one case; a collection can also come back with rows
// that are individually well-formed and still fail its contract.
//
// Four assessments live here, each keyed to a `SEMANTIC_REVIEW_REASONS`
// member:
//
//   - `declared_collection_empty`        — the declared collection has no rows.
//   - `collection_field_uniformly_null`  — a declared item field is null in
//                                          every row, i.e. a dead extraction
//                                          path wearing the face of absence.
//   - `collection_unstable_across_runs`  — two back-to-back executions of the
//                                          same strategy with the same args
//                                          disagree on rows.
//   - `collection_pagination_unproven`   — page 1 and page 2 of a strategy that
//                                          declares a paginating caller param
//                                          share rows.
//
// Deliberately separate from `classifyFactoryExecutionResult`: that classifier
// is a pure function of the wire result and its six states are switched on by
// rediscover, start-session, the checkpoint API and the execute cascade. These
// assessors need the strategy bytes, so they are consulted only at the sites
// that hold a strategy object — post-save verification, the candidate-review
// gate and the execute-cascade proof stamp. They never change a classification;
// callers decide what to do with a positive assessment.
//
// Consumption sites classify a raw `ExecuteResult`, whose `body` is the
// complete deserialized value — body compaction (`body_ok`, `body_preview`,
// truncation markers) happens later, in the wire projection. A body these
// assessors cannot inspect is therefore not a collection at all, and a
// non-object body never downgrades anything.

import { collectInlinePlaceholderRefs } from './placeholders';

/** How the strategy declared the collection whose integrity was assessed. */
export const COLLECTION_DECLARATION_SOURCES = [
  /** `response.extract.<key>` carries `multiple: true`. */
  'response_extract_multiple',
  /** `response.from` names a prereq whose `return_shape.kind` is `"array"`. */
  'prereq_array_return_shape',
  /** Derived: the array-valued own properties of an object body are its rows. */
  'derived_empty_arrays',
] as const;

export type CollectionDeclarationSource = (typeof COLLECTION_DECLARATION_SOURCES)[number];

/**
 * Typed reason carried into post-save verification evidence and agent-facing
 * rejection prose. A new trigger adds a union member here, never a free-text
 * string.
 */
export const SEMANTIC_REVIEW_REASONS = {
  declaredCollectionEmpty: 'declared_collection_empty',
  collectionFieldUniformlyNull: 'collection_field_uniformly_null',
  collectionUnstableAcrossRuns: 'collection_unstable_across_runs',
  collectionPaginationUnproven: 'collection_pagination_unproven',
  collectionExceedsDeliveryBudget: 'collection_exceeds_delivery_budget',
} as const;

export type SemanticReviewReason =
  (typeof SEMANTIC_REVIEW_REASONS)[keyof typeof SEMANTIC_REVIEW_REASONS];

export interface DeclaredCollectionEmptiness {
  reason: typeof SEMANTIC_REVIEW_REASONS.declaredCollectionEmpty;
  source: CollectionDeclarationSource;
  /**
   * Shape word for the returned body, from the same vocabulary the public
   * page-script contract uses for `result_shape.kind`.
   */
  result_shape: 'array' | 'object';
  /**
   * Body keys whose declared collection is empty. Empty for a top-level array
   * body, where the collection has no key of its own.
   */
  keys: string[];
}

/** One declared collection located inside a response body. */
export interface LocatedCollection {
  /** Body key holding the rows; `null` for a top-level array body. */
  key: string | null;
  rows: unknown[];
}

/** Every collection one declaration source found in a body. */
export interface DeclaredCollections {
  source: CollectionDeclarationSource;
  result_shape: 'array' | 'object';
  collections: LocatedCollection[];
}

/**
 * A declared item field that is `null` or absent in EVERY row. Emitted only at
 * a row count where the uniformity carries signal.
 */
export interface UniformNullField {
  reason: typeof SEMANTIC_REVIEW_REASONS.collectionFieldUniformlyNull;
  source: CollectionDeclarationSource;
  /** Body key holding the rows; `null` for a top-level array body. */
  collection_key: string | null;
  field: string;
  row_count: number;
  /**
   * Sibling fields whose null-rate is strictly between 0 and 100%. Each one is
   * proof that this extractor emits meaningful nulls, which is what makes a
   * 100% field a dead path rather than a genuinely absent value. An empty list
   * is a weaker finding, not a suppressed one.
   */
  partial_null_siblings: string[];
}

/** One scalar field whose value multiset differed between two runs. */
export interface DivergedField {
  /** Item field, or `null` when the rows themselves are the compared values. */
  field: string | null;
  /**
   * Sum over values of |count in run 1 − count in run 2|: how many row-values
   * are unaccounted for in one direction or the other.
   */
  differing_values: number;
}

/** Two back-to-back runs of the same strategy with the same args disagreed. */
export interface CollectionInstability {
  reason: typeof SEMANTIC_REVIEW_REASONS.collectionUnstableAcrossRuns;
  source: CollectionDeclarationSource;
  collection_key: string | null;
  /** Row counts observed in run 1 and run 2. */
  row_counts: [number, number];
  diverged_fields: DivergedField[];
}

/** Page 1 and page 2 of a paginating strategy were not disjoint. */
export interface PaginationUnproven {
  reason: typeof SEMANTIC_REVIEW_REASONS.collectionPaginationUnproven;
  source: CollectionDeclarationSource;
  collection_key: string | null;
  /** Caller param the strategy declares as advancing the page window. */
  param: string;
  /** The two values executed, in order. */
  values: [string, string];
  /** Row counts of page 1 and page 2. */
  row_counts: [number, number];
  /** Rows present in both pages. */
  overlap_rows: number;
}

/**
 * The rows are real, and the caller will not receive them: the result is larger
 * than the budget applied when a body is delivered inline to an agent, so it
 * arrives compacted or as a truncation notice.
 *
 * Verification fires `execute()` directly and so reads the body whole, which is
 * why this cannot be noticed there without measuring it on purpose. A capability
 * verified against bytes its own caller never sees is verified against the wrong
 * thing.
 */
export interface CollectionExceedsDeliveryBudget {
  reason: typeof SEMANTIC_REVIEW_REASONS.collectionExceedsDeliveryBudget;
  source: CollectionDeclarationSource;
  collection_key: string | null;
  /** Serialized size of the result body. */
  total_chars: number;
  /** The ceiling it has to fit under. */
  budget_chars: number;
  /** Rows the body carried, for the per-row arithmetic the remedy implies. */
  row_count: number;
}

export type CollectionIntegrityFinding =
  | DeclaredCollectionEmptiness
  | UniformNullField
  | CollectionInstability
  | PaginationUnproven
  | CollectionExceedsDeliveryBudget;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extract keys the strategy declared as row lists (`multiple: true`). */
function declaredMultipleExtractKeys(strategy: Record<string, unknown>): string[] {
  const response = asRecord(strategy.response);
  const extract = response ? asRecord(response.extract) : null;
  if (!extract) return [];
  const keys: string[] = [];
  for (const [key, spec] of Object.entries(extract)) {
    const entry = asRecord(spec);
    if (entry?.multiple === true) keys.push(key);
  }
  return keys;
}

/**
 * True when `response.from` names a prereq that declares an array return
 * shape. Prereq values are stored under `binds ?? name`, which is the key
 * `response.from` addresses.
 */
function responseFromDeclaresArray(strategy: Record<string, unknown>): boolean {
  const response = asRecord(strategy.response);
  const from = response?.from;
  if (typeof from !== 'string' || from.length === 0) return false;
  const prereqs = strategy.prerequisites;
  if (!Array.isArray(prereqs)) return false;
  for (const raw of prereqs) {
    const prereq = asRecord(raw);
    if (!prereq) continue;
    const bindKey = typeof prereq.binds === 'string' ? prereq.binds : prereq.name;
    if (bindKey !== from) continue;
    const shape = asRecord(prereq.return_shape);
    if (shape?.kind === 'array') return true;
  }
  return false;
}

/**
 * Locate every collection `strategy` declares inside `body`, or `null` when
 * the body carries no declared collection at all.
 *
 * Declaration sources are consulted in descending explicitness and the first
 * one that finds anything wins. The derived fallback is what catches a
 * page-script that hand-builds `{ok: true, items: [...]}` with no
 * `response.extract` at all — it reads property shape only, never key names.
 *
 * This is the single declaration-source detection every integrity assessor in
 * this module reuses.
 */
export function locateDeclaredCollections(
  strategy: unknown,
  body: unknown,
): DeclaredCollections | null {
  const spec = asRecord(strategy);
  if (!spec) return null;

  // 1. Explicit row-list extraction. `multiple: true` returns an array by
  //    design, so a key declared that way is unambiguously the row list.
  const multipleKeys = declaredMultipleExtractKeys(spec);
  if (multipleKeys.length > 0) {
    const record = asRecord(body);
    if (record) {
      const present = multipleKeys.filter((key) => Array.isArray(record[key]));
      if (present.length > 0) {
        return {
          source: 'response_extract_multiple',
          result_shape: 'object',
          collections: present.map((key) => ({ key, rows: record[key] as unknown[] })),
        };
      }
    }
  }

  // 2. `response.from` bound to a prereq that declares an array return shape:
  //    the body IS that array.
  if (Array.isArray(body) && responseFromDeclaresArray(spec)) {
    return {
      source: 'prereq_array_return_shape',
      result_shape: 'array',
      collections: [{ key: null, rows: body }],
    };
  }

  // 3. Derived: the array-valued own properties of an object body are its row
  //    lists regardless of how the envelope was assembled.
  const record = asRecord(body);
  if (record) {
    const arrayKeys = Object.keys(record).filter((key) => Array.isArray(record[key]));
    if (arrayKeys.length > 0) {
      return {
        source: 'derived_empty_arrays',
        result_shape: 'object',
        collections: arrayKeys.map((key) => ({ key, rows: record[key] as unknown[] })),
      };
    }
  }

  return null;
}

/**
 * Report whether `body` is an empty instance of a collection `strategy`
 * declares, or `null` when no declared collection is empty. Every located
 * collection must be empty — one populated row list means the read worked.
 */
export function assessDeclaredCollectionEmptiness(
  strategy: unknown,
  body: unknown,
): DeclaredCollectionEmptiness | null {
  const located = locateDeclaredCollections(strategy, body);
  if (!located) return null;
  if (!located.collections.every((entry) => entry.rows.length === 0)) return null;
  return {
    reason: SEMANTIC_REVIEW_REASONS.declaredCollectionEmpty,
    source: located.source,
    result_shape: located.result_shape,
    keys: located.collections
      .map((entry) => entry.key)
      .filter((key): key is string => key !== null),
  };
}

/**
 * Minimum rows before a 100%-null field carries signal. With one row, a null
 * field is just a null field — nothing distinguishes "absent here" from "never
 * populated".
 */
const MIN_ROWS_FOR_UNIFORM_NULL = 2;

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/** Union of own keys across rows, in first-seen order. */
function unionFieldKeys(rows: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Rows as records, or `null` when any row is not an object with fields. */
function rowRecords(rows: unknown[]): Record<string, unknown>[] | null {
  const records: Record<string, unknown>[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) return null;
    records.push(record);
  }
  return records;
}

/**
 * Check A — declared item fields that are `null` or absent in every row.
 *
 * Pure analysis of the emitted rows against the shape they actually carry; no
 * extra execution. The finding names the field, the row count and the sibling
 * evidence, and stops there — why a field is null is the agent's call, not a
 * runtime guess.
 */
/**
 * Check D — the result is larger than a body delivered inline to an agent may
 * be, so the rows it carries do not survive the trip.
 *
 * Costs nothing: the body is already in hand, and the ceiling is the same
 * constant the delivery path applies. Verification fires `execute()` directly
 * and therefore reads the body whole, which is exactly why this has to be
 * measured on purpose — otherwise a strategy is verified against bytes its own
 * caller never receives.
 *
 * Scoped to strategies that declare a collection, like the other checks: a
 * capability returning one large document has a different conversation to have
 * than one returning rows that could have been narrower.
 */
export function assessDeliveryBudget(
  strategy: unknown,
  body: unknown,
  budgetChars: number,
): CollectionExceedsDeliveryBudget[] {
  const located = locateDeclaredCollections(strategy, body);
  if (!located) return [];

  let totalChars: number;
  try {
    totalChars = typeof body === 'string' ? body.length : JSON.stringify(body ?? '').length;
  } catch {
    return [];
  }
  if (totalChars <= budgetChars) return [];

  const entry = located.collections[0];
  if (!entry) return [];
  return [
    {
      reason: SEMANTIC_REVIEW_REASONS.collectionExceedsDeliveryBudget,
      source: located.source,
      collection_key: entry.key,
      total_chars: totalChars,
      budget_chars: budgetChars,
      row_count: entry.rows.length,
    },
  ];
}

export function assessUniformNullFields(strategy: unknown, body: unknown): UniformNullField[] {
  const located = locateDeclaredCollections(strategy, body);
  if (!located) return [];
  const findings: UniformNullField[] = [];
  for (const entry of located.collections) {
    if (entry.rows.length < MIN_ROWS_FOR_UNIFORM_NULL) continue;
    const records = rowRecords(entry.rows);
    if (!records) continue;
    const fields = unionFieldKeys(records);
    const uniform: string[] = [];
    const partial: string[] = [];
    for (const field of fields) {
      const nulls = records.filter((row) => isNullish(row[field])).length;
      if (nulls === records.length) uniform.push(field);
      else if (nulls > 0) partial.push(field);
    }
    for (const field of uniform) {
      findings.push({
        reason: SEMANTIC_REVIEW_REASONS.collectionFieldUniformlyNull,
        source: located.source,
        collection_key: entry.key,
        field,
        row_count: records.length,
        partial_null_siblings: partial,
      });
    }
  }
  return findings;
}

/** Canonical comparison token for one scalar value. */
function scalarToken(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'number') return `number:${value}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  return null;
}

/**
 * Stable comparison token for a whole row of unknown shape. A row that cannot
 * serialize is given an identity nothing else matches, so an uncomparable row
 * is never counted as equal to another.
 */
let uncomparableRowSeq = 0;
function rowToken(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded === 'string') return encoded;
  } catch {
    /* fall through to the unique token below */
  }
  uncomparableRowSeq += 1;
  return ` uncomparable:${uncomparableRowSeq}`;
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** Sum over tokens of |count in a − count in b|. */
function multisetDistance(a: Map<string, number>, b: Map<string, number>): number {
  let distance = 0;
  for (const token of new Set([...a.keys(), ...b.keys()])) {
    distance += Math.abs((a.get(token) ?? 0) - (b.get(token) ?? 0));
  }
  return distance;
}

/** Number of rows present in both multisets. */
function multisetOverlap(a: Map<string, number>, b: Map<string, number>): number {
  let overlap = 0;
  for (const [token, count] of a) overlap += Math.min(count, b.get(token) ?? 0);
  return overlap;
}

/**
 * Per-scalar-field value multisets for a row list. Record rows project one
 * multiset per own scalar field; non-record rows have no fields to project, so
 * the rows themselves are the compared values under the `null` field key.
 */
function scalarProjection(rows: unknown[]): Map<string | null, Map<string, number>> {
  const projection = new Map<string | null, Map<string, number>>();
  const records = rowRecords(rows);
  if (!records) {
    projection.set(null, countTokens(rows.map(rowToken)));
    return projection;
  }
  for (const field of unionFieldKeys(records)) {
    const tokens: string[] = [];
    for (const row of records) {
      const token = scalarToken(row[field]);
      if (token !== null) tokens.push(token);
    }
    projection.set(field, countTokens(tokens));
  }
  return projection;
}

function matchCollection(
  located: DeclaredCollections | null,
  key: string | null,
): LocatedCollection | null {
  if (!located) return null;
  return located.collections.find((entry) => entry.key === key) ?? null;
}

/**
 * Check B — the same strategy, executed twice with the same args, disagreed
 * about its rows.
 *
 * Row identity is not declared on the authoring side, so nothing here invents
 * an id heuristic: the comparison is row count plus the multiset of each scalar
 * field's values.
 *
 * What this catches is NONDETERMINISTIC extraction — flaky selectors, and feeds
 * whose rendered contents depend on scroll or timing. It does NOT catch a
 * deterministic drop: an extractor that consistently skips the same row on
 * every run emits identical output twice and passes. Treat a pass as "not
 * observably flaky", never as "complete".
 *
 * Some fields legitimately vary between two immediate runs. Rather than
 * guessing which ones from their names, the finding reports exactly which
 * fields diverged and by how much, and the agent acks a genuinely time-varying
 * one with a reason.
 */
export function assessCollectionStability(
  strategy: unknown,
  firstBody: unknown,
  secondBody: unknown,
): CollectionInstability[] {
  const first = locateDeclaredCollections(strategy, firstBody);
  if (!first) return [];
  const second = locateDeclaredCollections(strategy, secondBody);
  if (!second) return [];
  const findings: CollectionInstability[] = [];
  for (const entry of first.collections) {
    const twin = matchCollection(second, entry.key);
    if (!twin) continue;
    const firstProjection = scalarProjection(entry.rows);
    const secondProjection = scalarProjection(twin.rows);
    const diverged: DivergedField[] = [];
    for (const field of new Set([...firstProjection.keys(), ...secondProjection.keys()])) {
      const distance = multisetDistance(
        firstProjection.get(field) ?? new Map<string, number>(),
        secondProjection.get(field) ?? new Map<string, number>(),
      );
      if (distance > 0) diverged.push({ field, differing_values: distance });
    }
    if (entry.rows.length === twin.rows.length && diverged.length === 0) continue;
    findings.push({
      reason: SEMANTIC_REVIEW_REASONS.collectionUnstableAcrossRuns,
      source: first.source,
      collection_key: entry.key,
      row_counts: [entry.rows.length, twin.rows.length],
      diverged_fields: diverged,
    });
  }
  return findings;
}

/**
 * Check C — page 1 and page 2 of a paginating strategy shared rows.
 *
 * Disjointness is the whole proof: a single page-1 call is byte-for-byte what
 * a strategy that ignores its page param would return, so only a second page
 * distinguishes the two. An overlap — including an identical result — means the
 * param did not take effect, or the slicing is unstable.
 */
export function assessPaginationDisjointness(
  strategy: unknown,
  param: string,
  values: [string, string],
  firstBody: unknown,
  secondBody: unknown,
): PaginationUnproven[] {
  const first = locateDeclaredCollections(strategy, firstBody);
  if (!first) return [];
  const second = locateDeclaredCollections(strategy, secondBody);
  if (!second) return [];
  const findings: PaginationUnproven[] = [];
  for (const entry of first.collections) {
    const twin = matchCollection(second, entry.key);
    if (!twin) continue;
    const overlap = multisetOverlap(
      countTokens(entry.rows.map(rowToken)),
      countTokens(twin.rows.map(rowToken)),
    );
    if (overlap === 0) continue;
    findings.push({
      reason: SEMANTIC_REVIEW_REASONS.collectionPaginationUnproven,
      source: first.source,
      collection_key: entry.key,
      param,
      values,
      row_counts: [entry.rows.length, twin.rows.length],
      overlap_rows: overlap,
    });
  }
  return findings;
}

const DECLARATION_PROSE: Record<CollectionDeclarationSource, string> = {
  response_extract_multiple: 'declared by `response.extract` with `multiple: true`',
  prereq_array_return_shape:
    'declared by the `response.from` prereq\'s `return_shape.kind: "array"`',
  derived_empty_arrays: 'every array-valued property of the returned object is empty',
};

/** One-line agent-facing description of what came back empty. */
export function describeDeclaredCollectionEmptiness(
  assessment: DeclaredCollectionEmptiness,
): string {
  let where = 'the response body is an empty array';
  if (assessment.keys.length > 0) {
    const plural = assessment.keys.length > 1 ? 's' : '';
    where = `\`${assessment.keys.join('`, `')}\` came back as empty array${plural}`;
  }
  return `${where} (${DECLARATION_PROSE[assessment.source]})`;
}

function whereClause(key: string | null): string {
  return key === null ? 'the returned array' : `\`${key}\``;
}

function plural(count: number, singular: string, many: string): string {
  return count === 1 ? singular : many;
}

/** Prose for the sibling asymmetry that makes a uniformly-null field a defect. */
function siblingEvidence(siblings: string[]): string {
  if (siblings.length === 0) {
    return (
      `no sibling field is null in only some rows, so there is no proof this extractor emits ` +
      `meaningful nulls — weaker evidence than a mixed sibling would be`
    );
  }
  const names = siblings.join('`, `');
  return (
    `sibling ${plural(siblings.length, 'field', 'fields')} \`${names}\` ` +
    `${plural(siblings.length, 'is', 'are')} null in some rows and populated in others, so this ` +
    `extractor does emit meaningful nulls — a field that never fires at all is a dead extraction ` +
    `path, not an absent value`
  );
}

/** Prose for the fields whose values moved between two runs. */
function divergenceEvidence(fields: DivergedField[]): string {
  if (fields.length === 0) return '';
  const parts = fields.map((entry) => {
    const name = entry.field === null ? 'the row values' : `\`${entry.field}\``;
    return `${name} (${entry.differing_values} unmatched)`;
  });
  return `; diverging ${plural(fields.length, 'value', 'values')} in ${parts.join(', ')}`;
}

/** One-line agent-facing description of any collection-integrity finding. */
export function describeCollectionIntegrityFinding(finding: CollectionIntegrityFinding): string {
  switch (finding.reason) {
    case SEMANTIC_REVIEW_REASONS.declaredCollectionEmpty:
      return describeDeclaredCollectionEmptiness(finding);
    case SEMANTIC_REVIEW_REASONS.collectionFieldUniformlyNull:
      return (
        `\`${finding.field}\` is null or absent in all ${finding.row_count} rows of ` +
        `${whereClause(finding.collection_key)}; ${siblingEvidence(finding.partial_null_siblings)}`
      );
    case SEMANTIC_REVIEW_REASONS.collectionUnstableAcrossRuns: {
      const counts =
        finding.row_counts[0] === finding.row_counts[1]
          ? `both runs returned ${finding.row_counts[0]} rows`
          : `run 1 returned ${finding.row_counts[0]} rows and run 2 returned ${finding.row_counts[1]}`;
      return (
        `${whereClause(finding.collection_key)} was not reproducible — two back-to-back runs with ` +
        `identical args disagreed: ${counts}${divergenceEvidence(finding.diverged_fields)}`
      );
    }
    case SEMANTIC_REVIEW_REASONS.collectionPaginationUnproven:
      return (
        `pagination over ${whereClause(finding.collection_key)} is unproven — \`${finding.param}\` = ` +
        `${JSON.stringify(finding.values[0])} returned ${finding.row_counts[0]} rows and ` +
        `${JSON.stringify(finding.values[1])} returned ${finding.row_counts[1]}, and ` +
        `${finding.overlap_rows} ${plural(finding.overlap_rows, 'row is', 'rows are')} present in both pages`
      );
    case SEMANTIC_REVIEW_REASONS.collectionExceedsDeliveryBudget:
      return (
        `${whereClause(finding.collection_key)} carried ${finding.row_count} ` +
        `${plural(finding.row_count, 'row', 'rows')} in ${finding.total_chars} chars, over the ` +
        `${finding.budget_chars}-char budget for a body delivered inline — the rows are here, and a ` +
        `caller receives a truncation notice in their place`
      );
  }
}

/**
 * Placeholder names referenced by the request the strategy actually sends.
 *
 * The agent-owned documentation blocks are excluded so that a `{{name}}`
 * written inside a param's own description or example cannot pass for a
 * reference in the request.
 */
function templatedPlaceholderNames(spec: Record<string, unknown>): ReadonlySet<string> {
  const request: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'notes' || key === 'runtime_meta') continue;
    request[key] = value;
  }
  try {
    return collectInlinePlaceholderRefs(JSON.stringify(request));
  } catch {
    return new Set<string>();
  }
}

/**
 * Param docs written in object form, keyed by param name. `notes.params` also
 * accepts a bare description string, which carries no fields to read.
 */
function paramDocEntries(strategy: unknown): Array<[string, Record<string, unknown>]> {
  const spec = asRecord(strategy);
  const notes = spec ? asRecord(spec.notes) : null;
  const params = notes ? asRecord(notes.params) : null;
  if (!params) return [];
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const [name, doc] of Object.entries(params)) {
    const record = asRecord(doc);
    if (record) entries.push([name, record]);
  }
  return entries;
}

/**
 * Caller params for which "does this advance a page window?" is both a live
 * question and a settleable one.
 *
 * Two structural conditions, neither of which reads a param NAME — matching
 * names against a page/offset/cursor list would be a name heuristic, and klura's
 * param vocabulary has no pagination kind to derive from. The strategy must
 * template the param into the request it sends, because a param that cannot
 * change the request cannot advance a window; and its documented example must be
 * an integer, because that is the only value `advancePaginationValue` can step
 * without knowing the site's cursor grammar.
 *
 * The save audit requires an explicit `paginates` answer for exactly this set,
 * and check C proves exactly this set. Same set by construction: the audit never
 * asks about a param the proof could not settle, and the proof never lacks an
 * answer for a param it could have settled.
 */
export function paginationCandidateParams(strategy: unknown): string[] {
  const spec = asRecord(strategy);
  if (!spec) return [];
  const referenced = templatedPlaceholderNames(spec);
  return paramDocEntries(spec)
    .filter(([name, doc]) => referenced.has(name) && advancePaginationValue(doc.example) !== null)
    .map(([name]) => name);
}

/**
 * Caller params the strategy declares as advancing a page window, restricted to
 * the ones it actually templates into its request.
 *
 * A param declared as paginating but never templated cannot change the request,
 * so it is not a pagination proof candidate. An opaque-cursor param may be
 * declared here and is left unproven rather than probed with a guessed token —
 * unlike `paginationCandidateParams`, this set is not restricted to the values
 * check C can step.
 */
export function declaredPaginationParams(strategy: unknown): string[] {
  const spec = asRecord(strategy);
  if (!spec) return [];
  const declared = paramDocEntries(spec)
    .filter(([, doc]) => doc.paginates === true)
    .map(([name]) => name);
  if (declared.length === 0) return [];
  const referenced = templatedPlaceholderNames(spec);
  return declared.filter((name) => referenced.has(name));
}

/**
 * Next value for a paginating param, or `null` when it cannot be advanced.
 *
 * Only an integer-valued argument can be advanced without knowing the site's
 * cursor grammar, so a page window addressed by an opaque cursor is reported as
 * un-runnable rather than probed with a guessed token.
 */
export function advancePaginationValue(value: unknown): { from: string; to: string } | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return null;
  return { from: text, to: String(parsed + 1) };
}

/** One execution of the strategy under verification, at the given caller args. */
export type CollectionIntegrityRerun = (
  args: Record<string, unknown>,
) => Promise<{ body: unknown }>;

export interface CollectionIntegrityOptions {
  strategy: unknown;
  /** Body of the run that already happened, executed at `args`. */
  body: unknown;
  args: Record<string, unknown>;
  rerun: CollectionIntegrityRerun;
  /** Run check B (one extra execution). */
  stability: boolean;
  /** Run check C (one extra execution, only when a paginating param exists). */
  pagination: boolean;
  /** Ceiling for check D — the inline body budget. Omit to skip the check. */
  deliveryBudgetChars?: number;
}

/**
 * Run every collection-integrity check that applies to a result already known
 * to carry rows, and return the findings in evidence order.
 *
 * Check A is pure analysis. Checks B and C each cost one extra execution and
 * are individually disableable, because the checks are consulted once per
 * capability lifetime against a capability that would otherwise silently lose
 * rows on every later call. An extra run that throws, or that comes back with
 * no locatable collection, yields no finding — the comparison it would feed
 * does not exist, and a runtime that cannot compare must not accuse.
 */
export async function assessCollectionIntegrity(
  options: CollectionIntegrityOptions,
): Promise<CollectionIntegrityFinding[]> {
  const { strategy, body, args, rerun } = options;
  if (!locateDeclaredCollections(strategy, body)) return [];
  const findings: CollectionIntegrityFinding[] = [];

  const fireOrNull = async (
    callArgs: Record<string, unknown>,
  ): Promise<{ body: unknown } | null> => {
    try {
      return await rerun(callArgs);
    } catch {
      return null;
    }
  };

  findings.push(...assessUniformNullFields(strategy, body));

  if (typeof options.deliveryBudgetChars === 'number') {
    findings.push(...assessDeliveryBudget(strategy, body, options.deliveryBudgetChars));
  }

  if (options.stability) {
    const second = await fireOrNull(args);
    if (second) findings.push(...assessCollectionStability(strategy, body, second.body));
  }

  if (options.pagination) {
    for (const param of declaredPaginationParams(strategy)) {
      const step = advancePaginationValue(args[param]);
      if (!step) continue;
      const next = await fireOrNull({ ...args, [param]: step.to });
      if (!next) continue;
      findings.push(
        ...assessPaginationDisjointness(strategy, param, [step.from, step.to], body, next.body),
      );
    }
  }

  return findings;
}
