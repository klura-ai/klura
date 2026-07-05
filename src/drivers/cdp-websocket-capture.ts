// Out-of-band WebSocket support over CDP — the tamper-free replacement for the
// page-level `window.WebSocket` / `WebSocket.prototype.send` init scripts the
// built-in driver used to inject (those made the page detectably automated).
//
// Everything here uses only CDP *pull* commands (Runtime.evaluate /
// queryObjects / callFunctionOn / releaseObject), which work on a Playwright
// CDPSession WITHOUT `Runtime.enable` — so we never emit the
// `executionContextCreated` signal that managed challenges fingerprint, and the
// page stays byte-identical to a normal browser.
//
// Sibling to cdp-network-capture.ts; same driver-agnostic `CDPLike` shape (the
// caller owns the session).

interface CDPLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface EvaluateResult {
  result?: { objectId?: string; value?: unknown };
}
interface QueryObjectsResult {
  objects?: { objectId?: string };
}

// Enumerate the page's live WebSocket instances via the heap (queryObjects on
// WebSocket.prototype), hand the resulting Array RemoteObject to `fn`, and
// release the transient handles afterward. Handles are execution-context
// scoped, so we never cache them across calls — each call re-resolves.
async function withLiveSocketArray<T>(
  cdp: CDPLike,
  fn: (arrayObjectId: string) => Promise<T>,
): Promise<T> {
  const proto = (await cdp.send('Runtime.evaluate', {
    expression: 'WebSocket.prototype',
  })) as EvaluateResult;
  const protoId = proto.result?.objectId;
  if (!protoId) throw new Error('cdp-websocket: could not resolve WebSocket.prototype');
  let arrId: string | undefined;
  try {
    const q = (await cdp.send('Runtime.queryObjects', {
      prototypeObjectId: protoId,
    })) as QueryObjectsResult;
    arrId = q.objects?.objectId;
    if (!arrId) throw new Error('cdp-websocket: queryObjects returned no array');
    return await fn(arrId);
  } finally {
    if (arrId) await cdp.send('Runtime.releaseObject', { objectId: arrId }).catch(() => {});
    await cdp.send('Runtime.releaseObject', { objectId: protoId }).catch(() => {});
  }
}

// True if the page has at least one OPEN WebSocket whose URL starts with
// `urlPrefix`. Mirrors the old registry scan's OPEN-only semantics (readyState
// 1); queryObjects can surface GC-uncollected CLOSED sockets, so the readyState
// filter is load-bearing.
export async function hasOpenSocket(cdp: CDPLike, urlPrefix: string): Promise<boolean> {
  return withLiveSocketArray(cdp, async (arrId) => {
    const r = (await cdp.send('Runtime.callFunctionOn', {
      objectId: arrId,
      functionDeclaration:
        'function(p){ return Array.from(this).some(w => w.readyState === 1 && String(w.url).indexOf(p) === 0); }',
      arguments: [{ value: urlPrefix }],
      returnByValue: true,
    })) as EvaluateResult;
    return r.result?.value === true;
  });
}

// Send `body` on the first OPEN WebSocket whose URL starts with `urlPrefix`.
// `encoding: 'binary'` treats `body` as base64 and reconstructs a Uint8Array in
// the page (mirrors the old page-script atob path) so we never ship an
// ArrayBuffer over CDP. Returns {ok:true} on send, {ok:false, error} otherwise.
export async function sendOnLiveSocket(
  cdp: CDPLike,
  urlPrefix: string,
  body: string,
  encoding: 'text' | 'binary',
): Promise<{ ok: boolean; error?: string }> {
  return withLiveSocketArray(cdp, async (arrId) => {
    const r = (await cdp.send('Runtime.callFunctionOn', {
      objectId: arrId,
      functionDeclaration: `function(prefix, body, enc) {
        const s = Array.from(this).find(w => w.readyState === 1 && String(w.url).indexOf(prefix) === 0);
        if (!s) return { ok: false, error: 'no OPEN WebSocket matching prefix ' + JSON.stringify(prefix) };
        try {
          if (enc === 'binary') {
            const bin = atob(body);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
            s.send(buf.buffer);
          } else {
            s.send(body);
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e && e.message ? e.message : String(e) };
        }
      }`,
      arguments: [{ value: urlPrefix }, { value: body }, { value: encoding }],
      returnByValue: true,
    })) as EvaluateResult;
    const value = r.result?.value as { ok: boolean; error?: string } | undefined;
    return value ?? { ok: false, error: 'callFunctionOn returned no value' };
  });
}
