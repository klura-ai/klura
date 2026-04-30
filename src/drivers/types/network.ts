import type { WebSocketFrame, WsFrameSummary } from './websocket';

export interface InterceptedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData: unknown;
  status: number | null;
  responseBody: unknown;
  /** Unix-ms timestamp when the request fired. Stamped at capture time
   *  (Network.requestWillBeSent). Essential for multi-capability
   *  sessions: the agent correlates this with `get_action_history`
   *  timestamps to associate each XHR with the click/type/navigate
   *  that triggered it. */
  timestamp?: number;
  /** True when this was a full-page navigation request (HTML form POST, link
   *  click). */
  isNavigation?: boolean;
  /** For 3xx responses: the Location header value, i.e. where the browser
   *  ended up. */
  redirectUrl?: string;
  /**
   * Names of cookies set by this response's Set-Cookie header(s). Names only —
   * VALUES are deliberately omitted (they're typically session-bearing
   * secrets). Powers the auth-gated-without-login-prereq detector: a request
   * whose response sets a session-shape cookie is by-construction
   * session-establishing, and any saved fetch/page-script that shares the
   * origin will silently rely on that cookie unless the strategy declares
   * `prerequisites: [{kind: "capability", capability: "<login>"}]`.
   */
  setCookieNames?: string[];
  /**
   * Absolute index into the raw intercepted array. Populated by the shaping
   * layer in detail-lite and summary modes so callers can round-trip via `{i,
   * full: true}` to fetch a single untrimmed entry. Undefined on the live array
   * the driver maintains; only present on shaped responses.
   */
  i?: number;
  /**
   * Set by `get_network_log` (both detail-lite and detail-full modes) when an
   * entry's responseBody was sliced to fit the tool-output budget. The caller
   * sees the slice in `responseBody`, its character range via `_slice_start` /
   * `_slice_end`, the original size via `_total_chars`, and a human-readable
   * pointer in `_hint` for fetching the next chunk or pivoting to
   * `find_in_page`. Never present on the live intercepted array maintained by
   * the driver.
   */
  responseBody_truncated?: boolean;
  responseBody_total_chars?: number;
  /** Character offset the current responseBody slice starts at. 0 for the
   *  default head-slice. */
  responseBody_slice_start?: number;
  /** Exclusive end char of the slice. Equal to responseBody_total_chars when
   *  the whole body fit in one call. */
  responseBody_slice_end?: number;
  /** Human-readable pointer telling the caller how to fetch the next chunk
   *  (or pivot to find_in_page for targeted extraction). Only present when
   *  a slice was taken. */
  responseBody_hint?: string;
}

/**
 * Compact view of an InterceptedRequest for `get_network_log` summary mode.
 * Carries only structural info — no headers, no bodies — so the agent can scan
 * a long session and decide which entries to fetch in detail. The `i` field is
 * an absolute index into the raw `intercepted` array, stable across filters and
 * pagination, so the agent can pass it back via `{i: N, full: true}` to grab
 * the verbatim entry.
 */
export interface NetworkLogSummary {
  i: number;
  method: string;
  url: string;
  status: number | null;
  contentType?: string;
  postDataSize?: number;
  responseSize?: number;
  isNavigation?: boolean;
  redirectUrl?: string;
  /** Unix-ms timestamp when the request fired. Use with
   *  `get_action_history({since, until})` to time-correlate XHRs to
   *  the click/type/navigate that triggered them. */
  ts?: number;
}

export interface NetworkLogOptions {
  /** Absolute index into the raw intercepted array. With full:true returns
   *  one entry verbatim, bypassing all filters and pagination. */
  i?: number;
  /** Absolute index into the raw wsFrames array. With full:true returns one
   *  frame verbatim (payload untrimmed), bypassing all filters and pagination.
   *  Mutually exclusive with `i` — pick the array you want the detail view
   *  from. */
  ws_i?: number;
  /** Return raw entries instead of summaries. Single entry with `i` or
   *  `ws_i`, paginated detail-list otherwise. */
  full?: boolean;
  /** Case-insensitive substring filter on URL. Applied before `last` and
   *  pagination. */
  url_contains?: string;
  /**
   * Case-insensitive substring search across every field of each entry: URL,
   * request header names and values, request body, and response body — plus
   * every captured WebSocket frame's payload. Use this when you know the
   * literal text of a value you just typed or that the server echoed back (e.g.
   * the message you just sent, the title you just posted) — one targeted call
   * finds the HTTP request OR the WS frame that carried or echoed the string
   * without URL-shape guessing. On realtime / chat sites the write is usually a
   * sent WS frame, not an HTTP POST, and this filter surfaces it in the
   * response's `wsFrames` field.
   */
  text_contains?: string;
  /** Tail the last N entries after filters. Use to narrow the log to the
   *  requests that fired right after a submit action — the send/post/order
   *  endpoint is almost always in the final few entries of the session.
   *  Applies to both HTTP entries and WS frames independently. */
  last?: number;
  /** 1-indexed page number. Default 1. */
  page?: number;
  /** Override default page size. Summary default 50 (max 200); detail-list
   *  default 5 (max 20). */
  page_size?: number;
  /** Byte offset into the responseBody for `{i, full:true}` detail mode. Use
   *  when a response body is larger than the tool-output budget: the first
   *  call returns the head with `responseBody_truncated: true` and a
   *  `responseBody_total_chars` count; follow up with `{i, full:true,
   *  body_offset: N}` to read further. Non-detail modes ignore this. */
  body_offset?: number;
  /** Max response-body characters to return in `{i, full:true}` detail mode.
   *  Default: the tool-output budget (MAX_TOOL_OUTPUT_CHARS) minus an
   *  allowance for request headers / URL / postData; clamped to the budget. */
  body_length?: number;
}

export interface NetworkLogResponse {
  requests: NetworkLogSummary[] | InterceptedRequest[] | InterceptedRequest;
  /**
   * Captured WebSocket frames, always included in summary / detail-lite modes
   * when the session has any. The same `text_contains` / `last` filters apply —
   * a filter-narrowed call with a matching ws frame surfaces the frame here
   * with its URL + payload preview, which is how realtime / chat writes (sent
   * over a persistent WS with no HTTP footprint) get classified as `protocol:
   * "websocket"`. Follow up with `{ws_i: N, full: true}` for the full payload
   * bytes.
   *
   * Absent in `detail` mode and when `{ws_i, full: true}` is used (that call
   * returns the single untrimmed frame as `wsFrame` below).
   */
  wsFrames?: WsFrameSummary[];
  /** The untrimmed frame when `{ws_i: N, full: true}` was called. */
  wsFrame?: WebSocketFrame;
  /** Total ws frames captured on the session (pre-filter). */
  wsFramesTotal?: number;
  /** Count of ws frames that matched the active filters. */
  wsFramesFiltered?: number;
  total: number;
  total_filtered: number;
  returned: number;
  page: number;
  page_size: number;
  total_pages: number;
  has_more: boolean;
  /**
   * - `summary`: compact per-request metadata, no headers or bodies.
   * - `detail`: a single verbatim entry fetched via `{i, full: true}` or
   *   `{ws_i, full: true}`.
   * - `detail-list`: paginated raw entries fetched via `{full: true}`.
   * - `detail-lite`: auto-selected when a narrowing filter is present and
   *   the full-detail result fits the tool-output budget after trimming
   *   each entry's `responseBody` to a preview. Full request side
   *   (headers + postData) is preserved verbatim. Responses are clipped
   *   in place with `responseBody_truncated: true` +
   *   `responseBody_total_chars`.
   */
  mode: 'summary' | 'detail' | 'detail-list' | 'detail-lite';
  warning?: string;
  /**
   * Inline complex-envelope advisory emitted when one of the structural
   * detectors (binary WS write, multipart binary, escaped-JSON envelope, binary
   * HTTP body, signed request, high-entropy body, persisted GraphQL) fires
   * against the entries surfaced in this response. Carries a kind, a pointer
   * back to the triggering entry (`ws_i` for WS-side detectors, `i` for
   * HTTP-side detectors), structural evidence, reference URLs to read, and a
   * short message that names the right tier and the iteration primitive to use.
   * Only one advisory per response (highest-priority detector wins). Absent on
   * simple-site responses where no detector matches and on summary mode (where
   * the body bytes are not surfaced).
   */
  _advisory?: unknown;
  _diag?: unknown;
}
