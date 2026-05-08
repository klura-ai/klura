import { pool, listenerManager } from '../runtime-state';
import type { ListenerEvent } from '../listeners';
import { truncateString } from '../response/response-size';
import { asPlatformSlug, asIdentifierSlug, asObject, ValidationError } from '../validators';

export function status(): { activeSessions: number; activeListeners: number } {
  return {
    activeSessions: pool.activeSessions,
    activeListeners: listenerManager.listActive().length,
  };
}

export async function startListener(
  platform: string,
  capability: string,
  args?: Record<string, unknown>,
): Promise<{ listenerId: string }> {
  // Validate inputs through the centralized validator layer
  try {
    asPlatformSlug(platform, 'platform');
    asIdentifierSlug(capability, 'capability');
    if (args !== undefined) {
      asObject(args, 'args');
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_listener: ${e.message}`, { cause: e });
    }
    throw e;
  }
  return await listenerManager.start(platform, capability, args ?? {});
}

export async function stopListener(listenerId: string): Promise<{ ok: true }> {
  return await listenerManager.stop(listenerId);
}

// Listener events carry `data: unknown` whose size isn't bounded — a single
// captured WebSocket frame or HTTP body can be multi-KB, and a listener session
// can accumulate hundreds of events. Paginate + truncate per-event data to keep
// the response under the MCP budget.
const GET_EVENTS_DEFAULT_PAGE_SIZE = 20;
const GET_EVENTS_MAX_PAGE_SIZE = 100;
const GET_EVENTS_PER_EVENT_DATA_CAP = 1_000;

export function getEvents(
  since?: number,
  page?: number,
  pageSize?: number,
): {
  events: Array<ListenerEvent & { data_truncated?: true; data_total_chars?: number }>;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
} {
  const all = listenerManager.getEvents(since);
  const total = all.length;
  const effPageSize = Math.max(
    1,
    Math.min(
      typeof pageSize === 'number' ? Math.floor(pageSize) : GET_EVENTS_DEFAULT_PAGE_SIZE,
      GET_EVENTS_MAX_PAGE_SIZE,
    ),
  );
  const effPage = Math.max(1, Math.floor(page ?? 1));
  const start = (effPage - 1) * effPageSize;
  const slice = all.slice(start, start + effPageSize);
  const events = slice.map((ev) => {
    let serialized: string;
    try {
      serialized = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
    } catch {
      return ev;
    }
    if (serialized.length > GET_EVENTS_PER_EVENT_DATA_CAP) {
      return {
        ...ev,
        data: truncateString(serialized, GET_EVENTS_PER_EVENT_DATA_CAP),
        data_truncated: true as const,
        data_total_chars: serialized.length,
      };
    }
    return ev;
  });
  return {
    events,
    page: effPage,
    page_size: effPageSize,
    total,
    has_more: start + slice.length < total,
  };
}

export function listListeners(): Array<{
  id: string;
  platform: string;
  capability: string;
  startedAt: number;
}> {
  return listenerManager.listActive();
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.startListener,
    description:
      'Start a real-time event listener (WebSocket, SSE, or HTTP polling). Requires a saved listener strategy. Returns a listenerId for polling events.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform name (e.g. "chat-app")' },
        capability: { type: 'string', description: 'Listener capability (e.g. "on_new_message")' },
        args: { type: 'object', description: 'Arguments (e.g. {"userId": "alice"})' },
      },
      required: ['platform', 'capability'],
    },
    handler: (args: any) => startListener(args.platform, args.capability, args.args || {}),
  },

  {
    name: TOOL_NAMES.stopListener,
    description: 'Stop a running event listener.',
    inputSchema: {
      type: 'object',
      properties: { listener_id: { type: 'string' } },
      required: ['listener_id'],
    },
    handler: (args: any) => stopListener(args.listener_id),
  },

  {
    name: TOOL_NAMES.getEvents,
    description:
      'Get events received by active listeners. Paginated — default 20 events per page, max 100. Per-event `data` field is truncated to 1KB with `data_truncated: true` + `data_total_chars` markers when longer. Response shape: `{events, page, page_size, total, has_more}`. Without `since`, returns (and clears) the full queue. With `since` (timestamp ms), returns events after that time without clearing.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Only return events after this timestamp (ms)' },
        page: { type: 'number', description: '1-indexed page number. Default 1.' },
        page_size: { type: 'number', description: 'Events per page. Default 20, max 100.' },
      },
    },
    handler: (args: any) => getEvents(args.since, args.page, args.page_size),
  },
];
