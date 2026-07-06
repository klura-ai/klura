import fs from 'fs';
import path from 'path';

// Chrome writes a `SingletonLock` symlink into a profile directory while an
// instance holds that profile, named `<host>-<pid>`. A second Chrome launched
// against the same profile hands its command line to the holder and exits
// without opening the debug port we asked for — so a connect-mode spawn that
// can't attach is almost always a live holder, not a genuine launch failure.
// Reading the lock turns "failed to attach" into an actionable message.
//
// Deterministic and side-effect-free: read the symlink, parse the trailing pid,
// probe liveness. Returns a human description when a LIVE process holds the
// lock, or null (no lock, stale lock, unreadable, or non-symlink platform).
export function describeProfileLockHolder(profileDir: string): string | null {
  let target: string;
  try {
    // readlink throws if the lock is absent or not a symlink (e.g. Windows).
    target = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
  } catch {
    return null;
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!pidIsAlive(pid)) return null; // stale lock — a dead holder isn't the cause
  return `another Chrome (pid ${pid}) is holding the connect profile at ${profileDir}`;
}

// Signal 0 probes existence without delivering a signal: it throws ESRCH when
// no such process exists, EPERM when the process exists but is owned by another
// user (still alive). Anything else, treat as indeterminate → not alive.
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
