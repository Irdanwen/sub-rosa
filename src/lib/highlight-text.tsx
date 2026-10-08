import type { ReactNode } from "react";

/** Wraps case-insensitive matches of `highlight` in <mark>, leaving the text
 * untouched when there's nothing to find. Every text emission point in the
 * markdown renderer funnels through here so find-in-file can light up
 * rendered documents, not just raw source. */
export function highlightText(
  text: string,
  highlight: string | undefined,
  keySeed: string,
): ReactNode[] {
  const needle = highlight?.toLowerCase();
  if (!needle) return [text];
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let count = 0;
  for (;;) {
    const at = lower.indexOf(needle, cursor);
    if (at < 0) break;
    if (at > cursor) nodes.push(text.slice(cursor, at));
    nodes.push(<mark key={`hl-${keySeed}-${count++}`}>{text.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
