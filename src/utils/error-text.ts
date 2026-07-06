// Turn any thrown value into a non-empty, human-readable string.
//
// The naive `err instanceof Error ? err.message : String(err)` leaks the empty
// string when an Error carries no message (`new Error()`, an aborted operation,
// a library error whose message was stripped). An empty error surfaced to the
// agent reads as an inexplicable crash — it can't diagnose "" — so the outermost
// serialization boundaries (the daemon HTTP catch, tool-result envelopes) route
// through here to guarantee something actionable always comes out.
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message.trim();
    if (msg) return msg;
    // No usable message — name the error's shape so the agent at least learns
    // its type (AbortError, TimeoutError, …). A message-less Error's stack top
    // line is just its name, so there is nothing more to salvage there.
    const name = err.name.trim() || 'Error';
    return `${name} (no message)`;
  }
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err === 'object' || typeof err === 'function') {
    // A non-Error object/function — try JSON so the agent sees its fields; fall
    // back to a typed label rather than the useless '[object Object]'.
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}' && json !== 'null') return json;
    } catch {
      /* circular or non-serializable */
    }
    return `unknown error (${typeof err})`;
  }
  // Remaining primitives, each stringified by its own (non-object) toString.
  if (typeof err === 'string') return err.trim() || 'unknown error (empty string)';
  if (typeof err === 'symbol') return err.toString();
  if (typeof err === 'number' || typeof err === 'bigint' || typeof err === 'boolean') {
    return String(err);
  }
  return `unknown error (${typeof err})`;
}
