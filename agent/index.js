'use strict';

// The optional LLM agent for the klura CLI — the shim that ships inside the
// @klura/runtime package at runtime/agent/.
//
// Three entry points, every one gated by the guardrail (assertAgentAllowed):
//   runChatAgent     — interactive REPL ("klura chat")
//   runRecoveryAgent — failure pick-up ("klura execute --agent")
//   runAgentTask     — run one goal programmatically (the CI harnesses)
//
// The agent always drives klura through createKluraMcpServer() over an
// in-memory transport — the same server an external MCP host connects to —
// so phase- and checkpoint-gating are identical to the MCP path. The LLM SDK
// itself lives in a pluggable provider package, never here.
//
// The provider's single human/continuation seam is `onTurnEnd(text)`: the
// provider calls it when the agent ends a turn with text and no pending tool
// call; a returned string is fed back as the next user message, null finishes.

const { isAgentAllowed, assertAgentAllowed, AgentBlockedError } = require('./lib/guardrail');
const { createKluraServer, bridgeServer } = require('./lib/mcp-bridge');
const { registerAgentCheckpoints } = require('./lib/checkpoint-handlers');
const { resolveProviderFactory } = require('./lib/provider-resolver');
const { validateProvider } = require('./lib/provider');
const { buildSystemPrompt } = require('./lib/system-prompt');
const { printAgentBanner } = require('./lib/banner');
const { loadKluraRuntime } = require('./lib/klura-modules');
const { unwrapPersistedOutput } = require('./lib/persisted-output');
const { createReplIo } = require('./lib/repl-io');
const { createTranscript } = require('./lib/transcript');

const DEFAULT_MAX_ROUNDS = 40;

function buildProvider(agentConfig) {
  const factory = resolveProviderFactory(agentConfig.provider);
  return validateProvider(factory(agentConfig), agentConfig.provider);
}

function resolveModel(provider, agentConfig) {
  return agentConfig.model || provider.defaultModel || null;
}

// Pass the provider what it needs: the server instance (Claude Agent SDK
// consumes it directly) plus a `connectTools` factory (OpenAI-style providers
// bridge an in-memory MCP client). A provider uses one or the other — only one
// transport ever connects to a given server.
function runAgentOpts(server, base) {
  return {
    server,
    connectTools: () => bridgeServer(server),
    ...base,
  };
}

// ---- runChatAgent: interactive REPL --------------------------------------

async function runChatAgent(opts = {}) {
  assertAgentAllowed('chat');
  const agentConfig = opts.agent || {};
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const maxRounds = agentConfig.maxRounds || DEFAULT_MAX_ROUNDS;

  const provider = buildProvider(agentConfig);
  const model = resolveModel(provider, agentConfig);
  const systemPrompt = buildSystemPrompt('chat');

  const server = await createKluraServer();
  const unregisterCheckpoints = registerAgentCheckpoints();

  // The REPL: nextLine reads the first goal; onTurnEnd collects every line
  // after. The agent's text is streamed via `emit`, so onTurnEnd only prompts.
  const { nextLine, onTurnEnd, close } = createReplIo({ input: opts.stdin, output: stderr });

  // Persist the conversation so a crashed/closed session is diagnosable. On by
  // default; agent.log_transcript:false (or --no-transcript) opts out.
  const transcript = createTranscript({
    enabled: agentConfig.logTranscript !== false,
    kind: 'chat',
    provider: provider.label || provider.id,
    model,
  });
  // Log each human turn as it is accepted, without changing REPL semantics.
  const loggedOnTurnEnd = async () => {
    const line = await onTurnEnd();
    transcript.user(line);
    return line;
  };

  const trace = (line) => stderr.write(`  \x1b[2m${line}\x1b[0m\n`);
  const emit = (ev) => {
    transcript.event(ev);
    if (ev.type === 'text' && ev.text) stdout.write(`${ev.text}\n`);
    else if (ev.type === 'tool_call') trace(`→ ${ev.tool}`);
    else if (ev.type === 'notice' && ev.text) trace(ev.text);
  };

  printAgentBanner(stderr, {
    title: 'klura chat',
    provider: provider.label || provider.id,
    model,
    lines: ['Type your task. Ctrl-D or "exit" to quit.'],
  });

  let result = null;
  try {
    stderr.write('> ');
    const goal = await nextLine();
    if (goal === null || goal.trim() === '') return null;
    transcript.session({ goal: goal.trim() });
    transcript.user(goal.trim());
    result = await provider.runAgent(
      runAgentOpts(server, {
        systemPrompt,
        goal: goal.trim(),
        model,
        maxRounds,
        onTurnEnd: loggedOnTurnEnd,
        emit,
      }),
    );
  } finally {
    close();
    transcript.close();
    if (transcript.path) stderr.write(`\n\x1b[2mtranscript: ${transcript.path}\x1b[0m\n`);
    unregisterCheckpoints();
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
  }
  return result;
}

// ---- runRecoveryAgent: zero-LLM execute, LLM picks up on failure ---------

async function runRecoveryAgent(opts = {}) {
  assertAgentAllowed('recovery');
  const agentConfig = opts.agent || {};
  const stderr = opts.stderr || process.stderr;
  const { platform, capability, args = {} } = opts;
  if (!platform || !capability) {
    throw new Error('runRecoveryAgent: platform and capability are required');
  }
  const maxRounds = agentConfig.maxRounds || DEFAULT_MAX_ROUNDS;
  const klura = loadKluraRuntime();

  // Phase 1 — run the saved strategy with NO LLM in the loop. start_session
  // with graph:"execute" auto-runs the strategy server-side. The session lands
  // in the runtime's global pool, shared by every in-process MCP server.
  stderr.write(`Running ${platform} / ${capability} …\n`);
  const startRes = await klura.startSession(opts.url || `https://${platform}`, {
    platform,
    capability,
    args,
    graph: 'execute',
  });
  const exec = startRes.executed === true ? startRes.execute_result : null;
  const execOk = exec && typeof exec.status === 'number' && exec.status >= 200 && exec.status < 300;

  if (execOk) {
    stderr.write('✓ Execution succeeded — no LLM agent needed.\n');
    return { succeeded: true, usedAgent: false, result: exec };
  }

  // Phase 2 — the strategy failed; the FSM has routed the session into triage.
  // Hand off to the LLM agent, loud and clear.
  const provider = buildProvider(agentConfig);
  const model = resolveModel(provider, agentConfig);
  printAgentBanner(stderr, {
    title: '⚠ Execution failed — handing off to LLM agent',
    provider: provider.label || provider.id,
    model,
    lines: ['The agent will diagnose and re-drive to save a working strategy.'],
  });

  const server = await createKluraServer();
  const unregisterCheckpoints = registerAgentCheckpoints();
  const transcript = createTranscript({
    enabled: agentConfig.logTranscript !== false,
    kind: 'recovery',
    provider: provider.label || provider.id,
    model,
  });
  const trace = (line) => stderr.write(`  \x1b[2m${line}\x1b[0m\n`);
  const emit = (ev) => {
    transcript.event(ev);
    if (ev.type === 'text' && ev.text) stderr.write(`${ev.text}\n`);
    else if (ev.type === 'tool_call') trace(`→ ${ev.tool}`);
  };
  // `klura execute --agent` is run by a human at a terminal — so when the
  // recovery agent ends a turn to ask a question (most importantly the
  // save-confirmation prompt), prompt that human. With no TTY (a script), EOF
  // ends the run: recovery still diagnoses, it just cannot commit the fix.
  const { onTurnEnd, close } = createReplIo({ input: opts.stdin, output: stderr });
  const loggedOnTurnEnd = async () => {
    const line = await onTurnEnd();
    transcript.user(line);
    return line;
  };
  const goal =
    `The saved klura strategy for ${platform} / ${capability} just failed when ` +
    `auto-executed (session ${startRes.sessionId}). The session is in triage. ` +
    `Diagnose the failure, re-drive the site as needed, and save a corrected ` +
    `strategy with save_strategy. Caller args: ${JSON.stringify(args)}.`;
  transcript.session({ platform, capability, goal });

  try {
    const result = await provider.runAgent(
      runAgentOpts(server, {
        systemPrompt: buildSystemPrompt('recovery'),
        goal,
        model,
        maxRounds,
        onTurnEnd: loggedOnTurnEnd,
        emit,
      }),
    );
    return { succeeded: true, usedAgent: true, result };
  } finally {
    close();
    transcript.close();
    if (transcript.path) stderr.write(`\n\x1b[2mtranscript: ${transcript.path}\x1b[0m\n`);
    unregisterCheckpoints();
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
  }
}

// ---- runAgentTask: one goal, programmatic (CI harnesses) -----------------

async function runAgentTask(opts = {}) {
  assertAgentAllowed('task');
  const agentConfig = opts.agent || {};
  const maxRounds = agentConfig.maxRounds || opts.maxRounds || DEFAULT_MAX_ROUNDS;
  if (!opts.goal) throw new Error('runAgentTask: goal is required');
  if (typeof opts.onTurnEnd !== 'function') {
    throw new Error('runAgentTask: onTurnEnd callback is required');
  }

  const provider = buildProvider(agentConfig);
  const model = resolveModel(provider, agentConfig);
  const systemPrompt = opts.systemPrompt || buildSystemPrompt('chat');

  const server = await createKluraServer(opts.mcpServerOptions);
  // The CI harnesses register their own checkpoint stubs (auto-continue +
  // save-confirmation + per-scenario handlers) before the run; they pass
  // skipCheckpointSetup so @klura/agent's handler does not register last and
  // shadow a scenario's per-variant handler.
  const unregisterCheckpoints = opts.skipCheckpointSetup ? () => {} : registerAgentCheckpoints();

  try {
    return await provider.runAgent(
      runAgentOpts(server, {
        systemPrompt,
        goal: opts.goal,
        model,
        maxRounds,
        onTurnEnd: opts.onTurnEnd,
        emit: opts.emit || (() => {}),
      }),
    );
  } finally {
    unregisterCheckpoints();
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
  }
}

module.exports = {
  runChatAgent,
  runRecoveryAgent,
  runAgentTask,
  isAgentAllowed,
  assertAgentAllowed,
  AgentBlockedError,
  // Shared helper for provider packages (the Claude SDK path needs it).
  unwrapPersistedOutput,
};
