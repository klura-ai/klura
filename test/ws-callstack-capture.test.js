// Unit test for the WS_SEND_CALLSTACK_SCRIPT init script. Runs the
// userscript inside a Node vm sandbox with a mock WebSocket so we can
// dispatch send() calls and assert the page-side capture buffer fills
// with the right shape — without booting a real browser.

import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pull the script body out of the compiled driver bundle. Keeps the test
// in lockstep with whatever the driver actually injects — no risk of
// asserting against a stale copy.
function loadCallstackScript() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'drivers', 'playwright.js'),
    'utf-8',
  );
  // The constant is emitted as a backtick-quoted template literal. Find
  // the script via the unique idempotency flag.
  const start = src.indexOf('window.__kluraSendCallstacksInstalled');
  assert.ok(start > 0, 'WS_SEND_CALLSTACK_SCRIPT not found in compiled output');
  // Scan backwards for the opening backtick (or quote) of the template literal.
  let openIdx = start;
  while (openIdx > 0 && src[openIdx] !== '`' && src[openIdx] !== '"') {
    openIdx -= 1;
  }
  // Scan forward for the matching close.
  const opener = src[openIdx];
  let closeIdx = openIdx + 1;
  while (closeIdx < src.length && src[closeIdx] !== opener) {
    if (src[closeIdx] === '\\') closeIdx += 2;
    else closeIdx += 1;
  }
  // Strip the quotes so we're left with the script body. For double-quoted
  // string literals we also need to unescape \n / \". Templates are raw.
  let body = src.slice(openIdx + 1, closeIdx);
  if (opener === '"') {
    body = body.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return body;
}

function makeSandbox() {
  // Mock the page-side globals the userscript expects: WebSocket prototype
  // with a send method, TextEncoder, performance.now indirectly via Date.
  let lastSent = null;
  function MockWebSocket(url) {
    this.url = url;
  }
  MockWebSocket.prototype.send = function (data) {
    lastSent = { thisRef: this, data };
  };
  // Reuse the real TextEncoder from the host node runtime; the userscript
  // uses it for utf-8 fingerprinting.
  const sandbox = {
    WebSocket: MockWebSocket,
    Date,
    Error,
    Object,
    Array,
    Number,
    Math,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    Blob: undefined, // not used in test fixtures
    console,
    get __getLastSent() {
      return lastSent;
    },
  };
  // Make the sandbox its own globalThis (vm.createContext does this).
  // The userscript references `window.*` directly, mirroring the browser
  // where window === globalThis. Expose `window` as a self-reference so
  // those reads resolve in the vm sandbox.
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function runScriptInSandbox(sandbox, script) {
  vm.runInContext(script, sandbox);
}

test('callstack-capture: idempotency flag prevents double-install', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const firstSend = sandbox.WebSocket.prototype.send;
  runScriptInSandbox(sandbox, script);
  const secondSend = sandbox.WebSocket.prototype.send;
  assert.strictEqual(firstSend, secondSend, 'second install should be a no-op');
  assert.strictEqual(sandbox.__kluraSendCallstacksInstalled, true);
});

test('callstack-capture: send() pushes a capture entry with stack + url + len', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  // Dispatch a send() — call goes through the wrapper.
  const ws = new sandbox.WebSocket('wss://example.com/socket');
  ws.send('hello');
  const captures = sandbox.__kluraSendCallstacks;
  assert.strictEqual(captures.length, 1);
  const e = captures[0];
  assert.strictEqual(e.idx, 0);
  assert.strictEqual(e.ws_url, 'wss://example.com/socket');
  assert.strictEqual(e.len, 5); // utf-8 bytes of "hello"
  assert.strictEqual(typeof e.head_hex, 'string');
  // 'hello' first 5 bytes are 0x68, 0x65, 0x6c, 0x6c, 0x6f.
  assert.strictEqual(e.head_hex, '68656c6c6f');
  assert.ok(typeof e.stack === 'string' && e.stack.length > 0, 'expected non-empty stack');
  assert.strictEqual(typeof e.ts, 'number');
});

test('callstack-capture: send() invokes the original send (chain preserved)', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const ws = new sandbox.WebSocket('wss://x');
  ws.send('payload');
  const lastSent = sandbox.__getLastSent;
  assert.strictEqual(lastSent.data, 'payload');
  assert.strictEqual(lastSent.thisRef.url, 'wss://x');
});

test('callstack-capture: ArrayBuffer payload fingerprints first 16 bytes', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const ws = new sandbox.WebSocket('wss://x');
  const ab = new ArrayBuffer(20);
  const view = new Uint8Array(ab);
  for (let i = 0; i < 20; i += 1) view[i] = 0x32 + i;
  ws.send(ab);
  const e = sandbox.__kluraSendCallstacks[0];
  assert.strictEqual(e.len, 20);
  // First 16 bytes: 0x32 0x33 0x34 ... 0x41
  assert.strictEqual(e.head_hex, '32333435363738393a3b3c3d3e3f4041');
});

test('callstack-capture: Uint8Array payload fingerprints correctly', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const ws = new sandbox.WebSocket('wss://x');
  const arr = new Uint8Array([0x32, 0xfd, 0x09, 0x00, 0x07]);
  ws.send(arr);
  const e = sandbox.__kluraSendCallstacks[0];
  assert.strictEqual(e.len, 5);
  assert.strictEqual(e.head_hex, '32fd090007');
});

test('callstack-capture: multiple sends accumulate, idx increments', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const ws = new sandbox.WebSocket('wss://x');
  ws.send('a');
  ws.send('b');
  ws.send('c');
  const captures = sandbox.__kluraSendCallstacks;
  assert.strictEqual(captures.length, 3);
  assert.strictEqual(captures[0].idx, 0);
  assert.strictEqual(captures[1].idx, 1);
  assert.strictEqual(captures[2].idx, 2);
});

test('callstack-capture: ring buffer cap evicts oldest beyond 4000', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const ws = new sandbox.WebSocket('wss://x');
  // Push past the cap. 4005 sends → buffer length should be 4000.
  for (let i = 0; i < 4005; i += 1) ws.send('x');
  const captures = sandbox.__kluraSendCallstacks;
  assert.strictEqual(captures.length, 4000);
});

test('encoder-capture: send() also stashes encoder side-channel keyed by ws_i', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const ws = new sandbox.WebSocket('wss://example.com/socket');
  ws.send('hello');
  const encoders = sandbox.__kluraSendEncoders;
  assert.strictEqual(typeof encoders, 'object');
  // Index 0 corresponds to the first send.
  assert.ok(encoders[0], 'expected encoder entry for ws_i=0');
  assert.strictEqual(encoders[0].ws, ws, 'encoder.ws should reference the same WebSocket instance');
  assert.strictEqual(encoders[0].sentArgs, 'hello');
  assert.strictEqual(encoders[0].ws_url, 'wss://example.com/socket');
  assert.strictEqual(encoders[0].len, 5);
});

test('encoder-capture: subsequent sends accumulate under increasing ws_i keys', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const ws = new sandbox.WebSocket('wss://x');
  ws.send('one');
  ws.send('two');
  ws.send('three');
  const encoders = sandbox.__kluraSendEncoders;
  assert.strictEqual(encoders[0].sentArgs, 'one');
  assert.strictEqual(encoders[1].sentArgs, 'two');
  assert.strictEqual(encoders[2].sentArgs, 'three');
});

test('encoder-capture: cap evicts oldest when over 2000 entries', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  const ws = new sandbox.WebSocket('wss://x');
  // Push past the cap
  for (let i = 0; i < 2050; i += 1) ws.send('msg' + i);
  const encoders = sandbox.__kluraSendEncoders;
  const keys = Object.keys(encoders);
  assert.strictEqual(keys.length, 2000, `expected 2000 encoders capped, got ${keys.length}`);
  // The oldest entries should have been evicted; the most recent should survive.
  assert.ok(encoders[2049], 'newest entry should still be present');
  assert.strictEqual(encoders[0], undefined, 'oldest entry should be evicted');
});

test('callstack-capture: stack contains the calling test fn name', () => {
  const sandbox = makeSandbox();
  const script = loadCallstackScript();
  runScriptInSandbox(sandbox, script);
  // Define a named function inside the sandbox so its name appears in
  // the captured stack — proves the capture grabs the real call chain,
  // not just the wrapper's own frame.
  const triggerScript = `
    function my_distinctive_fn_name() {
      const ws = new WebSocket('wss://x');
      ws.send('hi');
    }
    my_distinctive_fn_name();
  `;
  vm.runInContext(triggerScript, sandbox);
  const e = sandbox.__kluraSendCallstacks[0];
  assert.match(e.stack, /my_distinctive_fn_name/);
});
