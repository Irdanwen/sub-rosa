/**
 * Search over what this tab decrypted: notes for `search_notes`, memories for
 * `search_memories`. The service has no index and never will (it cannot read
 * the notes); this one lives in the tab's memory and goes with it.
 *
 * Every word of the query must appear (in the title or the body), as in the
 * app's keyword search, and a note answers with a window around its first
 * match rather than its whole text, so `read_note` stays the way to read one.
 */
import type { Memory, Note } from "./library";

export interface NoteSnippet {
  noteId: string;
  title: string;
  kind: "note";
  snippet: string;
  updatedAt: string;
}

const WINDOW_CHARS = 700;

function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function words(query: string): string[] {
  return fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

/** A window of `max` characters around the first match, or the head. */
export function snippetAround(content: string, word: string, max = WINDOW_CHARS): string {
  const trimmed = content.trim();
  if (trimmed.length <= max) return trimmed;
  const at = word ? fold(trimmed).indexOf(word) : -1;
  if (at < 0) return `${trimmed.slice(0, max)}…`;
  const start = Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(trimmed.length, start + max);
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

export function searchNotes(notes: Note[], query: string, limit: number): NoteSnippet[] {
  const wanted = words(query);
  if (!wanted.length) return [];
  const scored: { note: Note; score: number; first: string }[] = [];
  for (const note of notes) {
    const title = fold(note.title);
    const body = fold(note.body);
    if (!wanted.every((word) => title.includes(word) || body.includes(word))) continue;
    const score = wanted.reduce(
      (sum, word) => sum + (title.includes(word) ? 3 : 0) + body.split(word).length - 1,
      0,
    );
    scored.push({ note, score, first: wanted.find((word) => body.includes(word)) ?? "" });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt))
    .slice(0, limit)
    .map(({ note, first }) => ({
      noteId: note.id,
      title: note.title,
      kind: "note",
      snippet: snippetAround(note.body, first),
      updatedAt: note.updatedAt,
    }));
}

/** Memories that share a word with the query, most matching first. */
export function searchMemories(memories: Memory[], query: string, limit: number): Memory[] {
  const wanted = words(query);
  if (!wanted.length) return [];
  return memories
    .map((memory) => ({
      memory,
      score: wanted.filter((word) => fold(memory.text).includes(word)).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.memory.importance - b.memory.importance)
    .slice(0, limit)
    .map((entry) => entry.memory);
}
