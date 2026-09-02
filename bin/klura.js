#!/usr/bin/env node
'use strict';

const args = process.argv.slice(2);
const consumerCommands = new Set([
  'search',
  'show',
  'install',
  'installed',
  'remove',
  'call',
  'run',
  'export',
  'runs',
  'login',
  'session',
  'doctor',
]);

function runConsumer() {
  // The consumer adapter is compiled independently from factory state. Keep
  // this route above every legacy import so an ordinary local call starts no
  // daemon, browser, MCP host, or discovery provider.
  require('../dist/consumer/cli')
    .runConsumerCli(args)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ kind: 'failure', code: 'local_state_invalid', message }));
      process.exitCode = 3;
    });
}

if (!args[0] || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
  runConsumer();
} else if (args[0] === '--version') {
  console.log(require('../package.json').version);
} else if (consumerCommands.has(args[0])) {
  runConsumer();
} else if (args[0] === 'factory') {
  process.argv = [...process.argv.slice(0, 2), ...args.slice(1)];
  require('./klura-factory.js');
} else {
  require('./klura-factory.js');
}
