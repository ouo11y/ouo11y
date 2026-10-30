/** Text helpers shared by the records that carry user or app text (feedback, `ouo.last_events`). */

/**
 * The bridge's cut (Go `truncate`): a string longer than `maxBytes` in UTF-8 keeps its longest
 * prefix of whole code points that fits in `maxBytes`, followed by "…".
 */
export function cutUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) return `${s.slice(0, end)}…`;
    bytes += n;
    end += ch.length;
  }
  return s;
}
