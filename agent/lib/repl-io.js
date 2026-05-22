'use strict';

// Line-at-a-time stdin reader shared by `klura chat` (the REPL) and
// `klura execute --agent` (the recovery flow). Both engage a human at the
// terminal: chat reads every turn from them; recovery reads when the agent
// surfaces a question (most importantly the save-confirmation prompt).
//
// `onTurnEnd` prompts for the human's next line. When stdin is not a TTY
// (a script, CI), EOF yields null and the agent run ends gracefully — a
// non-interactive `klura execute --agent` then diagnoses but does not commit.

const readline = require('readline');

function createReplIo({ input, output } = {}) {
  const out = output || process.stderr;
  const rl = readline.createInterface({ input: input || process.stdin, output: out });
  const waiters = [];
  // Lines that arrive before anyone is waiting (a piped `yes\n`, a fast
  // typist) are buffered here — otherwise they are lost and a later
  // `nextLine()` sees only the closed stream. The recovery flow depends on
  // this: the agent's save-confirmation turn-end can be minutes after stdin
  // already delivered its line + EOF.
  const lineQueue = [];
  let closed = false;
  rl.on('line', (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else lineQueue.push(l);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });

  const nextLine = () => {
    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((res) => waiters.push(res));
  };

  const onTurnEnd = async () => {
    out.write('\n> ');
    const line = await nextLine();
    if (line === null) return null;
    const t = line.trim();
    if (t === 'exit' || t === 'quit' || t === '/exit') return null;
    return t === '' ? '(no input — continue or stop as you see fit)' : t;
  };

  return { nextLine, onTurnEnd, close: () => rl.close() };
}

module.exports = { createReplIo };
