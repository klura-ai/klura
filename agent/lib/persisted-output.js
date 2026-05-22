'use strict';

// MCP server-side persisted-output unwrap. When a tool result exceeds the
// inline budget, the server replaces the JSON payload with a marker:
//   <persisted-output>
//   Output too large (NN.NKB). Full output saved to: <path>
//   Preview (first 2KB):
//   <truncated preview>
// The full payload at <path> is an SDK content-block array. This returns the
// text body of the [Tool result for X]: block (caller will JSON.parse it).
// Returns null when the text isn't a persisted-output marker — caller falls
// through to the normal in-band parse path.

const fs = require('fs');

const PERSISTED_OUTPUT_PATH_RE = /Full output saved to:\s+(\S+)/;

function unwrapPersistedOutput(text) {
  if (typeof text !== 'string' || !text.includes('<persisted-output>')) return null;
  const m = text.match(PERSISTED_OUTPUT_PATH_RE);
  if (!m) return null;
  try {
    const fileText = fs.readFileSync(m[1], 'utf8');
    const parsed = JSON.parse(fileText);
    if (Array.isArray(parsed)) {
      const payload =
        parsed.find(
          (c) =>
            c &&
            c.type === 'text' &&
            typeof c.text === 'string' &&
            c.text.startsWith('[Tool result for '),
        ) || parsed.find((c) => c && c.type === 'text' && typeof c.text === 'string');
      if (payload) return payload.text.replace(/^\[.*?\]:\n/, '');
    }
    return fileText;
  } catch {
    return null;
  }
}

module.exports = { unwrapPersistedOutput };
