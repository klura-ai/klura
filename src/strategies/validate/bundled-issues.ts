/**
 * If an `invalid_strategy:` message was pre-bundled by an inner validator
 * (matches `^<N> <topic> issues — fix all before retrying:\n - ...`), return
 * the inner issues as an array. Otherwise return null. Used by the outer
 * save-path bundler to flatten nested rejections so the agent sees one flat
 * issue list instead of "2 issues" containing a "4 issues" header as one of its
 * bullets.
 */
export function extractBundledIssues(body: string): string[] | null {
  const headerEnd = body.indexOf('\n');
  if (headerEnd < 0) return null;
  const header = body.slice(0, headerEnd);
  const marker = ' issues — fix all before retrying:';
  if (!header.includes(marker)) return null;
  const countEnd = header.indexOf(' ');
  if (countEnd <= 0) return null;
  const countText = header.slice(0, countEnd);
  for (const char of countText) {
    if (char < '0' || char > '9') return null;
  }
  const listBody = body.slice(headerEnd + 1);
  // Each inner bullet is exactly one `  - ...` line. Preserve trailing
  // continuation lines that don't start with `  - ` by folding them into
  // the previous bullet (some validators emit multi-line issue text).
  const lines = listBody.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('  - ')) {
      out.push(line.slice(4));
    } else if (line.length > 0 && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1] ?? ''}\n${line}`;
    }
  }
  return out.length > 0 ? out : null;
}
