# Capability composition

Klura does **not** have a workflow engine, pipeline concept, or cross-capability invocation primitive, and it is not planned. The LLM is the orchestrator — it reads `list_platform_skills`, recognises that one capability's output feeds another's input, and calls `execute` twice with the result of the first as arguments to the second. Klura's job is to make each individual capability fast and reliable. The LLM's job is to compose them intelligently. This is a direct application of the "runtime is plumbing, LLM is intelligence" principle (see [principles.md](principles.md)) — composition is exactly the kind of reasoning the LLM is already good at, and building a runtime-side dependency graph would duplicate what conversation context already provides.

The one runtime-side composition affordance that does exist: a strategy can declare `{method: "capability", capability: "<another>", args, binds}` as one of its prerequisites. At execute time the runtime recursively invokes the referenced strategy and binds its return value into the caller's template namespace. This is how name→id resolution works inside a single capability — see [strategies.md](strategies.md) for the shape.

## Why no `capability-extract` prereq

The obvious-looking feature request is a new prerequisite method that names another saved capability:

```json
{
  "method": "capability-extract",
  "platform": "X",
  "capability": "search_contact",
  "args": { "query": "{{recipient}}" },
  "extract": "results[0].id"
}
```

This is not built and not on the roadmap. Reasons:

1. **The LLM already does this better.** When the agent sees that `send_message`'s `thread_id` parameter is a human-unknowable opaque id, and `list_platform_skills` surfaces a `search_contact` capability whose output shape contains `thread_id`, the agent calls them in order. That is a reasoning step the LLM is fluent in — the runtime adds nothing by encoding the dependency statically. A runtime-side graph would also go stale the moment either capability's schema drifts, which is how static dependency metadata always dies.
2. **Cascade accounting gets ugly fast.** The inner `execute` can fail mid-tier-cascade, retry through healing, hit a blocker, open a remote viewer, and demote its transport — all while the outer call is counting the same timeout budget. Supporting this cleanly means either duplicating the full execute orchestrator inside the prereq loop or exposing arbitrary reentrancy. Both are real work for a feature the LLM already covers with two tool calls.
3. **Cycle detection is a permanent tax.** As soon as capabilities can name each other, every `save_strategy` has to walk the skill graph for cycles, every execute path has to detect them at replay time, and broken graphs have to be recoverable without manual intervention. The runtime stays dramatically simpler if the graph lives in the LLM's turn, where cycles fail in the obvious way (the LLM notices it has already called this capability and stops).
4. **The discovery habit is what we actually want.** The real failure mode — the one we keep seeing — is agents saving monolithic "search + send" recorded-paths that aren't composable at all, because discovery didn't recognise the search step as a standalone capability. The fix for that is a SKILL.md rule (see the "write discovery contains a read discovery" bullet in SKILL.md's Key rules), not a new prereq method. Once both capabilities are saved, composition at call time is trivial.
