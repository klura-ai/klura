'use strict';

// The CLI agent's system prompt is SKILL.md — the same instructions klura's
// MCP server hands an external host — plus a one-line preamble naming the run
// mode. SKILL.md is the single source of truth for LLM instructions; the
// agent does not maintain its own copy.

const { loadKluraRuntime } = require('./klura-modules');

const PREAMBLES = {
  chat:
    'You are the klura CLI agent, driving klura directly from the command ' +
    'line for a local user. The user talks to you in a terminal REPL.',
  recovery:
    'You are the klura CLI agent, invoked to recover a failed execution. A ' +
    'saved strategy just failed and the session is already in triage. ' +
    'Diagnose the failure, re-drive as needed, and save a corrected strategy.',
};

/**
 * @param {'chat'|'recovery'} mode task framing — not a runtime mode flag.
 * @returns {string}
 */
function buildSystemPrompt(mode) {
  const klura = loadKluraRuntime();
  let skill = '';
  try {
    skill = klura.getSkillMd().replace(/^---[\s\S]*?---\s*/, '');
  } catch {
    skill = '';
  }
  const preamble = PREAMBLES[mode] || PREAMBLES.chat;
  return skill ? `${preamble}\n\n${skill}` : preamble;
}

module.exports = { buildSystemPrompt };
