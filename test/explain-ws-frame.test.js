// Unit tests for explainWsFrame — protocol detection + envelope parsing +
// nested-JSON detection + text-anchor location resolution.

import test from 'node:test';
import assert from 'node:assert';

const { explainWsFrame } = await import('../dist/response/ws-frame-explain.js');

// Build a synthetic MQTT PUBLISH frame: 0x32 + varint(len) + topic-len(2BE) +
// "/ls_req" + packetId(2BE) + body-JSON.
function buildMqttPublish(bodyStr) {
  const topic = '/ls_req';
  const topicLen = topic.length;
  const packetId = 52;
  const remaining = 2 + topicLen + 2 + bodyStr.length;
  const rlBytes = [];
  let rl = remaining;
  do {
    let b = rl & 0x7f;
    rl >>= 7;
    if (rl > 0) b |= 0x80;
    rlBytes.push(b);
  } while (rl > 0);
  const parts = [String.fromCharCode(0x32)];
  for (const b of rlBytes) parts.push(String.fromCharCode(b));
  parts.push(String.fromCharCode((topicLen >> 8) & 0xff, topicLen & 0xff));
  parts.push(topic);
  parts.push(String.fromCharCode((packetId >> 8) & 0xff, packetId & 0xff));
  parts.push(bodyStr);
  return parts.join('');
}

test('detects MQTT PUBLISH + parses envelope + finds text anchor + nested JSON', () => {
  const inner = {
    tasks: [{ label: '46', payload: JSON.stringify({ text: 'Hello world', thread_id: 123 }) }],
    epoch_id: '7451016486774112256',
    version_id: '26858603050401210',
  };
  const envelope = {
    app_id: '772021112871879',
    payload: JSON.stringify(inner),
    request_id: 99,
    type: 3,
  };
  const frame = buildMqttPublish(JSON.stringify(envelope));
  const out = explainWsFrame(frame, 'Hello world');
  assert.strictEqual(out.protocol.kind, 'mqtt_publish');
  assert.strictEqual(out.protocol.topic, '/ls_req');
  assert.ok(out.envelope);
  assert.strictEqual(out.envelope.parse_ok, true);
  assert.deepStrictEqual(out.envelope.keys_at_depth_1, ['app_id', 'payload', 'request_id', 'type']);
  assert.ok(out.envelope.nested_json_fields && out.envelope.nested_json_fields.length >= 1);
  assert.ok(out.envelope.literal_locations && out.envelope.literal_locations.length >= 1);
  const hasMqttHint = (out.hints ?? []).some((h) => h.includes('MQTT PUBLISH'));
  assert.ok(hasMqttHint);
});

test('plain JSON text frame detected as kind:json', () => {
  const frame = JSON.stringify({ op: 'subscribe', topic: 'foo' });
  const out = explainWsFrame(frame);
  assert.strictEqual(out.protocol.kind, 'json');
  assert.ok(out.envelope);
  assert.strictEqual(out.envelope.parse_ok, true);
  assert.deepStrictEqual(out.envelope.keys_at_depth_1, ['op', 'topic']);
});

test('gRPC-Web framing detected', () => {
  const body = 'hello';
  const len = body.length;
  const frame =
    String.fromCharCode(0x00) +
    String.fromCharCode((len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff) +
    body;
  const out = explainWsFrame(frame);
  assert.strictEqual(out.protocol.kind, 'grpc_web');
  assert.strictEqual(out.protocol.length, len);
  assert.strictEqual(out.protocol.payload_offset, 5);
});

test('raw fallback when nothing matches', () => {
  const frame = String.fromCharCode(0xff, 0xff, 0xff, 0xff);
  const out = explainWsFrame(frame);
  assert.strictEqual(out.protocol.kind, 'raw');
});

test('text_anchor absent when not found in envelope', () => {
  const frame = JSON.stringify({ op: 'ping' });
  const out = explainWsFrame(frame, 'not-in-body');
  assert.strictEqual(out.envelope?.literal_locations, undefined);
});
