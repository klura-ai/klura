'use strict';

// Append-only transcript logger for `klura chat` / `klura execute --agent`.
//
// The REPL streams the conversation to the terminal and forgets it — nothing
// is persisted, so a crashed or closed session leaves no record to diagnose
// from (the session archive keeps only a tool_trace of names + arg digests, no
// content). This writes the human turns, the assistant text, and the tool
// calls to a JSONL file under <KLURA_HOME>/chat-logs/ so a run can be replayed
// after the fact. On by default; the caller passes enabled:false to opt out.

const fs = require('fs');
const os = require('os');
const path = require('path');

function kluraHome() {
  return process.env.KLURA_HOME || path.join(os.homedir(), '.klura');
}

// Timestamp slug safe for a filename: 2026-07-05T19-58-30-123Z.
function stamp(d) {
  return d.toISOString().replace(/[:.]/g, '-');
}

// A no-op transcript so callers never branch on enabled/disabled.
function nullTranscript() {
  return { path: null, session() {}, user() {}, event() {}, close() {} };
}

function createTranscript({ enabled = true, kind = 'chat', provider, model } = {}) {
  if (!enabled) return nullTranscript();

  const dir = path.join(kluraHome(), 'chat-logs');
  let stream;
  let filePath;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    filePath = path.join(dir, `${kind}-${stamp(now)}-${process.pid}.jsonl`);
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    // Never let a transcript write crash the session it is recording.
    stream.on('error', () => {});
  } catch {
    return nullTranscript();
  }

  const write = (rec) => {
    if (!stream || stream.destroyed) return;
    try {
      stream.write(`${JSON.stringify({ t: new Date().toISOString(), ...rec })}\n`);
    } catch {
      /* best-effort — a failed transcript write must not break the run */
    }
  };

  return {
    path: filePath,
    session(meta) {
      write({ kind: 'session_start', provider, model, ...meta });
    },
    user(text) {
      if (text) write({ role: 'user', text });
    },
    // Mirror the REPL's own `emit` event shape so wiring is a one-liner.
    event(ev) {
      if (!ev) return;
      if (ev.type === 'text' && ev.text) write({ role: 'assistant', text: ev.text });
      else if (ev.type === 'tool_call') write({ role: 'tool', tool: ev.tool });
      else if (ev.type === 'notice' && ev.text) write({ role: 'notice', text: ev.text });
    },
    close() {
      if (stream && !stream.destroyed) {
        try {
          stream.end();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

module.exports = { createTranscript };
