# Remote viewer and credential resolution

The remote viewer is one of several possible resolution targets for the interruption framework (see [interruptions.md](interruptions.md)). It opens a tunneled, live view of the daemon's browser so the user can complete whatever the runtime can't — CAPTCHAs, logins, 2FA, QR scans, ToS click-throughs — without the site ever seeing an IP that differs from the daemon's.

## When the viewer fires

The viewer is the `target: 'viewer'` branch of an `InterruptionResolution`. The runtime defaults register `default-handover-viewer` for the blocker-class kinds (`recorded_step_failed`, `captcha_challenge`, `2fa_challenge`, `session_expired`, `auth_wall_encountered`). Enterprise / test plugins can pre-empt at lower priority numbers — see the priority table in [interruptions.md](interruptions.md).

`start_remote_session(sessionId, prompt)` is the direct tool surface the agent calls when it chooses to hand off without waiting for a runtime-emitted event. Under the hood it mints the same handover resolution the interruption framework emits; `wait_for_remote(sessionId, timeout?)` blocks until the operator clicks Done; `stop_remote_session(sessionId)` closes the viewer. Use the tools instead of bash polling — they subscribe to the viewer's lifecycle events rather than polling on a timer.

## Credential resolution

Auth walls fire an `auth_wall_encountered` interruption (see [interruptions.md](interruptions.md) kind reference). Two standard resolution shapes:

- **Credential-cache handler** — a plugin reads `identities.json` + secret resolvers, emits `{status: 'resolved', patch: {credentials}}`, and execution continues without human intervention. This is the preferred path for any flow where the user has already configured their password manager.
- **Viewer handover** — no plugin could resolve, the default handler opens the viewer, the user signs in manually.

Credentials themselves are handled through two mechanisms:

**Identities** (`~/.klura/identities.json`): Non-secret per-platform PII (email, username). Set once, auto-filled into `{{email}}`, `{{username}}` placeholders during execution. The LLM never needs to re-ask. See [identities-and-device.md](identities-and-device.md).

**Secret resolvers** (`~/.klura/config.json` `secrets` section): Shell-command templates that resolve `{{secret:scheme:ref}}` placeholders at execution time. The password never enters the LLM's context. Users configure resolvers for their password manager CLI (`op`, `bw`, `pass`, `security`, etc.).

**Resolution order** for each `{{placeholder}}` in a strategy:

1. Explicit `args` from `execute()` call
2. `identities.json[platform]` fields
3. `{{secret:scheme:ref}}` shell-command resolver
4. Unresolved — left as `{{placeholder}}`

**When `execute` returns `needs_reauth`**: cookies are stale, not the strategy. Reauth priority:

1. Credential-cache interruption handler (resolved inline, no viewer)
2. `execute(platform, 'login')` if a login capability + secret resolver exist
3. Viewer handover (safest for the rare manual case — password never in LLM context)
4. User pastes credentials in chat (last resort)

Login flows are saved as capabilities with `{{email}}`, `{{password}}` placeholders, enabling automated reauth.

## Remote session lifecycle

A remote session is the tunneled, interactive view of the daemon's browser. Lifecycle:

1. **Open.** An interruption handler returns `{status: 'handover', target: 'viewer', prompt}`, or the agent calls `start_remote_session(sessionId, prompt)` directly. The runtime spins up the viewer backend (see below), registers a one-shot "done" listener, and attaches a `viewer_url` to the caller's response.
2. **Operator connects.** The user opens the URL on any device. The daemon's browser is already driving the target site — the operator sees real cursor, real pixels, and the prompt overlaid at the top of the viewer.
3. **Operator signals done.** Clicking Done fires a lifecycle event the runtime is subscribed to; `wait_for_remote` returns.
4. **Runtime resumes.** The LLM continues automating via the daemon's API while the viewer-side session lingers until `stop_remote_session` is called or the session closes.

The target site sees the daemon's browser throughout — no IP mismatch, no fingerprint rotation. Both paths (LLM via daemon API, human via viewer) can be active simultaneously; they're independent mutations of the same underlying browser.

The viewer is `runtime/src/remote/viewer.ts` — a CDP screencast piped to mobile-friendly JPEG-over-WebSocket clients. It works with or without `pool.headful`; the flag only decides whether a local Chromium window also appears on the host. Cloudflared tunnels the viewer to the internet when `tunnel.mode: 'cloudflared'`.

### Multi-tab / popups

When a session has tracked sub-pages (popups, `target=_blank` tabs, OAuth consent windows — see [popups.md](popups.md)), the viewer renders a tab strip across the top of the canvas with one button per page (`main` plus each `popup-N`). Clicking a tab sends a `switch_page` control message; the server changes which page the screencast streams from and rebinds the focus listener so the mobile-keyboard shadow input follows. Closed popups stay in the strip with strikethrough styling so the operator can see the popup id never reuses. Single-page sessions don't show the strip at all — the layout is identical to the historical viewer.

Touch dispatch (mobile-emulated sessions) currently routes through a session-scoped CDP client that targets the main page only; when the active tab is a popup the viewer falls back to mouse events so the click still lands.

## Autonomous runs without a human

Viewer behavior is plugin-orchestrated. There's no flag to skip the viewer — instead, the harness registers higher-priority interruption handlers that return `{status: 'resolved', ...}` synthetic answers (captcha → `APPLE`, 2FA → skip) or `{status: 'continue'}` so the runtime never reaches the default handover-to-viewer path. The runtime core is unaware of whether a human is present; it just dispatches events through the interruption + checkpoint registries. See [interruptions.md](interruptions.md) for the plugin pattern.
