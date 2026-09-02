// Strategy-aware assessment of "this result IS a collection the strategy
// declared, and that collection came back empty."
//
// Deliberately separate from `classifyFactoryExecutionResult`: that classifier
// is a pure function of the wire result and its six states are switched on by
// rediscover, start-session, the checkpoint API and the execute cascade. This
// assessor needs the strategy bytes, so it is consulted only at the two sites
// that hold a strategy object — post-save verification and the execute-cascade
// proof stamp. It never changes a classification; callers decide what to do
// with a positive assessment.
//
// Both consumption sites classify a raw `ExecuteResult`, whose `body` is the
// complete deserialized value — body compaction (`body_ok`, `body_preview`,
// truncation markers) happens later, in the wire projection. A body this
// assessor cannot inspect is therefore not an empty collection, and a
// non-object body never downgrades anything.

/** How the strategy declared the collection whose emptiness was observed. */
export const COLLECTION_DECLARATION_SOURCES = [
  /** `response.extract.<key>` carries `multiple: true`. */
  'response_extract_multiple',
  /** `response.from` names a prereq whose `return_shape.kind` is `"array"`. */
  'prereq_array_return_shape',
  /** Body is an object whose every array-valued own property is empty. */
  'derived_empty_arrays',
] as const;

export type CollectionDeclarationSource = (typeof COLLECTION_DECLARATION_SOURCES)[number];

/**
 * Typed reason carried into post-save verification evidence and agent-facing
 * rejection prose. Single-valued today; a union member is added here (not a
 * free-text string) when a second semantic-review trigger ships.
 */
export const SEMANTIC_REVIEW_REASONS = {
  declaredCollectionEmpty: 'declared_collection_empty',
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
 * Report whether `body` is an empty instance of a collection `strategy`
 * declares, or `null` when no declared collection is empty.
 *
 * Declaration sources are consulted in descending explicitness. The derived
 * fallback is what catches a page-script that hand-builds `{ok: true, items:
 * []}` with no `response.extract` at all — it reads property shape only, never
 * key names.
 */
export function assessDeclaredCollectionEmptiness(
  strategy: unknown,
  body: unknown,
): DeclaredCollectionEmptiness | null {
  const spec = asRecord(strategy);
  if (!spec) return null;

  // 1. Explicit row-list extraction. `multiple: true` returns `[]` by design,
  //    so an empty array under such a key is unambiguous.
  const multipleKeys = declaredMultipleExtractKeys(spec);
  if (multipleKeys.length > 0) {
    const record = asRecord(body);
    if (record) {
      const present = multipleKeys.filter((key) => Array.isArray(record[key]));
      if (present.length > 0 && present.every((key) => (record[key] as unknown[]).length === 0)) {
        return {
          reason: SEMANTIC_REVIEW_REASONS.declaredCollectionEmpty,
          source: 'response_extract_multiple',
          result_shape: 'object',
          keys: present,
        };
      }
    }
  }

  // 2. `response.from` bound to a prereq that declares an array return shape:
  //    the body IS that array.
  if (Array.isArray(body) && body.length === 0 && responseFromDeclaresArray(spec)) {
    return {
      reason: SEMANTIC_REVIEW_REASONS.declaredCollectionEmpty,
      source: 'prereq_array_return_shape',
      result_shape: 'array',
      keys: [],
    };
  }

  // 3. Derived: an object body whose array-valued own properties are all
  //    empty carries no rows regardless of how it was assembled.
  const record = asRecord(body);
  if (record) {
    const arrayKeys = Object.keys(record).filter((key) => Array.isArray(record[key]));
    if (arrayKeys.length > 0 && arrayKeys.every((key) => (record[key] as unknown[]).length === 0)) {
      return {
        reason: SEMANTIC_REVIEW_REASONS.declaredCollectionEmpty,
        source: 'derived_empty_arrays',
        result_shape: 'object',
        keys: arrayKeys,
      };
    }
  }

  return null;
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
