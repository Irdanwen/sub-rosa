// Markdown made fit for a voice, and cut so playback starts fast.
//
// Shared by the spoken recap of a note (note-speech.ts) and "Read aloud" on a
// chat reply (reply-speech.ts). Headings become sentences, list markers and
// emphasis disappear, and what reads as noise out loud (a code block, a
// `subrosa:*` card's JSON, a pipe table) is either dropped or named in a few
// words, depending on the caller. A note drops them: a recap is prose. A
// reply names them, because the person may be listening without looking and
// should know there is something on screen to look at.
//
// Speech is billed per character and the first audio cannot play before its
// whole request has been rendered, so a reply is cut into chunks: a short
// first one (a sentence or two, seconds to render), then longer ones rendered
// while the previous one plays.

import { chatBlockKindOf } from "./chat-blocks";
import { t } from "./i18n";

export type SpeakableOptions = {
  /** What a fenced block becomes: nothing (`skip`), or a short spoken label. */
  fences?: "skip" | "label";
  /** What a pipe table becomes: nothing, or its cells read row by row. */
  tables?: "skip" | "cells";
};

/** The sentence spoken in place of a fenced block when labels are on. */
export function fenceLabel(info: string): string {
  switch (chatBlockKindOf(info)) {
    case "links":
      return t("There are links here.");
    case "places":
      return t("There are places here.");
    case "notes":
      return t("There are notes here.");
    case "chart":
      return t("There is a chart here.");
    case "table":
      return t("There is a table here.");
    case null:
      return t("There is some code here.");
    default:
      return t("There is a card here.");
  }
}

/** Markdown as sentences a voice can read, one block per line. */
export function speakableMarkdown(markdown: string, options: SpeakableOptions = {}): string {
  const fences = options.fences ?? "skip";
  const tables = options.tables ?? "skip";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let fenceInfo: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      if (fenceInfo === null) {
        fenceInfo = line.slice(3).trim();
        if (fences === "label") out.push(fenceLabel(fenceInfo));
      } else {
        fenceInfo = null;
      }
      continue;
    }
    if (fenceInfo !== null) continue;
    if (!line || /^([-*_])\1{2,}$/.test(line)) continue;
    if (line.startsWith("|")) {
      // The separator row (| --- | :-: |) is never content.
      if (tables === "skip" || /^\|[\s:|-]+\|?$/.test(line)) continue;
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => inline(cell))
        .filter(Boolean);
      if (cells.length) out.push(sentence(cells.join(", ")));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      // A heading is a sentence when spoken, so it gets a full stop and the
      // pause that comes with it.
      const text = inline(heading[1]);
      if (text) out.push(sentence(text));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    const body = quote ? quote[1] : line;
    const bullet = /^([-*+]|\d+[.)])\s+(.*)$/.exec(body);
    const text = inline(bullet ? bullet[2] : body);
    if (text) out.push(text);
  }
  return out.join("\n").trim();
}

function sentence(text: string): string {
  return /[.!?…:]$/.test(text) ? text : `${text}.`;
}

/** Strips the inline markup a voice cannot pronounce. */
function inline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hard stop on what one press of "Read aloud" can cost: about a quarter of
 * an hour of speech, longer than any reply has a right to be. */
export const MAX_SPOKEN_REPLY_CHARS = 15_000;

/** A chat reply as a voice reads it: cards and code named, tables read by
 * cell, capped. */
export function speakableReply(markdown: string): string {
  const spoken = speakableMarkdown(markdown, { fences: "label", tables: "cells" });
  return spoken.length > MAX_SPOKEN_REPLY_CHARS
    ? `${spoken.slice(0, MAX_SPOKEN_REPLY_CHARS).trimEnd()}…`
    : spoken;
}

/** The first chunk is short so the first sound comes in seconds; the next
 * ones are rendered while the previous one plays. */
export const FIRST_CHUNK_CHARS = 240;
export const CHUNK_CHARS = 1_200;

/**
 * Cuts spoken text into chunks at sentence ends (a line break counts as one),
 * never mid-word. A sentence longer than a chunk is cut at a space. Every
 * chunk is non-empty, and the chunks joined with spaces say everything the
 * text said.
 */
export function speechChunks(
  text: string,
  sizes: { first?: number; rest?: number } = {},
): string[] {
  const first = sizes.first ?? FIRST_CHUNK_CHARS;
  const rest = sizes.rest ?? CHUNK_CHARS;
  const sentences = text
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => splitLong(part, rest));
  const chunks: string[] = [];
  let current = "";
  for (const part of sentences) {
    const limit = chunks.length === 0 ? first : rest;
    if (current && current.length + 1 + part.length > limit) {
      chunks.push(current);
      current = part;
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(part: string, max: number): string[] {
  if (part.length <= max) return [part];
  const pieces: string[] = [];
  let remaining = part;
  while (remaining.length > max) {
    const cut = remaining.lastIndexOf(" ", max);
    const at = cut > max / 2 ? cut : max;
    pieces.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}
