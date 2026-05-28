// Regression: inferObservedCapabilitiesFromTriage emits breadcrumbs WITHOUT a
// session_id. These are runtime-derived (triage-plan → observed_capability),
// named in surface-label namespace (`thing_surface`), not the capability-name
// namespace the agent lifts in (`get_thing`). If they carried session_id they
// would bump the per-session observed map and feed this session's
// observed_capabilities_not_lifted gate — re-counting a surface the agent DID
// lift as "observed but not lifted" and forcing a spurious end_drive ack
// (the two namespaces never intersect). The breadcrumb still lands in the
// logbook for the NEXT session's candidate list; it just must not pollute the
// current session's gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-triage-infer-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { inferObservedCapabilitiesFromTriage } = await import(
  '../dist/phases/drive/triage-inference.js'
);
const { loadLogbook, writeLogbook } = await import('../dist/working-dir/logbook.js');

const PLATFORM = 'infershop';

test('triage-inferred breadcrumbs carry no session_id and use the surface-label name', () => {
  // Seed a triaged surface under capability `get_thing` whose URL is covered
  // by no saved strategy (none exist on disk) → the inference mints a
  // breadcrumb for it.
  const logbook = loadLogbook(PLATFORM);
  logbook.per_capability.get_thing = {
    triage_plans_by_surface: {
      'thing-surface': { observed_at_urls: ['https://infershop.example/thing'] },
    },
  };
  writeLogbook(logbook);

  const inferred = inferObservedCapabilitiesFromTriage(PLATFORM);
  const thing = inferred.find((e) => e.name === 'thing_surface');

  assert.ok(thing, 'a breadcrumb is minted for the uncovered triaged surface');
  assert.equal(
    Object.prototype.hasOwnProperty.call(thing, 'session_id'),
    false,
    'inference breadcrumbs must NOT carry session_id (else they pollute the not-lifted gate)',
  );
  assert.equal(thing.evidence.source, 'triage_inference');
});
