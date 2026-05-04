// start_session rejects `graph: "map"` + `capability` combination.
//
// Map's FSM topology is `drive → terminal{closed}` — there is no triage or
// lift phase. Declaring a capability commits the session to the lift handoff
// at end_drive (any unresolved capability needs a saved strategy or an
// explicit decline) but the graph cannot transition into lift. Without the
// up-front rejection, end_drive ends up writing session.lift bookkeeping
// out-of-band and the next currentPhase() call hits the half-init invariant.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-start-map-cap-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const { startSession } = await import('../dist/index.js');

test('rejects {graph: "map", capability}', async () => {
  await assert.rejects(
    () =>
      startSession('https://example.com/', {
        platform: 'example',
        capability: 'do_thing',
        graph: 'map',
      }),
    /invalid_start_session: capability "do_thing" cannot be declared on a `graph: "map"` session/,
  );
});

test('rejection points at discover as the right graph for goal-directed flows', async () => {
  await assert.rejects(
    () =>
      startSession('https://example.com/', {
        platform: 'example',
        capability: 'do_thing',
        graph: 'map',
      }),
    /pass `graph: "discover"`/,
  );
});

test('rejection mentions that pure platform mapping (no capability) stays on map', async () => {
  await assert.rejects(
    () =>
      startSession('https://example.com/', {
        platform: 'example',
        capability: 'do_thing',
        graph: 'map',
      }),
    /Pure platform mapping \(no capability\) stays on map/,
  );
});
