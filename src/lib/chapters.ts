// Reading the chapters back out of a long-form summary.
//
// The summary is markdown with the times already in its headings
// (`## [01:12:04] The pricing question`), which is what makes it searchable,
// exportable and readable by the agent with no special case (ADR-0027). The
// price of that choice is this parser — and its rule: if a heading does not
// look like a chapter, it is left alone rather than guessed at. A summary with
// no parseable chapters is still a correct summary.

export type Chapter = {
  /** Time into the recording, in milliseconds. */
  startMs: number;
  /** As written in the heading, e.g. "01:12:04". */
  label: string;
  title: string;
  /** Heading depth, so a nested chapter can be indented. */
  level: number;
};

/** `## [01:12:04] Title`, `# [05:30] Title`, `### [1:02:03] Title`. */
const CHAPTER_HEADING = /^(#{1,4})\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+?)\s*$/;

/** Parse `hh:mm:ss` or `mm:ss` into milliseconds. */
export function parseTimestamp(label: string): number | null {
  const parts = label.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const [hours, minutes, seconds] = numbers.length === 3 ? numbers : [0, numbers[0], numbers[1]];
  // Minutes and seconds above 59 mean the label was not a timestamp.
  if (numbers.length === 3 && (minutes > 59 || seconds > 59)) return null;
  if (numbers.length === 2 && seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/** Every timestamped heading in a summary, in document order. */
export function parseChapters(markdown: string | null | undefined): Chapter[] {
  if (!markdown) return [];
  const chapters: Chapter[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    // A heading inside a code fence is code, not a chapter.
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = CHAPTER_HEADING.exec(line);
    if (!match) continue;
    const startMs = parseTimestamp(match[2]);
    if (startMs === null) continue;
    const title = match[3].trim();
    if (!title) continue;
    chapters.push({ startMs, label: match[2], title, level: match[1].length });
  }
  return chapters;
}

/** The turn a chapter should scroll to: the first one that starts at or after
 * the chapter, falling back to the last turn before it when the chapter lands
 * past every turn. */
export function turnIdForTime<T extends { id: string; startMs?: number | null }>(
  turns: readonly T[],
  startMs: number,
): string | null {
  let fallback: string | null = null;
  for (const turn of turns) {
    if (typeof turn.startMs !== "number") continue;
    if (turn.startMs >= startMs) return turn.id;
    fallback = turn.id;
  }
  return fallback;
}
