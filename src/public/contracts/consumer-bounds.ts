// Shared numeric bounds and key lists for the consumer tool input surface.
// The MCP argument contracts, SDK validation, daemon wire contracts, CLI flag
// parsing, and the domain caller-bounds parser (scrape-policy.ts) all read
// these entries, so each bound exists exactly once and a value an adapter
// admits is a value run planning can accept.

/** One inclusive integer range shared by every consumer boundary. */
export interface ConsumerIntegerBoundV1 {
  minimum: number;
  maximum: number;
}

export const CONSUMER_BOUNDS = {
  /** `call_package_capability` / `--timeout-ms` call deadline. */
  call_timeout_ms: { minimum: 1, maximum: 300_000 },
  /** `wait_scrape_run` one-shot durable-state observer timeout. */
  wait_timeout_ms: { minimum: 0, maximum: 25_000 },
  /** `wait_scrape_run` caller-known durable journal version. */
  after_state_version: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  /** `list_scrape_run_items` exclusive committed-item sequence cursor. */
  after_sequence: { minimum: 0, maximum: 1_000_000_000 },
  /** Page size for installed-package, run, and run-item listings. */
  page_limit: { minimum: 1, maximum: 100 },
  /** Page size for `search_packages`. */
  search_limit: { minimum: 1, maximum: 50 },
  /**
   * One caller bound (`max_items`, `max_pages`, `max_requests`, `timeout_ms`,
   * `max_concurrency`).
   */
  caller_bound: { minimum: 1, maximum: 3_600_000 },
  /** One named caller limit value. */
  caller_limit: { minimum: 1, maximum: 1_000_000 },
} as const satisfies Record<string, ConsumerIntegerBoundV1>;

/** UTF-8 byte ceilings for consumer string inputs. */
export const CONSUMER_BYTE_LIMITS = {
  cursor: 1_024,
  query: 512,
  interaction_id: 48,
} as const;

/** Maximum entry count of one named caller-limit map. */
export const CONSUMER_LIMITS_MAX_ENTRIES_V1 = 64;

/**
 * The flattened caller-bound keys. Caller-facing `start_scrape_run` options
 * carry them at the top level; the daemon wire body folds them into the
 * nested `caller_bounds` object. Folding code iterates this list.
 */
export const CALLER_BOUND_KEYS = [
  'max_items',
  'max_pages',
  'max_requests',
  'timeout_ms',
  'max_concurrency',
] as const;

export type CallerBoundKeyV1 = (typeof CALLER_BOUND_KEYS)[number];
