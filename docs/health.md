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

### Broken-tier probation

A `broken` tier is skipped by the executor **before it runs**, which means it appends no further outcome — so on its own the record can never change again. A tier that broke during a site outage would stay quarantined after the site recovered, and every later call would read `broken (skipped)` from a record frozen at the moment of the outage.

Probation is the way out. On the next `execute` that reaches the tier, the runtime compares `max(lastFailure, lastProbeAt)` against `pool.brokenProbationHours` (default 6, `0` disables). Past the window, the tier runs once as a probe and the outcome re-decides its health exactly like any other execute: clean → healthy, failure → broken again with a fresh clock.

Two properties are load-bearing:

- **Lazy, never timed.** The check happens at execute time. There is no timer, no sweeper, and nothing happens to a strategy nobody calls.
- **The clock is stamped before the probe, not after.** `not_run` and `delivery_unknown` return early without touching health by design; without `lastProbeAt` — written immediately before the probe fires — a probe that ended in either state would leave the clock at the old `lastFailure` and re-fire on every subsequent call.

When a tier is skipped, the cascade error names when it next becomes probe-eligible instead of dead-ending at `broken (skipped)`. `get_strategy_health` exposes the same policy as `quarantined` (broken and inside the window) and `probe_eligible_at` (unix-ms of the next probe, `null` when not applicable) — both derived from the function the executor consults, so the surface cannot disagree with what the next call does.

### What counts as healing

`markHealed` is the deliberate write that says "this capability works again": it resets the failure count, bumps `healCount`, appends a `healed` strategy event, and clears the probation clock. Three producers call it — a manual heal, a verified candidate promotion, and post-save verification of an **active** strategy on explicit success. The last one matters because health is keyed by capability + tier while a re-saved strategy is new bytes: without it, a strategy that broke, was fixed, and verified end-to-end would inherit the broken record of the bytes it replaced and be skipped on its first real call.

Verification traffic is otherwise health-silent (`_suppressStrategyState`), so grading never pollutes caller-visible health; `markHealed` is the one narrow exception, and it does not fire when the verified result failed a collection-integrity check — that routes to semantic review instead (see [ARCHITECTURE.md](../ARCHITECTURE.md) "Collection integrity").

Healing also clears the capability's rediscover silence (`_dontAskRediscover`), as does `resetHealth`. A "don't ask again" answer was given about a strategy that was failing; keeping it after the capability demonstrably works would mute the gate for a future, unrelated rot.

A separate per-protocol counter (`NODE_TRANSPORT_FAIL_THRESHOLD = 3` in `runtime/src/strategies/health.ts`) handles the narrower case of `fetch` Node transport failing on a strategy that does work in-browser — TLS fingerprint mismatch, ECONNRESET, that class. After 3 consecutive Node-transport failures, the runtime persistently demotes the strategy from `fetch` to `page-script` for subsequent execute calls without marking it broken.

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

## Health on the capability listing

`list_platform_skills` reports a `health` block beside `verification` on every capability that has executed at least once: `status`, `last_success` / `last_failure`, the rolling `recent_success_rate`, and `last_error`.

The two answer different questions and both are needed. A verification stamp describes the moment a strategy was saved; it says nothing about whether the capability has worked since. Between the two, a corpus rots silently — the site changes, rows stop coming back, and every surface an agent consults still reports the original stamp. Surfacing the outcome beside the stamp is what makes "saved" and "working" distinguishable at the moment a caller decides whether to trust a capability.

A capability that has never executed reports no `health` block at all. No record is honest about absence; a synthesized `healthy` would assert something the runtime has not observed.
