// Secondary test reporter: surfaces test files whose *process* died.
//
// Under `--test-isolation=process` each file runs in its own child. When that
// child is killed by a signal or exits non-zero before reporting, the default
// spec reporter prints a bare `✖ test/foo.test.js — 'test failed'`, and the
// tests the child never reached simply vanish from the totals. That reads as a
// flaky assertion when it is nothing of the sort, and a shrinking total test
// count is the only clue.
//
// This reporter emits nothing for ordinary failures. It prints one banner per
// dead child naming the file, the signal, and the exit code, plus a reminder
// that the run's totals are incomplete.

export default async function* crashReporter(source) {
  const crashes = [];
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const error = event.data?.details?.error;
    if (!error) continue;
    const signal = error.signal ?? null;
    const exitCode = error.exitCode ?? null;
    // A file-level failure carries a signal or a non-zero exit code only when
    // the child process itself died. Assertion failures leave both unset.
    if (signal === null && (exitCode === null || exitCode === 0)) continue;
    const file = event.data.file ?? event.data.name;
    crashes.push({ file, signal, exitCode });
    yield [
      '',
      '='.repeat(72),
      `TEST PROCESS DIED: ${file}`,
      `  signal:    ${signal ?? '(none)'}`,
      `  exit code: ${exitCode ?? '(none)'}`,
      '  The child was killed before it finished reporting, so every test it',
      '  had not yet reached is missing from the run totals. This is a process',
      '  death, not an assertion failure — treat the run as inconclusive.',
      '='.repeat(72),
      '',
    ].join('\n');
  }
  if (crashes.length > 0) {
    yield `\n${crashes.length} test file(s) died mid-run: ${crashes
      .map((crash) => `${crash.file} (${crash.signal ?? `exit ${crash.exitCode}`})`)
      .join(', ')}\n`;
  }
}
