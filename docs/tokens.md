# Token lifecycle

Klura manages several kinds of tokens, each with different lifetimes and refresh mechanisms. Token handling sits between [strategies.md](strategies.md) (which describes how prerequisites extract tokens at execute time) and [health.md](health.md) (which describes how repeated auth failures degrade a strategy's health).

| Token type | Lifetime | Refresh method | Cost of expiry |
| --- | --- | --- | --- |
| CSRF token (e.g. `fb_dtsg`) | ~30 min (per page load) | Browser prerequisite: load page, extract from HTML | Cheap — quick page load |
| OAuth access token | 1–4 hours | Refresh token exchange (no user interaction) | Cheap — HTTP call |
| OAuth refresh token | Days–months | Full re-login (user interaction required) | Expensive — user involved |
| Session cookie | Hours–days | Full re-login | Expensive — user involved |
| WebSocket auth token | Varies | Depends on platform | Medium — reconnect needed |

## Proactive vs reactive refresh

**Reactive** (the original behavior): wait for 401 → invalidate → retry. Simple but causes a failed request + latency spike on every expiry.

**Proactive** (preferred): refresh _before_ expiry based on known TTL. Klura tracks when each token was obtained and its estimated TTL:

```
Token cached at t=0, estimated TTL=1800s (30 min)
  │
  t=1500s (TTL - 5min buffer)
  ├─ proactive refresh: re-run prerequisite in background
  ├─ new token ready before old one expires
  └─ next request uses fresh token seamlessly
```

The refresh buffer is configurable (default: 10% of TTL or 60 seconds, whichever is larger). This avoids the 401-retry-retry dance entirely for tokens with predictable TTLs. The proactive logic lives in `runtime/src/tokens.ts`'s `needsRefresh()`.

## TTL learning

Klura doesn't know a token's TTL in advance. It learns through observation:

```
1. Extract fb_dtsg, use it
2. After 28 minutes → 401
3. Record: this token lasted ~28 minutes
4. Next time: set TTL estimate to 25 minutes (conservative)
5. Over multiple observations: TTL converges to actual value
```

The TTL estimate is stored on the prerequisite (platform-learned, portable). On disk:

```json
{
  "name": "extract_fb_dtsg",
  "method": "browser",
  "selector": "input[name='fb_dtsg']",
  "extract": "value",
  "ttl": 1500,
  "ttl_observations": [1680, 1720, 1500, 1800],
  "ttl_strategy": "min_observed"
}
```

(The TypeScript field names in `runtime/src/tokens.ts` are camelCase — `observations`, `ttlStrategy` — but the on-disk JSON uses snake_case as shown.)

`ttl_strategy` can be:

- `min_observed` — use the shortest observed lifetime (safest, default)
- `p90` — use the 90th percentile (good for tokens with variable TTLs)
- `fixed` — hardcoded TTL (for tokens with known expiry, e.g. OAuth `expires_in`)

## OAuth refresh tokens

For platforms using OAuth (the identity-provider, real Google / GitHub / etc.), the refresh flow is:

```
access_token expires (or approaching TTL)
  │
  ├─ has refresh_token?
  │   ├─ yes → POST /token { grant_type: refresh_token, refresh_token: "..." }
  │   │   ├─ success → new access_token (+ maybe new refresh_token)
  │   │   └─ failure (refresh_token also expired) → full re-login
  │   │
  │   └─ no → full re-login
  │
  └─ full re-login:
      ├─ credential resolution (password manager / remote_session / ask user)
      └─ new tokens obtained → cache
```

Refresh tokens are user-specific; they live alongside cookies in `~/.klura/storage-state/<platform>.json` rather than in the platform-portable skill body.

## Session cookies

Chrome browser contexts maintain their own cookie jars. When cookies expire:

1. Klura detects it (redirect to login page during execution, or explicit 401)
2. This is a **significant blocker** — triggers the full credential resolution flow (see [remote.md](remote.md))
3. After re-login, new cookies are stored in the browser context automatically

Cookie persistence across restarts: browser storage state (cookies, localStorage) is saved to `~/.klura/storage-state/<platform>.json`. In local mode it's saved on `close_session`; in daemon mode, it's saved on shutdown and periodically.

## Listener token refresh

Listeners hold long-lived connections (WebSocket, MQTT, SSE, `browser-event`) that may use tokens with limited lifetimes. `ListenerManager` runs a per-listener watcher (`LISTENER_TOKEN_CHECK_INTERVAL_MS = 30_000`) that every 30 seconds:

1. Enumerates the `{{template}}` names used by this listener's `endpoint` and `auth.value`.
2. For each name, calls `tokenCache.needsRefresh(platform, name)`. If none are stale, the tick is a no-op.
3. Otherwise, re-runs the listener strategy's prerequisites via the injected prereq runner. This populates the cache with fresh values.
4. Resets `reconnectAttempts = 0` (so the preemptive refresh bypasses the reactive backoff) and triggers the existing reconnect machinery. The next connection uses the fresh tokens.

An `refreshInFlight` guard prevents two concurrent ticks from both launching a refresh. If the prereq run fails, the watcher leaves the listener running — the reactive 401 path remains the safety net when the actual expiry arrives.

The watcher is best-effort: it only starts when both `setTokenCache` and `setPrereqRunner` have been injected (both are wired at daemon startup) AND the listener's strategy references at least one `{{template}}` name. Listeners with no templated auth (static bearer tokens, cookies handled by browser context) skip the watcher entirely.

## Reactive retry (fallback)

For non-listener execution, when proactive refresh fails or the TTL estimate is wrong, the reactive retry loop kicks in:

```
execute(cached tokens) → 401
  │
  ├─ invalidate prerequisite cache
  ├─ re-run prerequisites (borrow Chrome context, extract fresh tokens)
  ├─ retry execute(fresh tokens)
  │
  ├─ success? → done, adjust TTL estimate (it was shorter than expected)
  │
  ├─ still failing? → fall back to recorded-path
  │     └─ recorded-path also fails? → callback to LLM
  │
  └─ max 2 retries before escalation
```
