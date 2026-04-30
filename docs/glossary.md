# Glossary

Three load-bearing terms. Strategy and capability are clean; skill is overloaded by design.

## Strategy

The "how." A saved recipe for executing one capability. Three tiers, ordered by speed:

- **`fetch`** — static-templated HTTP call (Node or in-browser transport). Fastest.
- **`page-script`** — JS executed inside a live page to build and fire the request per call.
- **`recorded-path`** — replay of UI actions. Last resort.

May declare prerequisites (`page-extract`, `fetch-extract`, `js-eval`, `cached`, `capability`, `browser`) that run before the body. See [strategies.md](strategies.md).

## Capability

The "what." A named, reusable operation on a platform: slug + args + return value (e.g. `send_message(recipient_name, text)`, `search_thread(name)`).

A capability is backed by one or more strategies — typically graduating from `recorded-path` toward `fetch` over time. Capabilities compose via the `{method: "capability", capability: "<other>", args, binds}` prereq — the runtime's name→id resolution primitive.

## Skill

Overloaded — three senses depending on context:

1. **The OpenClaw klura skill** — klura itself, the meta-skill that grows platform skills. Lives in `skill/`, published on ClawHub. Its instructions for the LLM live in `runtime/SKILL.md` (synced into the skill repo at publish time).
2. **Platform skill** — the bundle of all capabilities klura has learned for one site (e.g. "the LinkedIn skill"). What `list_platform_skills` returns: each entry is `{platform, capabilities: CapabilityInfo[]}`.
3. **Skill file** — the on-disk JSON unit, one per platform per capability. Holds that capability's saved strategies + `notes.*` + discovery_artifact. Loaded via `get_strategy`. `skill-notes.md` uses "skill" in this sense.

`list_platform_skills` and `get_strategy` operate at different levels: `list_platform_skills` enumerates platform skills (sense 2), while `get_strategy` loads one skill file (sense 3) and returns the strategy body inside it.

## Disambiguation

| Phrase | Means |
| --- | --- |
| "the strategy" | the executable recipe (one tier) |
| "save a strategy" | persist a recipe into its skill file |
| "the capability" | the named operation (slug + args + return) |
| "a capability prereq" | composition — invoke another capability, bind its return |
| "the skill" / "skill file" | the on-disk JSON unit holding one capability's strategies |
| "the platform skill" | the bundle of all capabilities for one site |
| `runtime/SKILL.md` | the OpenClaw skill manifest — LLM instructions loaded every conversation |
| `list_platform_skills` | enumerate platform skills (per-platform groupings) |
| `get_strategy` | load one skill file (returns strategy body + notes) |
