// Bounded, loud waits and signals for child processes spawned by tests.
//
// Two hazards these helpers close, both of which turn one sick child process
// into a suite-wide outage when files run concurrently:
//
//   1. `await new Promise((r) => child.once('exit', r))` never settles if the
//      child exited before the listener was attached — the event has already
//      fired and nothing re-emits it. Nothing else is pending, so the file
//      stalls until the runner's timeout, holding a concurrency slot the whole
//      time.
//   2. `process.kill(Number(pidText), sig)` sends `sig` to the caller's entire
//      process group when `pidText` is empty or non-numeric, because
//      `Number('')` is 0 and pid 0 means "the whole group". Under
//      `--test-isolation=process` that group is the test runner and every
//      sibling test file.
//
// This directory is outside the `test/*.test.js` glob, so the runner never
// treats it as a test file.

import { existsSync, readFileSync } from 'node:fs';

/**
 * Resolve when `child` has exited, including when it exited before this call.
 * Rejects with a message naming `label` if the child outlives `timeoutMs`.
 */
export function waitForChildExit(child, { label, timeoutMs = 15_000 } = {}) {
  const name = label ?? `pid ${child.pid}`;
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`${name} did not exit within ${timeoutMs}ms (pid ${child.pid})`));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once('exit', onExit);
  });
}

/** Terminate `child` and wait for it to go, tolerating an already-dead child. */
export async function terminateChild(child, { label, signal = 'SIGTERM', timeoutMs = 15_000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // Already reaped between the check and the kill.
  }
  await waitForChildExit(child, { label, timeoutMs });
}

/**
 * Signal the process recorded in `pidPath`, if any. A missing, empty, or
 * non-positive pid file is a no-op — never a pid-0 broadcast to the group.
 */
export function signalPidFile(pidPath, signal = 'SIGTERM') {
  if (!existsSync(pidPath)) return false;
  let pid;
  try {
    pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // The process may have exited before test cleanup.
    return false;
  }
}
