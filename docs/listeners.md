# Listeners — event-driven capabilities

Not all capabilities are request/response. Some need to **listen** for events — incoming messages, notifications, status changes. A listener is a long-lived subscription that produces events over time. For how listener events reach the agent, see [runtime.md#listener-event-routing](runtime.md#listener-event-routing).

## Capability types

Each capability is either an **action** (do something once) or a **listener** (subscribe to ongoing events):

```json
{
  "capability": "on_new_message",
  "type": "listener",
  "strategy": "fetch",
  "transport": "websocket",
  "endpoint": "wss://edge-chat.facebook.com/chat",
  "prerequisites": [{ "name": "extract_mqtt_creds", "method": "browser" }],
  "events": {
    "pattern": { "type": "new_message" },
    "delivers": ["sender_id", "text", "thread_id", "timestamp"]
  }
}
```

Listeners use the same strategy system as actions, plus a `transport` field that selects the connection mechanism:

| Transport | Connection mechanism |
| --- | --- |
| **websocket** | Daemon-side `ws` connection. Use when the WS URL + auth (bearer token, query-param userId) are reachable from outside the browser. |
| **fetch-stream** | Daemon-side `fetch()` with chunked-encoding response, parsed as SSE or NDJSON. Covers POST + JSON body + streaming token-delta response (the modern streaming-completion shape) and long-lived event-source endpoints (GET + SSE response). |
| **poll** | Daemon-side `fetch()` on an interval. Last resort for sites with no push channel — diffs against previous results. |
| **browser-event** | Long-lived Playwright page open on a logged-in feed/chat URL. The driver hooks `page.on('websocket')` and forwards every received frame into the listener event queue via SSE streaming from the container to the daemon. Use when the push channel is bound to browser context (cookies, sec-\* headers, fingerprint-bound endpoints, JS-set origin) — anywhere the WS URL is opened by page JS and isn't reachable from a Node-side client. |

The strategy tier (`fetch` / `page-script` / `recorded-path`) is still used for prerequisite resolution (e.g. browser-extracted tokens for websocket auth) but is largely cosmetic for `browser-event`, which always uses a browser session for its lifetime.

## Listener lifecycle

```
LLM: "tell me when adam messages"
  │
  ▼
klura runtime
  ├─ look up on_new_message capability for facebook
  ├─ run prerequisites (if fetch)
  ├─ open WebSocket / MQTT / SSE / browser page
  ├─ hold connection open
  │
  │   ◄── incoming event ──
  │
  ├─ match against filter (from: adam)
  ├─ enqueue / callback to LLM: { event: "new_message", data: {...} }
  │
  │   (connection stays open)
  │
  ├─ token expires → reactive reconnect (re-run prerequisites → reopen)
  └─ LLM: "stop listening" → close connection
```

Token refresh runs both proactively and reactively. A per-listener watcher checks cached token TTLs every 30 s and triggers a prereq re-run + reconnect before expiry; if that misses (unknown TTL, prereq failure), the reactive path re-runs prereqs when the connection drops with an auth error. Both flows share the same reconnect machinery. Full mechanics: [tokens.md#listener-token-refresh](tokens.md#listener-token-refresh).

`browser-event` listeners participate in the [pool's ready-page checkout protocol](pool.md#ready-page-checkout-protocol) — once the listener has the page + WS open, it calls `pool.registerSharedSession(session, platform)` and other callers can borrow the same session for a fast warm execute instead of cold-spawning.

## Discovery of listeners

Listeners are discovered during exploration, same as actions. When klura explores a chat app, it notices WebSocket connections being opened and messages flowing through them. The LLM correlates: "this WebSocket on `/chat` receives JSON with `type: 'new_message'` — that's a listener capability."

If no WebSocket / SSE is found, klura falls back to **poll-based listening**: periodically run the `list_messages` action and diff against previous results. Slower, but works on any platform.
