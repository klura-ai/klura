# Context via skill body

A cross-cutting convention: **structural context about a saved skill lives on the saved skill itself**, not in runtime state or a per-call return-value bag.

Every klura skill is a JSON file on disk. That file is the unit the next session's agent loads (`list_platform_skills` inlines a per-skill digest; `get_strategy` loads the whole thing). When the runtime wants to communicate something _about_ the skill — "the agent noticed a companion capability during discovery but didn't lift it", "the agent stalled at iteration N with diff shape D", "the runtime flagged this saved strategy as reading a session-scoped id" — it writes that signal into the skill body (typically under `notes.*`) so the next agent inherits it automatically, via the same `list_platform_skills` / `get_strategy` call it makes anyway.

The alternative would be: return the signal from the `save_strategy` / `execute` tool call, have the current session's agent remember it, have something plumbing it forward into the next session. That's lossy (agents churn; conversations end; retries drop context) and it couples the _delivery_ mechanism to the session lifecycle. On-disk decouples: the signal is as durable as the skill, and it travels wherever the skill travels (export, share, publish).

## Current `notes.*` slots

- **`notes.save_warnings[]`** — runtime-emitted advisories attached at save time when a structural pattern is worth flagging (validation already passed). Currently the only emitted kind is `unparametrized_session_id` — fired when an expression body reads a session-scoped id from `window.location.*` / `document.cookie` / similar without a lookup companion. The next agent reading the skill knows the saved strategy works for the discovery-session's entity only and needs parametrization before warm runs scale.

Sibling-capability pointers ("I observed another capability but didn't lift it") live on the **platform logbook** (`working/logbook.json` → `observed_capabilities[]`), written via the `record_observed_capability` MCP tool. That observation is a platform-level signal, not a property of any one saved strategy — keeping it on the logbook avoids the asymmetry of pinning a platform-wide fact to one capability's notes.

## Rules when adding a new signal here

1. Prefer the skill body (or the platform logbook) over the return-value path. If a signal is purely in-the-moment (no next-session value), it belongs in the `save_strategy` / `execute` response, not on disk.
2. Signal entries must be structured (JSON objects with enumerated `kind` values), not free-text blobs. Free-text rots into cover-story justifications and next agents learn to ignore it. The save-time validator enforces this on every `notes.*` key.
3. Producers don't mix on the same key — add a new key if a new producer needs an outlet. Currently `notes.save_warnings[]` is runtime-only.
4. Validate the key in `NOTES_ALLOWED_KEYS` (`runtime/src/strategies/validate.ts`) and document it in `runtime/REFERENCE.md` before emitting it. Every allowed key has a documented schema and a documented producer.
