# Session pool

Where the browser driver abstraction is about _how_ we talk to a browser ([drivers.md](drivers.md)), the pool is about _which_ browser sessions are alive right now, who owns them, and whether an `execute()` call can reuse one instead of paying for a cold spawn. The pool (`runtime/src/pool/pool.ts`) implements the `BrowserPool` interface (`runtime/src/drivers/interface.ts`); callers depend on the interface, never the concrete class.

## Warm sessions

A "warm" slot is a per-`(platform, identity)` stash whose Chromium context survives `closeSession` and gets checked out again on the next `createSession({platform: X})` for the same platform. Enabled via `pool.warm.enabled: true`. Every `execute()` call site passes `platform` through `SessionOptions` so the warm-slot lookup at `pool.ts` fires; without that, warm reuse silently no-ops.

**What the slot holds is a `BrowserLease`, never a `Session`.** At release, the pool calls `driver.detachLease(session)` — the driver bundles its private per-session state (BrowserContext, page map, capture plumbing) behind an opaque handle and the Session object dies. At checkout, the pool mints a **fresh** Session (blank logical state, fresh `origin`/`startedAt`), calls `driver.attachLease(newSession, lease)`, then `driver.resetSession`. Because no Session object ever crosses the stash, no logical field — phase bookkeeping, consent acks, action history, save records, byte counters — can leak from one klura session into the next; the guarantee is structural, not a field-by-field reset list. Drivers whose `detachLease` returns `null` (the abstract-class default, i.e. BYO drivers without lease support) get destroy-on-close instead of stashing.

**Device-fingerprint gate.** The slot remembers the device profile (UA, viewport, touch, mobile emulation) its context was created with — all context-creation-time settings a reset cannot change. A checkout requesting a different profile evicts the lease (`destroyLease`) and cold-spawns, so a desktop-warmed context never serves a mobile-emulated request and the session never self-describes as a device it is not. `deviceScaleFactor` is deliberately excluded from the fingerprint: it only affects rendering density, and not every checkout path threads it.

Side-effect-oriented capability and tag prereqs (e.g. an auth-providing capability — saved with `provides: ["auth"]` and chained via `{kind: "tag", tag: "auth"}` or by-slug — that leaves an auth cookie) also require warm-pool mode. Cookie propagation between the sub-execute and the caller relies on sharing the same `BrowserContext`; cold-pool creates a fresh context per execute and the cookies don't carry across. See `klura://reference#tag-prereq` and `klura://reference#capability-prereq` §"Requires warm-pool mode".

With warm enabled, Chromium reuse saves the process spin-up (~300–500 ms), but `driver.resetSession` (`runtime/src/drivers/playwright.ts`) navigates the reused page to `about:blank` — wiping the DOM and tearing any persistent WebSocket connection. That's load-bearing for isolation (the next session must not see the previous one's interceptor state or DOM), but it means the expensive part for single-page-app workloads (page navigation + JS bundle execution + WebSocket handshake) is still paid on every call. For a site like a realtime chat app where the MQTT send itself is ~10 ms, the ~2 s navigate-and-open-WS tax dominates the end-to-end execute time.

## Fresh verification contexts

`SessionOptions.freshContext:true` is the pool-level isolation primitive for runtime-owned verification. `Pool.createSession` skips warm checkout and calls `driver.createSession`, whose contract creates a new browser context. The session is not registered as a warm slot, so `endDrive` destroys that context even when warm pooling is enabled.

The post-save verifier adds a stricter facade around this primitive: ready-page checkout and the shared js-eval cache are absent, and any storage-state option assembled by the ordinary executor is removed before session creation. A browser candidate therefore starts anonymous on a new context and sees only navigation and state established by its declared browser prerequisites. The discovery page, its DOM, transient cookies/local storage, and idle warm contexts remain outside the verifier's execution graph. This is an internal correctness boundary, not a user setting; ordinary execution keeps its configured warm behavior.

`withFreshVerificationPool(base, fn)` scopes that facade to one verification run and guarantees teardown in `finally`, so there is no separate disposer for a caller to forget. Contexts are keyed by `(platform, identity)` — the same key shape as the warm pool — so a prerequisite's side effect persists across the steps that depend on it while a cross-platform prerequisite or a second identity gets its own context and its own cookie jar. Within the run, `endDrive` is a no-op for run-owned sessions: the run owns their lifetime, not the individual executor whose `finally` calls it. Disposal closes each context once, sequentially, isolating exceptions so one wedged context cannot strand the others, and is idempotent.

## Ready-page checkout protocol

The extension that unlocks sub-200 ms warm executes: when some _other_ caller already has a long-lived session parked on the right page with the right connections live, `execute()` borrows it instead of cold-spawning. Two callers qualify today:

1. **A prior execute()** whose page never got `resetSession`'d because the borrower marked it `borrowed: true` and `closeSession` put it back without the reset — "pending reuse" state.
2. **A `browser-event` listener** (`runtime/src/listeners/index.ts`) whose session holds a page + WebSocket open for the listener's lifetime (minutes to hours). After the listener opens its stream, it calls `pool.registerSharedSession(session, platform)` to expose itself to the checkout protocol.

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
- **WebSocket (`executeWebSocket`)** — `probePageReady(session, baseUrl, wsUrlPrefix)` returning `page_on_url: true AND ws_open: true`. Live sockets are enumerated over CDP (`Runtime.queryObjects` on `WebSocket.prototype`, no page-side registry) and checked for an OPEN one matching `wsUrlPrefix`. If the site's WebSocket ever disconnected (server-side timeout, page crash, navigation), the probe returns false and the caller cold-spawns.
- **Recorded-path** opts out entirely. Step replay depends on a fresh DOM — no leftover dialogs, scroll offsets, hover state.

**Borrow and release.** A borrowed session has `Session.borrowed = true` set. The warm-slot borrow mints a fresh Session and binds the slot's lease onto it before the probe runs — **no resetSession call**, so the page URL and any live WebSocket survive verbatim; a failed probe detaches the lease straight back into the slot. `pool.closeSession` on a borrowed session does NOT tear it down:

- If the pool owns the slot (warm-pool reuse), `closeSession` detaches the lease back into the slot and the borrow-generation Session dies — the next borrower gets a fresh one.
- If a listener owns the slot (via `registerSharedSession`), `closeSession` is a no-op for the underlying session; the listener still owns lifetime. The `Session` object is removed from `_sessions` but not destroyed. Listener-shared sessions are the one deliberate exception to fresh-Session minting: the owner holds live references, so the protocol shares the object itself.

Cold-spawned sessions (checkout returned null → `createSession`) follow today's behavior: `closeSession` either returns to warm (with `resetSession`) or tears down the Chromium context.

**Failure-mode coverage.** The probe is the only thing a caller has to reason about — every failure surfaces as `false`:

- Page crashed / context closed → playwright throws reading `page.url()` → probe returns `page_on_url: false`.
- WebSocket dropped mid-idle → `ws_open: false`.
- Page navigated away unexpectedly (user clicked a link in a listener session, say) → `page_on_url: false`.
- Cookie session expired → not the probe's job today; the execute call fails on the underlying auth error and classifies normally.

## Session scope — the single teardown path

Per-session state does not live only on the `Session` object: checkpoints, interruptions, paused recorded-path executions, auto-execute aliases, WS-starter caches, session observations, logbook dedupe sets, capture journals, and remote viewers all hold session-keyed entries in their own modules. The **session scope** (`runtime/src/pool/session-scope.ts`) is the single owner of tearing that state down:

- **Write-site registration.** The module that writes session-keyed state registers a named disposer at the moment of the write (`onSessionDispose(sessionId, name, hook)` — idempotent per name). No close path maintains a list of "things to clear"; the list assembles itself from the writes that actually happened.
- **One disposal point.** `Pool.endDrive` calls `disposeSessionScope(id)` on every branch where the session id dies: cold destroy, warm lease release, borrowed-warm release, borrowed-shared owner-gone. Clean close (`end_drive`), abort (`abort_session`), pool eviction, `pool.shutdown()`, and every error-path `finally` all converge on `pool.endDrive`, so they share the disposal for free. The **borrowed-shared keep-alive** branch (owner listener still holds the registration; the id stays valid) deliberately does not dispose.
- **Child topology.** A recorded-path pause that outlives its executor registers the inner (auto-execute) session as a child of the outer session via `adoptChildSession(outerId, innerId, closer)`. Disposing the parent runs child closers first — closing the outer session can never leak a paused inner browser context, its `pausedExecutions` entry, or the outer→inner alias.
- **Dispose semantics.** Idempotent, reentrancy-guarded (a child closer re-enters via `pool.endDrive`), LIFO over the session's own hooks, and exception-isolated: one failing hook never skips the rest; failures are aggregated and reported.

## Idle hibernation

The pool hibernates the shared browser (`driver.closeBrowser`) after `pool.idleTimeout` seconds without activity. The timer is **edge-armed, never polled**: every public entry point re-arms a `setTimeout` via `_touch()`, and the warm sweeper re-arms it when a TTL eviction may have just made the pool non-busy. When the timer fires while the pool is still busy it simply does not re-arm — the next lifecycle edge does.

"Busy" is one predicate, `Pool.busy()`: live sessions OR live warm slots. Warm entries count as in-use from the browser's perspective — hibernating the shared browser would kill the very contexts the warm pool exists to keep. Any layer deciding whether klura is idle enough to tear browser state down must consult `busy()` rather than re-deriving its own predicate — the daemon's `runtime.idleTimeout` shutdown does exactly this, so a live warm pool keeps the daemon process alive even with zero active sessions. The interface member (`BrowserPool.busy`, `runtime/src/drivers/types/session.ts`) is optional only for facades and test stubs that own no browser state beyond their delegated sessions; callers treat absence as `activeSessions > 0`.

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

Execution diagnostics that must survive session release use the executor's scoped evidence collector rather than pool state. When explicitly enabled by an embedding, it snapshots the driver's compact request ledger and passive external-script ledger before release and returns exact absolute URLs in one transport-neutral envelope. A driver read failure is ignored so diagnostics never alter the execution result or exception.

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
- **`@klura/driver-playwright-stealth`** (separate package) — install with `npm i @klura/driver-playwright-stealth` and set `pool.driver` to the package name. Same driver with `puppeteer-extra-plugin-stealth` applied at launch.
- **BYO absolute path** — `pool.driver: "/Users/x/my-driver.js"`. The runtime `require()`s the file and instantiates the exported class (must extend `BrowserDriver`). See `runtime/examples/custom-driver.js`.
- **BYO package** — `pool.driver: "my-klura-driver"`. Bare module name, resolved against `node_modules`.

```json
{ "pool": { "driver": "@klura/driver-playwright-stealth" } }
```

See [drivers.md](drivers.md) for the `BrowserDriver` interface and capability matrix.

## Locator alternatives

Recorded-path steps support an `alternatives` array of additional fallback locators. The runtime tries: primary a11y → primary css → alternatives[0].a11y → alternatives[0].css → etc. Use `patch_step` to add alternatives when a locator fails for some locales or viewports, without replacing the primaries.
