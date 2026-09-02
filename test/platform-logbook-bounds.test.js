// `get_platform_logbook` must fit the MCP output budget at both call shapes.
//
// Observed three times in one produce run, on three different platforms, at
// 61-65 KB each — truncated to a file the agent cannot read, which defeats the
// logbook's purpose of reusing prior findings instead of rediscovering them.
// The dominant term is `field_stability`: youtube measured 1,777,169 of
// 1,800,154 total bytes (98.7%) and was still growing.
//
// Two call shapes, two defects:
//   unscoped {platform}              — every capability's stability
//   scoped   {platform, capability}  — falls back to the FULL report when that
//                                      capability has no entry yet, which is
//                                      every newly-authored capability
//
// The fixture drives the real input: field stability is recomputed from session
// archives on disk, so writing a derived JSON file proves nothing — an earlier
// version of this test did exactly that and passed against an empty report.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-logbook-bounds-'));
process.env.KLURA_HOME = HOME;

const { getPlatformLogbook } = await import('../dist/tools/skills-query.js');

const BUDGET = 40_000;
const PLATFORM = 'bounds_probe';
const CAPABILITIES = ['cap_one', 'cap_two', 'cap_three', 'cap_four'];

/**
 * One archive per capability, each with many distinct endpoints — the shape a
 * real session produces (youtube archives carry ~179 requests each). Entry
 * count scales with distinct endpoints per capability, so this is what actually
 * inflates the report.
 */
function writeArchives() {
  for (const capability of CAPABILITIES) {
    const dir = path.join(HOME, 'workdir', PLATFORM, 'sessions', `sess_${capability}`);
    fs.mkdirSync(dir, { recursive: true });
    const http = [];
    for (let endpoint = 0; endpoint < 60; endpoint++) {
      for (let sample = 0; sample < 3; sample++) {
        http.push({
          method: 'GET',
          url:
            `https://example.test/api/v1/${capability}/resource_${endpoint}` +
            `?token=${'t'.repeat(30)}${sample}&locale=en&page=${sample}&filter_${endpoint}=value`,
          status: 200,
        });
      }
    }
    fs.writeFileSync(
      path.join(dir, 'archive.json'),
      JSON.stringify({
        schema_version: 1,
        session_id: `sess_${capability}`,
        platform: PLATFORM,
        meta: { started_at: 0, ended_at: 1, capability, args: {}, outcome: 'saved' },
        http,
        ws: [],
        actions: [],
        tool_trace: [],
        bundle_shas: [],
        storage_state_file: null,
      }),
    );
  }
}

const size = (value) => JSON.stringify(value ?? null).length;

test.before(() => writeArchives());
test.after(() => {
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
});

test('the fixture actually inflates field_stability', async () => {
  // Guards the rest of the file: without this, a fixture that produces an empty
  // report makes every budget assertion below pass for the wrong reason.
  const { recomputeFieldStability } = await import(
    '../dist/working-dir/derived/field-stability.js'
  );
  const report = recomputeFieldStability(PLATFORM);
  const entries = Object.values(report.per_capability).flat().length;
  assert.ok(entries > 100, `fixture produced only ${entries} stability entries`);
  assert.ok(
    size(report) > BUDGET,
    `fixture report is ${size(report)} bytes — not large enough to test a bound`,
  );
});

test('the unscoped logbook fits the output budget', () => {
  const result = getPlatformLogbook({ platform: PLATFORM });
  assert.ok(
    size(result) < BUDGET,
    `unscoped logbook is ${size(result)} bytes; youtube reached 1,800,154 in a live run`,
  );
});

test('a scoped call returns only that capability', () => {
  const result = getPlatformLogbook({ platform: PLATFORM, capability: 'cap_one' });
  const keys = Object.keys(result.field_stability?.per_capability ?? {});
  assert.deepEqual(keys, ['cap_one']);
  assert.ok(size(result) < BUDGET, `scoped logbook is ${size(result)} bytes`);
});

test('a scoped call for a capability with no stability entry stays bounded', () => {
  // The fallback branch hands back the entire report. Every newly-authored
  // capability takes it, which is exactly what a produce run creates.
  const result = getPlatformLogbook({ platform: PLATFORM, capability: 'brand_new_capability' });
  const keys = Object.keys(result.field_stability?.per_capability ?? {});
  assert.ok(
    !keys.some((k) => CAPABILITIES.includes(k)),
    `unrelated capabilities leaked into a scoped call: ${keys.join(', ')}`,
  );
  assert.ok(size(result) < BUDGET, `scoped logbook is ${size(result)} bytes`);
});

test("a capability's own endpoint tables are bounded, not just narrowed", () => {
  // Narrowing to one capability is not enough: one youtube capability's tables
  // came to 874,921 bytes across 21 endpoints, a single one of them 350,102.
  const result = getPlatformLogbook({ platform: PLATFORM, capability: 'cap_one' });
  const entries = result.field_stability?.per_capability?.cap_one ?? [];
  assert.ok(entries.length <= 4, `returned ${entries.length} endpoint tables unbounded`);
  assert.ok(size(result) < BUDGET, `scoped logbook is ${size(result)} bytes`);
});

test('a bounded list admits what it left out', () => {
  // A capped list that looks complete is worse than one that says it is capped.
  const result = getPlatformLogbook({ platform: PLATFORM, capability: 'cap_one' });
  const entries = result.field_stability?.per_capability?.cap_one ?? [];
  const marker = entries.find((e) => typeof e === 'string');
  assert.ok(marker, 'no elision marker on a truncated list');
  assert.match(marker, /more not listed/);
});

test('the small derived reports are still returned', () => {
  // Measured at 95-828 bytes across three platforms; bounding them would lose
  // signal for nothing.
  const result = getPlatformLogbook({ platform: PLATFORM });
  assert.ok('bundle_history' in result);
  assert.ok('signer_history' in result);
  assert.ok('known_modules' in result);
});
