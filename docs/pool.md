# Session pool

Where the browser driver abstraction is about _how_ we talk to a browser ([drivers.md](drivers.md)), the pool is about _which_ browser sessions are alive right now, who owns them, and whether an `execute()` call can reuse one instead of paying for a cold spawn. The pool (`runtime/src/pool/pool.ts`) implements the `BrowserPool` interface (`runtime/src/drivers/interface.ts`); callers depend on the interface, never the concrete class.

## Warm sessions

A "warm" session is one whose Chromium process survives `closeSession` and gets checked out again on the next `createSession({platform: X})` for the same platform. Enabled via `pool.warm.enabled: true`. Every `execute()` call site passes `platform` through `SessionOptions` so the warm-slot lookup at `pool.ts` fires; without that, warm reuse silently no-ops.

Side-effect-oriented capability and tag prereqs (e.g. an auth-providing capability — saved with `provides: ["auth"]` and chained via `{kind: "tag", tag: "auth"}` or by-slug — that leaves an auth cookie) also require warm-pool mode. Cookie propagation between the sub-execute and the caller relies on sharing the same `BrowserContext`; cold-pool creates a fresh context per execute and the cookies don't carry across. See `klura://reference#tag-prereq` and `klura://reference#capability-prereq` §"Requires warm-pool mode".

With warm enabled, Chromium reuse saves the process spin-up (~300–500 ms), but `driver.resetSession` (`runtime/src/drivers/playwright.ts`) navigates the reused page to `about:blank` — wiping the DOM and tearing any persistent WebSocket connection. That's load-bearing for isolation (the next session must not see the previous one's interceptor state or DOM), but it means the expensive part for single-page-app workloads (page navigation + JS bundle execution + WebSocket handshake) is still paid on every call. For a site like a realtime chat app where the MQTT send itself is ~10 ms, the ~2 s navigate-and-open-WS tax dominates the end-to-end execute time.

## Ready-page checkout protocol

The extension that unlocks sub-200 ms warm executes: when some _other_ caller already has a long-lived session parked on the right page with the right connections live, `execute()` borrows it instead of cold-spawning. Two callers qualify today:

1. **A prior execute()** whose page never got `resetSession`'d because the borrower marked it `borrowed: true` and `closeSession` put it back without the reset — "pending reuse" state.
2. **A `browser-event` listener** (`runtime/src/listeners.ts`) whose session holds a page + WebSocket open for the listener's lifetime (minutes to hours). After the listener opens its stream, it calls `pool.registerSharedSession(session, platform)` to expose itself to the checkout protocol.

The protocol is one method on `BrowserPool`:

```ts
tryCheckoutReadySession(
  platform: string,
  probe: (session, driver) => Promise<boolean>,
): Promise<Session | null>
```

Semantics: iterate every session the pool knows about for this platform — warm slot first, then registered shared sessions in insertion order. For each, run the `probe`. First `true` → mark `Session.borrowed = true` and return. All `false`, probe throws, warm pool disabled, or no candidates → return `null` and the caller falls through to `pool.createSession`.

**The probe is the transport's definition of "ready."** It's pure, side-effect-free, and MUST NOT throw for ordinary "nope not ready" states — the protocol treats throws as false by design. Canonical probes, all composing `driver.probePageReady(session, urlPrefix, wsUrlPrefix?)`:

- **HTTP fetch / page-script** — `probePageReady(session, baseUrl)` returning `page_on_url: true`. Any page navigated to the origin has cookies seeded, sec-\* headers established, and any scripts the page serves have already run. Sufficient for both the prereq path and the in-page fetch.
- **WebSocket (`executeWebSocket`)** — `probePageReady(session, baseUrl, wsUrlPrefix)` returning `page_on_url: true AND ws_open: true`. The page-side registry (`__kluraWsRegistry`) is scanned for an OPEN socket matching `wsUrlPrefix`. If the site's WebSocket ever disconnected (server-side timeout, page crash, navigation), the probe returns false and the caller cold-spawns.
- **Recorded-path** opts out entirely. Step replay depends on a fresh DOM — no leftover dialogs, scroll offsets, hover state.

**Borrow and release.** A borrowed session has `Session.borrowed = true` set. `pool.closeSession` on a borrowed session does NOT tear it down:

- If the pool owns the slot (warm-pool reuse), `closeSession` flips `warm.inUse = false` and leaves the page verbatim for the next borrower — **no resetSession call**. The BrowserContext, the page URL, the live WebSocket all survive.
- If a listener owns the slot (via `registerSharedSession`), `closeSession` is a no-op for the underlying session; the listener still owns lifetime. The `Session` object is removed from `_sessions` but not destroyed.

Cold-spawned sessions (checkout returned null → `createSession`) follow today's behavior: `closeSession` either returns to warm (with `resetSession`) or tears down the Chromium context.

**Failure-mode coverage.** The probe is the only thing a caller has to reason about — every failure surfaces as `false`:

- Page crashed / context closed → playwright throws reading `page.url()` → probe returns `page_on_url: false`.
- WebSocket dropped mid-idle → `ws_open: false`.
- Page navigated away unexpectedly (user clicked a link in a listener session, say) → `page_on_url: false`.
- Cookie session expired → not the probe's job today; the execute call fails on the underlying auth error and classifies normally.

## Future pool work

The pool intentionally stays "at most one warm slot per platform" in this iteration. Every item below is pure pool-internal work — the `tryCheckoutReadySession(platform, probe)` contract is stable, so none of these changes touch execute paths, listeners, or drivers. `// FUTURE:` comments in `runtime/src/pool/pool.ts` call each item out at the fields they'll touch, so a future contributor sees the intent in place rather than having to re-derive it from this doc.

1. **N warm slots per platform, capability-pinned.** Replace `Map<platform, WarmEntry>` with `Map<platform, WarmEntry[]>`. Each slot remembers its page URL (or `(platform, capability)` pinning); the probe naturally picks the right one. New config `pool.warm.max_per_platform`, default 1 preserves today's behavior.
2. **Pre-warm a capability set at daemon startup.** Optional `pool.warm.prewarm: [{platform, capability}]`. Daemon opens those sessions on boot and navigates each to its `baseUrl`. First real execute lands in a fully-warm slot; no cold-spawn tax ever.
3. **Smarter eviction policies.** Today it's idle TTL + a stubbed LRU when `_warmMax` is breached. Add: active-usage heat map (hot platforms get bigger budgets), cross-platform fairness, hybrid time-and-count eviction.
4. **Introspection surface.** `pool.getWarmState()` returning `{platform, capability, lastUsedAt, pageUrl, wsOpen}[]` for operator diagnostics and deterministic benchmark assertions ("was this second execute actually warm?").
5. **Periodic liveness sweep.** Run `probePageReady` in the warm-sweeper against each warm slot and evict any where `ws_open` flipped false, the page navigated away unexpectedly, or the context crashed. Prevents the "slot looks warm but isn't ready" class of surprise.
6. **Global memory-pressure cap.** A `max_total_warm` ceiling across all platforms with an eviction strategy (LRU-first, largest-page-footprint-first) that kicks in when the process approaches a RAM budget. Today's only cap is per-platform.

## Config

The existing `~/.klura/config.json` schema carries everything needed. The ready-page checkout protocol has no new flags — it's purely opt-in by the participants (`pool.warm.enabled: true` exposes warm slots; a running listener exposes its session via `registerSharedSession`). If neither participant is active, every `tryCheckoutReadySession` returns `null` and execute paths cold-spawn exactly as before.

```jsonc
{
  "pool": {
    "warm": {
      "enabled": true, // default false — flip to opt in
      "max_contexts": 3, // per-platform cap today, future: total
      "idle_ttl_seconds": 600, // 10 min idle → sweeper evicts
    },
  },
}
```

No `KLURA_*` env-var bridge is provided; programmatic callers pass `{warm: {...}}` directly to `new Pool({...})` / `createPool({...})`.

## Diagnostics

Set `KLURA_VERBOSE=1` on the daemon process to surface `[pool]` trace lines for every checkout, release, reuse, and eviction:

- `[pool] ready-checkout warm session for platform=X` — warm slot passed the probe; no cold spawn paid.
- `[pool] ready-checkout shared session for platform=X` — listener's session was borrowed.
- `[pool] borrowed session sess_... released back to warm slot` — closeSession flipped warm idle without resetSession.
- `[pool] borrowed shared session sess_... released (owner still holds it)` — execute released, listener still owns.
- `[pool] warm-reused context for platform=X` — slower path: warm reuse via `resetSession` (about:blank nav), not the ready-page fast path.

For programmatic inspection (benchmarks, assertions), item 4 in the future-work list above (`pool.getWarmState()`) is the right next surface.

---

## Pool backend (user-facing)

Playwright runs in-process. Launches the user's real Chrome via `channel: 'chrome'` with `--headless=new` so TLS fingerprint + compositor rendering match a regular browsing session. Falls back to bundled chromium with a warning if Chrome isn't installed.

Overrides (all in `~/.klura/config.json`):

- `pool.channel: 'auto' | 'chrome' | 'chromium'` (default `auto`) — forces the channel. `chrome` requires Google Chrome installed; `chromium` uses Playwright's bundled binary.
- `pool.headful: boolean` (default `false`) — launches a visible browser window. Debug-only.

## Device profile

Each klura daemon has exactly one device profile. Stored at `{KLURA_HOME}/device.json`:

```json
{
  "name": "iPhone 15",
  "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ...",
  "viewport": { "width": 390, "height": 844 },
  "hasTouch": true,
  "isMobile": true,
  "deviceScaleFactor": 3
}
```

If missing, the daemon uses a desktop default (1280x720, no touch, native UA). CLI:

- `klura device show` — print the current profile.
- `klura device set [--preset desktop|iphone-15|pixel-8] [--viewport WxH] [--ua "..."] [--touch] [--mobile] [--scale N] [--name "label"]`.
- `klura device probe` — spin up a tunneled HTML page; the user opens it on the target device and the profile is captured from JS (`navigator.userAgent`, `screen.width/height`, `devicePixelRatio`, `maxTouchPoints`). Writes `device.json` on success.
- `klura device reset` — delete `device.json`, revert to desktop.

**One daemon = one device.** Multi-device setups run multiple daemons with different `KLURA_HOME`:

```bash
alias klura-work='KLURA_HOME=~/.klura-work klura'
alias klura-personal='KLURA_HOME=~/.klura-personal klura'
```

Storage state scoped per daemon: `{KLURA_HOME}/storage-state/{platform}.json`. Switch devices by switching `KLURA_HOME`, not by passing a per-call flag. Default to desktop; switch to mobile only when the target site is mobile-first and the desktop version is limited.

## Remote viewer tunnel

`remote.mode` in `~/.klura/config.json`:

- **`auto`** (default) — try cloudflared, fall back to `http://localhost:<port>` if the tunnel fails.
- **`cloudflared`** — force cloudflared; error out if the tunnel can't open.
- **`local`** — never tunnel; return the localhost URL. Use when the client is on the same machine.
- **`direct`** — set `remote.publicUrl` to a host the daemon is reachable on. The viewer URL is `<publicUrl>:<port>/?token=...`.

See also [remote.md](remote.md) for the viewer protocol.

## Drivers (user-facing)

`pool.driver` picks the browser driver:

- **`playwright`** (default) — plain Playwright, no stealth patches. Clean baseline.
- **`klura-driver-playwright-stealth`** (separate package) — install with `npm i klura-driver-playwright-stealth` and set `pool.driver` to the package name. Same driver with `puppeteer-extra-plugin-stealth` applied at launch.
- **BYO absolute path** — `pool.driver: "/Users/x/my-driver.js"`. The runtime `require()`s the file and instantiates the exported class (must extend `BrowserDriver`). See `runtime/examples/custom-driver.js`.
- **BYO package** — `pool.driver: "my-klura-driver"`. Bare module name, resolved against `node_modules`.

```json
{ "pool": { "driver": "klura-driver-playwright-stealth" } }
```

See [drivers.md](drivers.md) for the `BrowserDriver` interface and capability matrix.

## Locator alternatives

Recorded-path steps support an `alternatives` array of additional fallback locators. The runtime tries: primary a11y → primary css → alternatives[0].a11y → alternatives[0].css → etc. Use `patch_step` to add alternatives when a locator fails for some locales or viewports, without replacing the primaries.
