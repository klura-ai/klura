// Cross-session derived signals: field-stability, bundle-history,
// signer-history. Writes session archives directly (no agent / pool),
// then verifies the derived computation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-derived-'));
process.env.KLURA_HOME = TMP;

const { ingestCaptureEvents } = await import('../dist/working-dir/writer.js');
const { recomputeFieldStability } = await import(
  '../dist/working-dir/derived/field-stability.js'
);
const { recomputeBundleHistory } = await import(
  '../dist/working-dir/derived/bundle-history.js'
);
const { recomputeSignerHistory } = await import(
  '../dist/working-dir/derived/signer-history.js'
);
const sufficiencyMod = await import('../dist/working-dir/sufficiency.js');

// Minimal helper: write an archive for one session with N captured
// requests to a target endpoint, varying params by a fixed schedule.
function writeSession(platform, sessionId, opts) {
  const endedAt = opts.endedAt ?? Date.now();
  const capability = opts.capability ?? 'get_list';
  const args = opts.args ?? { q: 'alice' };
  const events = [
    {
      at: endedAt,
      session_id: sessionId,
      platform,
      kind: 'session_meta',
      payload: {
        started_at: endedAt - 10000,
        ended_at: endedAt,
        capability,
        args,
        outcome: opts.outcome ?? 'no_save',
      },
    },
    ...(opts.requests ?? []).map((r) => ({
      at: endedAt,
      session_id: sessionId,
      platform,
      capability,
      kind: 'http_request',
      payload: r,
    })),
    ...(opts.bundles ?? []).map((b) => ({
      at: endedAt,
      session_id: sessionId,
      platform,
      kind: 'bundle_seen',
      payload: b,
    })),
    ...(opts.toolTrace ?? []).map((t) => ({
      at: endedAt,
      session_id: sessionId,
      platform,
      capability,
      kind: 'tool_call',
      payload: t,
    })),
  ];
  ingestCaptureEvents(platform, sessionId, events);
}

test('field-stability classifies stable / caller-varying / rotating across 4 sessions', () => {
  const platform = 'fs-1';
  const base = 'https://api.example.com/items';
  // 4 captures. Same user (alice) fires twice, then bob fires twice —
  // so `q` has 2 distinct values but each appears > 1 time. This breaks
  // the 1:1 correlation illusion with `ts` (which keeps rotating).
  //   count=10  → stable across all fires
  //   q=<arg>    → caller-varying (correlates with args.q; same q, any fire)
  //   ts=...     → rotating (differs per fire, no caller correlation)
  writeSession(platform, 'sess_1', {
    args: { q: 'alice' },
    requests: [{ method: 'GET', url: `${base}?count=10&q=alice&ts=1000000000`, headers: {}, postData: null, status: 200 }],
  });
  writeSession(platform, 'sess_2', {
    args: { q: 'alice' },
    requests: [{ method: 'GET', url: `${base}?count=10&q=alice&ts=1000000100`, headers: {}, postData: null, status: 200 }],
  });
  writeSession(platform, 'sess_3', {
    args: { q: 'bob' },
    requests: [{ method: 'GET', url: `${base}?count=10&q=bob&ts=1000000200`, headers: {}, postData: null, status: 200 }],
  });
  writeSession(platform, 'sess_4', {
    args: { q: 'bob' },
    requests: [{ method: 'GET', url: `${base}?count=10&q=bob&ts=1000000300`, headers: {}, postData: null, status: 200 }],
  });

  const report = recomputeFieldStability(platform);
  const entry = report.per_capability['get_list']?.[0];
  assert.ok(entry, 'capability entry present');
  assert.equal(entry.n_captures, 4);
  assert.equal(entry.params['count'].verdict, 'stable', 'count is stable');
  assert.equal(entry.params['q'].verdict, 'caller_varying', 'q correlates with arg');
  assert.equal(entry.params['q'].correlates_with, 'q');
  assert.equal(entry.params['ts'].verdict, 'rotating', 'ts rotates');
  assert.equal(entry.params['ts'].shape, 'timestamp_digits');
});

test('field-stability reports ambiguous when n < 3 captures with no caller correlation', () => {
  const platform = 'fs-2';
  const base = 'https://api.example.com/items';
  // Same caller args across both fires (q=alice), but xyz differs.
  // → xyz can't be "caller_varying" (caller args didn't change), and we
  // can't call it rotating with n<3 samples. Must be ambiguous.
  writeSession(platform, 'sess_a', {
    args: { q: 'alice' },
    requests: [{ method: 'GET', url: `${base}?q=alice&xyz=111`, headers: {}, postData: null, status: 200 }],
  });
  writeSession(platform, 'sess_b', {
    args: { q: 'alice' },
    requests: [{ method: 'GET', url: `${base}?q=alice&xyz=222`, headers: {}, postData: null, status: 200 }],
  });
  const report = recomputeFieldStability(platform);
  const entry = report.per_capability['get_list']?.[0];
  assert.ok(entry);
  assert.equal(entry.params['q'].verdict, 'stable', 'q is stable (same caller args)');
  assert.equal(entry.params['xyz'].verdict, 'ambiguous');
});

test('overallSufficiency ladder', () => {
  assert.equal(sufficiencyMod.overallSufficiency(null), 'no_data');
  assert.equal(
    sufficiencyMod.overallSufficiency({
      endpoint: 'x',
      n_captures: 1,
      params: { a: { verdict: 'stable', value: '1' } },
    }),
    'no_data',
  );
  assert.equal(
    sufficiencyMod.overallSufficiency({
      endpoint: 'x',
      n_captures: 2,
      params: { a: { verdict: 'ambiguous', reason: 'too_few_captures' } },
    }),
    'needs_more_data',
  );
  assert.equal(
    sufficiencyMod.overallSufficiency({
      endpoint: 'x',
      n_captures: 3,
      params: { a: { verdict: 'stable', value: '1' } },
    }),
    'sufficient',
  );
});

test('bundle-history emits drift events when URL SHA changes', () => {
  const platform = 'bh-1';
  const url = 'https://cdn.example.com/main.js';
  writeSession(platform, 'sess_v1', {
    endedAt: Date.now() - 86_400_000 * 2,
    bundles: [{ url, sha256: 'aaa111', size: 1000 }],
  });
  writeSession(platform, 'sess_v1_again', {
    endedAt: Date.now() - 86_400_000,
    bundles: [{ url, sha256: 'aaa111', size: 1000 }],
  });
  writeSession(platform, 'sess_v2', {
    endedAt: Date.now(),
    bundles: [{ url, sha256: 'bbb222', size: 1050 }],
  });

  const report = recomputeBundleHistory(platform);
  assert.ok(report.per_url[url]);
  assert.equal(report.per_url[url].length, 2, 'two SHAs seen for this URL');
  assert.equal(report.drift_events.length, 1, 'one drift event');
  assert.equal(report.drift_events[0].prior_sha, 'aaa111');
  assert.equal(report.drift_events[0].new_sha, 'bbb222');
});

test('signer-history ranks anchors by session recurrence', () => {
  const platform = 'sh-1';
  // Same anchor visited in 3 of 3 sessions
  for (let i = 0; i < 3; i++) {
    writeSession(platform, `sess_${i}`, {
      endedAt: Date.now() + i * 1000,
      toolTrace: [
        {
          tool: 'read_js_function',
          args_digest: 'abc',
          outcome: 'ok',
          detail: { url: 'https://cdn.example.com/main.js', line: 1234 },
        },
      ],
    });
  }
  // Different anchor visited in 1 of 3
  writeSession(platform, 'sess_extra', {
    endedAt: Date.now() + 10_000,
    toolTrace: [
      {
        tool: 'search_js_source',
        args_digest: 'def',
        outcome: 'ok',
        detail: { url: 'https://cdn.example.com/other.js' },
      },
    ],
  });

  const report = recomputeSignerHistory(platform);
  assert.ok(report.anchors.length >= 2);
  // Top anchor must be the 3-session one.
  assert.equal(report.anchors[0].sessions, 3);
  assert.equal(report.anchors[0].line, 1234);
  assert.equal(report.anchors[0].url, 'https://cdn.example.com/main.js');
});

test('getPlatformLogbook returns compact summary + all derived signals', async () => {
  const klura = await import('../dist/index.js');
  const platform = 'pl-1';
  writeSession(platform, 'sess_only', {
    requests: [{ method: 'GET', url: 'https://api.example.com/x', headers: {}, postData: null, status: 200 }],
  });
  const result = klura.getPlatformLogbook({ platform });
  assert.ok(result.logbook);
  assert.equal(result.logbook.sessions_total, 1);
  assert.ok(result.field_stability);
  assert.ok(result.bundle_history);
  assert.ok(result.signer_history);
});
