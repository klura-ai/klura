# Identities, secrets, device profile

Per-user data that's distinct from the portable skill body. None of this ships with a skill when it's published; all of it is local to a daemon.

## Identities

`~/.klura/identities.json`: per-platform non-secret PII. Merged into `execute()` args at runtime with lower priority than explicit args.

```json
{
  "facebook": { "email": "alice@example.com", "username": "alice" },
  "github": { "email": "alice@example.com", "username": "alice-dev" }
}
```

When a strategy interpolates `{{email}}` or `{{username}}`, the resolution order is:

1. Explicit `args` from the `execute()` call
2. `identities.json[platform]` fields (or `identities.json[<platform>--<identity>]` when a named identity is in scope — see Multi-account below)
3. `{{secret:scheme:ref}}` shell-command resolver
4. Unresolved — left as `{{placeholder}}` (caller must provide it explicitly)

## Multi-account (named identities)

When the user has multiple accounts on the same platform — work + personal on a chat app, multiple orgs on a code-hosting site — pass `identity: "<name>"` to `start_session` or `execute`. The runtime scopes three layers by `(platform, identity)`:

| Layer | Default identity | Named identity |
| --- | --- | --- |
| Cookies | `~/.klura/storage-state/<platform>.json` | `~/.klura/storage-state/<platform>--<identity>.json` |
| Profile | `identities[<platform>]` | `identities[<platform>--<identity>]` (falls back to platform-default with a one-shot stderr warning) |
| Pool warm-slot | `<platform>::default` | `<platform>::<identity>` (no cookie bleed across accounts) |

**Opt-in.** Sessions that don't pass `identity` use the historical platform-only paths — single-account use sees zero change. The literal string `"default"` is the resolved identity when omitted; passing it explicitly is equivalent to omitting.

```text
start_session("https://www.example.com", { platform: "<platform>", identity: "work" })
start_session("https://www.example.com", { platform: "<platform>", identity: "personal" })

execute("<platform>", "send_message", { to: "boss", text: "hi" }, { identity: "work" })
execute("<platform>", "send_message", { to: "brother", text: "yo" }, { identity: "personal" })
```

**Profile fields under named identities** are hand-edited in `identities.json`:

```json
{
  "<platform>": { "email": "user@example.com" },
  "<platform>--work": { "email": "user@workdomain.com", "name": "Work Name" },
  "<platform>--personal": { "email": "user@personal.example", "name": "Personal Name" }
}
```

**Per-identity passwords** ride the existing secret resolver via convention — set the resolver's template up so refs of the form `<scheme>.<identity>` (e.g. `<platform>.work`, `<platform>.personal`) look up the right credential. No runtime change; the agent constructs the ref string when calling `get_secret`.

**Out of scope (deferred):** CLI subcommands for managing identity jars, write API for scoped profile slots, listener identity scoping, save-time probe identity scoping. See klura://reference#identities §"Out of scope".

## Secret resolvers

`~/.klura/config.json`'s `secrets` section: shell-command templates. `{{secret:scheme:ref}}` placeholders resolve via `execSync` at execution time. Errors use `[REDACTED]` — the ref and output never appear in error messages.

```json
{
  "secrets": {
    "op": "op read 'op://Personal/{ref}/password'",
    "bw": "bw get password '{ref}'",
    "env": "echo \"$KLURA_SECRET_{ref}\""
  }
}
```

A strategy referencing `{{secret:op:facebook}}` runs the `op` template with `{ref}` replaced by `facebook` and uses the stdout as the value. The password never enters the LLM's context.

---

## Device profile

**Each klura daemon is one device.** The daemon's profile is stored at `{KLURA_HOME}/device.json` — a single `DeviceProfile` object with `viewport`, `userAgent`, `hasTouch`, `isMobile`, `deviceScaleFactor`, and an optional human-readable `name`. Every session the daemon creates inherits this profile; there is no per-session or per-call device selection, no registry of named devices, no per-platform override map, no fallback chain.

If `device.json` is missing or malformed, the daemon falls back to the `desktop` preset (1280×720, native UA, touch input enabled). Built-in presets — `desktop`, `desktop-strict`, `iphone-15`, `pixel-8` — are exposed via `klura device set --preset <name>` as templates that write a fresh `device.json`.

### When to use which preset

- **`desktop` (default)** — almost always right. Desktop-viewport page rendering with touch input also accepted, so a human connecting via the remote viewer from either a mouse or a touch device can interact with the same already-rendered page. This is the "Windows Surface / touch-Chromebook / iPad-with-trackpad" class of real device; sites in the wild handle it correctly.
- **`desktop-strict`** — desktop viewport, `hasTouch: false`. Use only when you're testing a site that serves materially different content to touch-capable UAs and you need strict hover-only emulation. Rare.
- **`iphone-15` / `pixel-8`** — when this daemon should impersonate a specific mobile device (mobile-only site flow, tablet-only UI, dedicated mobile skill library). Run a second daemon with its own `KLURA_HOME` for this; don't flip the profile on the daemon you're using for desktop work.
- **Custom via `klura device probe`** — when you want to match a specific device beyond the stock presets. Run the probe on the target phone/tablet/laptop and the profile is captured verbatim.

Storage state is therefore scoped per-daemon: `{KLURA_HOME}/storage-state/{platform}.json`. No `__device` suffix in the filename, no load-time fallback chain. Cookies for Facebook on this daemon are _this daemon's_ Facebook cookies, end of story.

**Multi-device setups run multiple daemons.** Each daemon gets its own `KLURA_HOME`, its own Unix socket, its own signing secret, its own cookie jars, its own skill library. A shell alias or a second MCP server entry in the agent's config is the UX for picking between them:

```bash
alias klura-work='KLURA_HOME=~/.klura-work klura'
alias klura-personal='KLURA_HOME=~/.klura-personal klura'
```

Or in an MCP client config:

```json
{
  "mcpServers": {
    "klura-desktop": { "command": "klura-mcp" },
    "klura-mobile": { "command": "klura-mcp", "env": { "KLURA_HOME": "/home/alice/.klura-mobile" } }
  }
}
```

The LLM then sees `klura-desktop.*` and `klura-mobile.*` as two independent tool namespaces and picks between them based on the content of the user's message — it does not select a device per call inside one namespace.

**Device probe**: `klura device probe` spins up a tunneled HTML page; the user opens the URL on the device they want the daemon to emulate (a phone, a tablet, another laptop), the page reads `navigator.userAgent`, `screen.width/height`, `devicePixelRatio`, `maxTouchPoints` via JS, POSTs back, and the captured profile is written directly to `device.json`. One-shot setup, no manual spec required.

**Rationale**: the device profile's primary job is input-modality parity during remote-viewer handoff. When the agent is running alone the profile barely matters — any working browser is fine, and strategies are keyed by `{platform, capability}` not by device, so skills remain portable. When a human connects via the remote viewer to take over a blocker, the page was already laid out under the daemon's profile; if the human's device is fundamentally different (hover-only client on a touch-laid mobile page, or vice versa), hover menus may be invisible or tap targets too small. The default `desktop` preset sidesteps this for the common case by accepting touch input while reporting desktop dimensions and hover capability — so both mouse and touch clients can interact with the same already-rendered page without a context reload.

The secondary rationale is that the daemon is the unit of device identity: technical profile (viewport / UA / touch) and cookie-jar identity live together in one place, and there is no per-call `device` override to accidentally land a session on the wrong cookie file. This matches how the MCP spec and most major agent frameworks (Claude Code, Claude Desktop, Cursor, OpenClaw) scope their tool configurations.

Fingerprint/stealth parity (the automated browser looking like a real browser to the site's client-side JS) is a side effect, not the main point.

### What's NOT addressed by the compat default: viewport-layout parity

Input modality (mouse vs. touch) is handled by the default preset; viewport-layout parity is not. A phone client connecting to a daemon running in `desktop` (1280×720) sees the remote frame scaled-to-fit: CSS-wise, the page was laid out for a 1280px viewport, so tap targets stay desktop-dense and the user pinch-zooms to interact. Auto-resizing the viewport to match the client on viewer-connect is technically possible (Playwright's `setViewportSize` is live-toggleable), but two problems make it unsafe as a default:

1. **Concurrent agent work gets surprised.** A strategy that was poised to click a nav-bar item may find a hamburger icon in its place after a mid-flight resize — role/text-based locators survive CSS reflow, but an element hidden inside a collapsed menu is unreachable until the menu opens.
2. **JS-driven layout decisions don't re-run.** A site that picks its layout once at DOMContentLoaded (via `window.matchMedia` checks, not CSS media queries) stays in the pre-resize mode even after the viewport changes. CSS responsiveness works; JS responsiveness doesn't.

If you need viewport-layout parity during human handoff — i.e. you actually want the page to re-render for your phone — the answer today is a second daemon in `iphone-15` (or similar) profile and a separate `KLURA_HOME`. The multi-daemon setup above is the supported path for dedicated mobile work.
