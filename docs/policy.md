# Per-platform policy

Policy constrains how klura interacts with a platform. Set policy **before** discovery to control what gets saved, or after to constrain execution.

The policy file is at `~/.klura/skills/<platform>/policy.json`. Owner: user / operator. Permanent. Written via `klura policy set ...` CLI, the `set_policy` tool, or direct edit. **The agent has no write path** — policy is a user/operator surface, used for ToS rules, compliance caps, operator tier limits, forbid lists, throttle config.

For health tracking, save-time validation, and healing see [health.md](health.md) and [validation.md](validation.md).

---

## Shape

```jsonc
// ~/.klura/skills/<platform>/policy.json
{
  "max_strategy_tier": "fetch",
  // Caps how far graduation can go. Tiers above this are rejected at save and skipped at execute.
  // Order: "recorded-path" < "page-script" < "fetch"
  // Default: "fetch" (no cap)

  "forbid_capabilities": ["scrape_*", "bulk_*"],
  // Glob patterns. Matching capabilities cannot be saved or executed.

  "force_transport": "browser",
  // Pin execute-time transport for fetch strategies on this platform, overriding
  // the strategy's own `transport` field and the save-time probe stamp. Use
  // 'browser' for known JA3-bucketing sites so the dispatcher skips the Node
  // attempt entirely (no wasted retry). Use 'node' for CI regression checks or
  // for platforms you've verified work on pure Node and want to fail loud if
  // that regresses. Unset: the strategy's own transport decides.

  "notes": "Platform ToS forbids direct API access — keep at fetch or below.",
  "per_capability": {
    "get_user_videos": { "max_strategy_tier": "recorded-path", "reason": "ToS: no API reversing" },
  },
}
```

**Tier ordering**: `recorded-path` (most restrictive) < `page-script` < `fetch` (least restrictive). Setting `max_strategy_tier: "page-script"` allows page-script and recorded-path; fetch is forbidden.

**Default policy** (no file): `max_strategy_tier: "fetch"` — no restrictions.

---

## Enforcement

Policy is enforced at two points:

1. **Save time** (`save_strategy`): tier cap + forbid list checked before writing to disk. Above-cap or forbidden saves return `policy_violation`.
2. **Execute time** (`execute`): filters strategies and checks capabilities before running. Forbidden capabilities return `policy_violation`.

Graduation is also blocked: a strategy that would upgrade past the cap stays at its current tier.

Agent self-reports ("I tried to lift this and couldn't") live in the per-session working-dir logbook and are read via `get_platform_logbook` — they're advisory context for the next discovery agent, not a routing gate.

---

## Setting policy

- `set_policy(platform, {max_strategy_tier: "page-script"})` — via tool.
- `klura policy set <platform> max_strategy_tier page-script` — via CLI.
- Or edit `~/.klura/skills/<platform>/policy.json` directly.

**When the user says "don't RE this site" in conversation**: surface the CLI command in your reply so the user can make the cap permanent: `klura policy set <platform> <capability>.max_strategy_tier recorded-path --reason "<user reason>"`. The user runs it out-of-band. Runtime can't verify "agent acting on user instruction" attestations, so the trust path is the user's own hand on the CLI.
