import fs from 'fs';
import path from 'path';

// Chrome writes a `SingletonLock` symlink into a profile directory while an
// instance holds that profile, named `<host>-<pid>`. A second Chrome launched
// against the same profile hands its command line to the holder and exits
// without opening the debug port we asked for — so a connect-mode spawn that
// can't attach is almost always a live holder, not a genuine launch failure.
// Reading the lock turns "failed to attach" into an actionable message and
// gives us the pid to reap an orphan we own.

export interface ProfileLockHolder {
  pid: number;
  profileDir: string;
}

// Read the SingletonLock and return the LIVE holder, or null (no lock, stale
// lock, unreadable, or non-symlink platform). Deterministic and side-effect-free.
export function readProfileLockHolder(profileDir: string): ProfileLockHolder | null {
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
  return { pid, profileDir };
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

// A klura process using the Chrome on a profile says so with a lease: a file
// named for its pid under the profile. The SingletonLock says a Chrome holds
// the profile; the leases say whether anything alive is using that Chrome.
// Together they separate the two cases a second process must not confuse — a
// Chrome a previous run left behind, which is reaped, and a Chrome another
// live process is driving right now, which is shared.
const LEASE_DIRECTORY = 'klura-leases';

function leaseDirectory(profileDir: string): string {
  return path.join(profileDir, LEASE_DIRECTORY);
}

/** Records that this process is using the Chrome on `profileDir`. */
export function acquireProfileLease(profileDir: string): void {
  fs.mkdirSync(leaseDirectory(profileDir), { recursive: true });
  fs.writeFileSync(path.join(leaseDirectory(profileDir), String(process.pid)), '');
}

/** Withdraws this process's lease; a no-op when it holds none. */
export function releaseProfileLease(profileDir: string): void {
  fs.rmSync(path.join(leaseDirectory(profileDir), String(process.pid)), { force: true });
}

/** Pids of other live processes leasing `profileDir`. A lease whose process
 *  is gone is removed on the way: it was never released, and left in place it
 *  would be read as a live user by every later process that reuses the pid. */
export function otherProfileLeases(profileDir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(leaseDirectory(profileDir));
  } catch {
    return [];
  }
  const live: number[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (pidIsAlive(pid)) live.push(pid);
    else fs.rmSync(path.join(leaseDirectory(profileDir), name), { force: true });
  }
  return live;
}

const CHROME_RECORD = 'klura-chrome.json';

/**
 * Records the Chrome a process launched on `profileDir` and the DevTools
 * endpoint it was given. Chrome publishes its port in the profile only when
 * asked to choose one itself; a port chosen for it is known to the launcher
 * alone, so the launcher writes it where a second process can find it.
 */
export function recordProfileChrome(profileDir: string, pid: number, endpoint: string): void {
  fs.writeFileSync(path.join(profileDir, CHROME_RECORD), JSON.stringify({ pid, endpoint }));
}

/** The DevTools endpoint recorded for the Chrome `pid` holding `profileDir`.
 *  The record outlives the Chrome it describes, so it is believed only when it
 *  names the Chrome that holds the profile now. */
export function readProfileDevToolsEndpoint(profileDir: string, pid: number): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(profileDir, CHROME_RECORD), 'utf8')) as {
      pid?: unknown;
      endpoint?: unknown;
    };
    return record.pid === pid && typeof record.endpoint === 'string' ? record.endpoint : null;
  } catch {
    return null;
  }
}

export type ProfileChromeState =
  /** No Chrome holds the profile and no other process is about to start one. */
  | { kind: 'free' }
  /** A Chrome holds the profile and nothing alive is using it. */
  | { kind: 'orphan'; pid: number }
  /** Another live klura process is using, or still launching, the profile's
   *  Chrome. `endpoint` is null until that Chrome has opened its port. */
  | { kind: 'shared'; pid: number | null; endpoint: string | null; lessees: number[] };

/** What a process about to use `profileDir` finds there. */
export function assessProfileChrome(profileDir: string): ProfileChromeState {
  const holder = readProfileLockHolder(profileDir);
  const lessees = otherProfileLeases(profileDir);
  if (lessees.length > 0) {
    return {
      kind: 'shared',
      pid: holder ? holder.pid : null,
      endpoint: holder ? readProfileDevToolsEndpoint(profileDir, holder.pid) : null,
      lessees,
    };
  }
  return holder ? { kind: 'orphan', pid: holder.pid } : { kind: 'free' };
}
