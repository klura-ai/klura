'use strict';

// The Provider contract.
//
// A provider package exports `createProvider(config) => Provider` (or
// default-exports the factory). It is the only seam between @klura/agent and a
// specific LLM SDK — the agent loop itself lives inside the provider, because
// a streaming Agent-SDK loop and a chat-completions loop have irreconcilably
// different shapes.
//
// config (passed to the factory):
//   { model?, baseUrl?, apiKey?, maxRounds? }
//
// Provider:
//   id           string  — stable id ("openai", "claude-code", ...)
//   label        string  — human label, shown in the loud banner
//   defaultModel string  — model used when config.model is unset
//   runAgent(opts) => Promise<RunResult>
//
// runAgent opts:
//   server       — klura MCP server instance (from createKluraServer())
//   systemPrompt string
//   goal         string  — the first user message
//   model        string
//   maxRounds    number
//   onTurnEnd(text, ctx) => Promise<string|null>
//                — called when the agent ends a turn with text and no pending
//                  tool call. `ctx.steps` is the live step log so the callback
//                  can decide based on what the agent has done. Return a string
//                  to feed back as the next user message (a human reply, or a
//                  "keep working" nudge); return null to finish. This is the
//                  ONLY human/continuation seam: the provider never classifies
//                  the agent's intent.
//   emit(event)  — optional structured sink for display:
//                  {type:'text'|'tool_call'|'tool_result'|'notice', ...}
//
// RunResult:
//   finalMessage      string
//   steps             array
//   usage             provider usage object, or null
//   terminationReason string

function validateProvider(p, spec) {
  if (!p || typeof p !== 'object') {
    throw new Error(`agent: provider "${spec}" factory returned a non-object`);
  }
  if (typeof p.runAgent !== 'function') {
    throw new Error(`agent: provider "${spec}" has no runAgent() method`);
  }
  return p;
}

module.exports = { validateProvider };
