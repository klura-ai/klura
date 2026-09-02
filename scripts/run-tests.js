'use strict';

// Single entry point for the runtime test suite.
//
// It exists for one reason: to give every way the run can end a verdict the
// reader can act on.
//
//   - Tests pass or fail   → the spec reporter says so, exit code follows.
//   - A test file's child process dies (signal, or a non-zero exit before it
//     reported) → scripts/test-crash-reporter.js prints a banner naming the
//     file and the signal, and the run fails.
//   - The runner process itself dies → nothing inside the run can report it:
//     the reporters live in that process. Without this wrapper the run ends
//     with a bare exit code 139 and no totals at all, which is
//     indistinguishable at a glance from a suite that printed nothing because
//     it had nothing to say. This wrapper turns it into a named failure.
//
// A dead process is never a test result. Whichever of the last two fires, the
// totals for that run are incomplete and the run proves nothing — the message
// says so rather than leaving a shrinking test count as the only clue.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const runtimeRoot = path.resolve(__dirname, '..');
const testDirectory = path.join(runtimeRoot, 'test');

const DEFAULT_CONCURRENCY = '4';
// No test is anywhere near this long; the cap exists so a wait that can never
// settle fails with a timeout instead of stalling the run behind one file.
const PER_TEST_TIMEOUT_MS = '60000';

// `--concurrency=1` runs the suite one file at a time. Comparing a serial run
// against the parallel default is how you tell an ordering or isolation problem
// apart from one that only needs a loaded machine.
function concurrency() {
  const flag = process.argv.slice(2).find((argument) => argument.startsWith('--concurrency='));
  if (!flag) return DEFAULT_CONCURRENCY;
  const value = flag.slice('--concurrency='.length);
  if (!/^[1-9][0-9]*$/.test(value)) {
    process.stderr.write(`--concurrency must be a positive integer, got ${JSON.stringify(value)}\n`);
    process.exit(1);
  }
  return value;
}

function testFiles() {
  return fs
    .readdirSync(testDirectory)
    .filter((entry) => entry.endsWith('.test.js'))
    .sort()
    .map((entry) => path.join('test', entry));
}

function runnerArguments() {
  return [
    '--test',
    `--test-concurrency=${concurrency()}`,
    `--test-timeout=${PER_TEST_TIMEOUT_MS}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=./scripts/test-crash-reporter.js',
    '--test-reporter-destination=stderr',
    ...testFiles(),
  ];
}

const result = childProcess.spawnSync(process.execPath, runnerArguments(), {
  cwd: runtimeRoot,
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`\nCould not start the test runner: ${result.error.message}\n`);
  process.exit(1);
}

if (result.signal) {
  process.stderr.write(
    [
      '',
      '='.repeat(72),
      `TEST RUNNER PROCESS DIED: ${result.signal}`,
      '  The runner itself was killed, so no reporter ran and the suite printed',
      '  no totals. Nothing was proven about the code under test — rerun before',
      '  drawing any conclusion from this run.',
      '='.repeat(72),
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
