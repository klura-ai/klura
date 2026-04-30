# Interruptions — agent-detected menu-driven events

An **interruption** is a mid-flow event where the AGENT is the detector — it sees ambient page state in the a11y tree (a CAPTCHA iframe, a login form, a 2FA prompt) and asks the runtime "can any registered plugin resolve this?" Distinct from [checkpoints](checkpoints.md) (runtime-emitted, known `kind`, direct dispatch) and from the pre-commit [gate family](gates.md) (save/commit-time payload shape).

Because the agent is the detector, there is genuine semantic ambiguity about which handler fits: the page could be showing a captcha, an auth wall, a 2FA code, or a session-expired modal, and any of those could be served by a different plugin depending on deployment. Dispatch is **menu-driven**: the runtime exposes the full handler menu; the agent reads descriptions and picks one by name.

Runtime-emitted events with a known kind do NOT route through this framework — they arrive via [checkpoints](checkpoints.md) instead. The two surfaces stay separate by design; see [principles.md](principles.md) §Interruptions.

## Architecture

Every event is a free-form payload:

```ts
interface InterruptionEvent {
  session_id: string;
  capability?: string;
  context: Record<string, unknown>; // `context.reason` names the trigger in plain English
}
```

There is no closed `kind` enum here — scope is agent-emitted prose. Typical `context.reason` values: `"captcha_challenge"`, `"auth_wall_seen"`, `"login_form_visible"`, `"2fa_prompt_visible"`. Plus kind-specific extras (sitekey, iframe_src, platform slug, channel).

Dispatch is menu-driven (`runtime/src/interruptions/registry.ts`):

1. `listInterruptionHandlers()` — returns every registered handler as `{name, description}`.
2. `invokeInterruptionHandler(name, event, session)` — runs the named handler. Throws `invalid_strategy: unknown resolver …` if the name is unknown.

There is no auto-picker. The picking is an LLM-semantic-match question, not a runtime boolean. See [principles.md](principles.md) §delegate-to-LLM.

## What the LLM sees

Interruptions are agent-initiated — the agent proactively calls `list_interruption_resolvers()` to see the menu, or builds a context and calls `resolve_interruption` directly.

```
list_interruption_resolvers()
// → [{name, description}, ...]

resolve_interruption({
  session_id,
  context: { reason: "captcha_challenge", sitekey: "...", iframe_src: "..." },
  resolver: "<picked-name>"
})
// → { resolution: {status, ...}, interruption_token? }
```

The handler's return:

- `{status: 'resolved', value, patch}` — runtime folds the answer in; no envelope.
- `{status: 'continue', hint}` — runtime proceeds silently.
- `{status: 'handover', target, prompt, viewer_url?}` — runtime mints `interruption_token`; the agent's **next tool call must echo the token + an ack** (`user_response` / `viewer_result`) OR an explicit cancel (`{cancelled: true, reason}`). Without an echo, every subsequent tool call rejects with `invalid_strategy: pending_interruption …`.

Viewer spin-up lives in the plugin. When a handler returns `{status: 'handover', target: 'viewer'}` it is expected to have already opened the viewer and populated `viewer_url` (the injected `ViewerOpener` from `runtime-state.ts` is the shared path). The agent never calls `start_remote_session` separately — it reads `viewer_url` from the resolution.

## Registering a custom handler

```ts
interface InterruptionHandler {
  name: string; // stable id; same-name re-register overwrites
  description: string; // the ONLY signal the agent uses to route
  handle(event: InterruptionEvent, session: Session): Promise<InterruptionResolution>;
}
```

The description is load-bearing — name the triggering `context.reason` values the handler claims, the preconditions (stored creds, SDK enabled, platform slug), and any fallback behavior when preconditions aren't met.

### Captcha-solver plugin (enterprise)

```ts
registerInterruptionHandler({
  name: 'acme-captcha-solver',
  description:
    'CAPTCHA solver backed by Acme Solutions. Returns a solved token as `resolved`. Pick when event.context.reason is "captcha_challenge" AND event.context.sitekey is set. Falls back to viewer-handover if the service is offline.',
  async handle(event) {
    const token = await acmeSolver.solve(event.context.sitekey as string);
    return { status: 'resolved', value: { captcha_token: token } };
  },
});
```

### 2FA router (SMS)

```ts
registerInterruptionHandler({
  name: 'twilio-2fa',
  description:
    'Reads the latest SMS OTP via Twilio and returns it as resolved value. Pick when event.context.reason suggests a 2FA / OTP prompt AND event.context.channel === "sms".',
  async handle(event) {
    const code = await twilio.pollLatestSms(event.context.phone as string);
    return { status: 'resolved', value: { otp: code } };
  },
});
```

## Credential autofill (shipped plugin)

klura ships `runtime/src/plugins/credential-autofill/` — a plugin, not runtime core. Triggers on agent-detected auth-wall:

- Pick when `event.context.reason` is `"auth_wall_seen"` / `"login_form_visible"` AND `event.context.platform` is a slug with stored credentials.
- Returns `{status: 'resolved', value: {username, password, identity_fields}}`.
- Falls back to `{status: 'handover', target: 'viewer'}` when creds are absent, so picking it when creds aren't stored is safe — it degrades to the interactive path.

Stripping the file leaves a fully-functional runtime; every login falls through to a viewer spin-up via `start_remote_session`.

## Nags are NOT interruptions

Cookie-consent banners, newsletter popups, "accept cookies" overlays, and other dismissable UI noise are **not** interruptions — they are ambient UI state the agent dismisses during normal navigation. Routing them through this registry forces the user to remote-view just to close a banner.

Guardrails enforce this:

1. `list_interruption_resolvers`'s MCP description tells the agent to use the tool only when the agent spotted a genuine challenge (captcha / 2FA / auth wall) — explicitly NOT for banners and popups.
2. [principles.md](principles.md) §Interruptions codifies: **interruptions = agent-detected ambient challenge that needs a plugin; UI noise = agent dismisses during navigation.**

## Plugin config convention

Plugins own their configuration, not the runtime. Every plugin picks a namespaced slot under `config.plugins.<plugin-name>` in `~/.klura/config.json`. The runtime's config loader exposes `loadConfig().plugins?.[name]` verbatim; it never validates plugin-specific shapes.

Example:

```json
{
  "plugins": {
    "acme-captcha-solver": { "api_key_ref": "env:ACME_CAPTCHA_API_KEY" },
    "twilio-2fa": { "account_sid_ref": "env:TWILIO_SID" }
  }
}
```

## `context.reason` reference (agent-emitted)

| `context.reason` | Fires when | Extra `context` keys | Typical resolvers |
| --- | --- | --- | --- |
| `captcha_challenge` | Agent detected a captcha in the a11y tree | `sitekey?`, `provider?`, `iframe_src?` | Enterprise solver plugin; viewer handover |
| `auth_wall_seen` / `login_form_visible` | Agent detected a login form / auth wall | `platform`, `login_url?` | `credential-autofill`; viewer handover |
| `2fa_prompt_visible` | Agent detected a 2FA / OTP input | `channel`, `phone?`, `email?` | Enterprise OTP relay; viewer handover |

Runtime-emitted reasons (`triage_plan`, `surface_changed`, `recorded_step_failed`, `session_expired`, `post_save_validation_consent`) route through [checkpoints](checkpoints.md), not this surface.

## Related

- [checkpoints.md](checkpoints.md) — runtime-emitted known-kind events; direct dispatch.
- [gates.md](gates.md) — save/commit-time structural gates. Shared `buildTokenGate` factory.
- [principles.md](principles.md) §Interruptions + §Checkpoints — the "why" for the split.
