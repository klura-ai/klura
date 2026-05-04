// start_session rejects when capability is set without platform.
//
// Platform keys every downstream lifecycle (auto-execute, storage state,
// synth, submit_triage_plan), so accepting a capability without a platform
// leaves the session unable to file the resulting strategy and unable to
// reload prior cookies.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-start-platform-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const { startSession } = await import('../dist/index.js');

test('rejects capability without platform', async () => {
  await assert.rejects(
    () => startSession('https://www.messenger.com', { capability: 'send_message' }),
    /invalid_start_session: capability "send_message" was declared without a platform/,
  );
});

test('rejection names the storage-state and skill-dir paths', async () => {
  await assert.rejects(
    () => startSession('https://www.messenger.com', { capability: 'send_message' }),
    (err) => {
      assert.match(err.message, /~\/\.klura\/skills\/<platform>\//);
      assert.match(err.message, /~\/\.klura\/storage-state\/<platform>\.json/);
      return true;
    },
  );
});

test('rejection suggests second-level domain pattern', async () => {
  await assert.rejects(
    () => startSession('https://www.reddit.com', { capability: 'submit_post' }),
    /platform = the second-level domain.*messenger.*reddit/s,
  );
});

// Pass-through cases (no capability, or platform supplied alongside) are
// covered by the broader start-session suites (start-session-policy,
// start-session-trim) which exercise startSession against patched pools.
// Replicating that fixture here just to assert "validation didn't fire" is
// duplicate scaffolding. The three rejection tests above are the
// load-bearing ones.
