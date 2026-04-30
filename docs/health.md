# Strategy health & healing

Health tracking, schema migration, and the patch_step heal loop — the lifecycle of a saved strategy from execution failure through degradation, healing, and scoring.

For the strategy shapes themselves see [strategies.md](strategies.md). For save-time validation see [validation.md](validation.md). For per-platform tier caps see [policy.md](policy.md).

---

## Strategy health tracking

Health is tracked per strategy tier per capability and **persisted to `~/.klura/workdir/<platform>/health.json`** (one file per platform) so it survives daemon restarts. Each strategy has a status: `healthy`, `degraded`, or `broken`.

```
Execute strategy
  │
  ├─ Success → reset failure count, mark healthy
  │
  ├─ Failure → increment consecutive failure count
  │   ├─ < 5 failures → degraded, cascade to next tier
  │   └─ ≥ 5 failures (BROKEN_THRESHOLD) → archived as broken (.broken.json)
  │
  └─ After heal (patch_step + resume_execution) → reset to healthy
```

Health status can be queried via `get_strategy_health(platform, capability, strategy_type)` and reset via `reset_strategy_health(platform, capability, strategy_type)`.

A separate per-protocol counter (`NODE_TRANSPORT_FAIL_THRESHOLD = 3` in `runtime/src/health.ts`) handles the narrower case of `fetch` Node transport failing on a strategy that does work in-browser — TLS fingerprint mismatch, ECONNRESET, that class. After 3 consecutive Node-transport failures, the runtime demotes the strategy to in-browser transport for subsequent execute calls without changing its on-disk shape or marking it broken.

---

## Schema versioning

Strategies include a `schema_version` field stamped on save so future schema changes can migrate in place. When the runtime loads a strategy, it checks the version and applies any pending migrations (N → N+1 until current), writing the result back to disk so each migration runs only once. If a migration fails, the strategy is treated as degraded and the runtime cascades to the next tier.

---

## Skill healing

When a recorded-path step fails (e.g. a selector changed after a site redesign), the runtime returns a `healable` response instead of immediately failing. The response includes:

- The failed step and its index
- The current a11y tree
- A screenshot of the page
- The active `session_id`

The LLM reads the a11y tree, identifies the new selector, and patches just the broken step:

```
1. patch_step(platform, capability, strategy_type, step_id, {locators: {...}})
2. resume_execution(session_id)
```

The patched locator is written back to the strategy file as an `alternatives` entry, so it survives future runs. On success, the strategy resets to healthy automatically (or via `mark_healed` if the resume was driven manually).

Only fall back to full re-discovery if multiple steps are broken or the page structure changed fundamentally.

---

## Scoring

When asked about skill quality: `list_platform_skills()` and report strategy type distribution, health status, coverage. Example: "food-delivery: 6 capabilities, 4 fetch, 2 recorded-path. 5/6 healthy."
