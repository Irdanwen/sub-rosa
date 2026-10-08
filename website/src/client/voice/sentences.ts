/**
 * A streamed reply cut into sentences a voice can read, as they complete:
 * the browser's port of `voice/sentences.rs`. Fed the whole reply so far
 * each time, it keeps a cursor (how much was handed out, and whether that
 * point is inside a fenced block), so a retraction of unspoken text is
 * harmless. Headings, list markers, emphasis and link targets are dropped; a
 * fenced block is named once instead of read.
 */
import { VOICE } from "./constants";

export const MIN_SENTENCE_CHARS = VOICE.sentences.minChars;
export const MAX_SENTENCE_CHARS = VOICE.sentences.maxChars;

export interface SentenceCursor {
  consumed: number;
  inFence: boolean;
}
export const newCursor = (): SentenceCursor => ({ consumed: 0, inFence: false });

export type Spoken = { kind: "text"; text: string } | { kind: "fence"; info: string };

type Take =
  | { kind: "sentence"; length: number; text: string }
  | { kind: "fence"; before: string; beforeLength: number; info: string; markerLength: number }
  | { kind: "wait" };

const collect = (chars: string[]) => chars.join("");

export function nextSentences(reply: string, cursor: SentenceCursor, done: boolean): Spoken[] {
  const chars = Array.from(reply);
  const out: Spoken[] = [];
  // Retracted under what was already said: wait for it to grow back.
  if (cursor.consumed > chars.length) return out;
  while (true) {
    const rest = chars.slice(cursor.consumed);
    if (rest.length === 0) break;
    if (cursor.inFence) {
      const end = fenceClose(rest);
      if (end !== null) {
        cursor.consumed += end;
        cursor.inFence = false;
        continue;
      }
      if (done) cursor.consumed = chars.length;
      break;
    }
    const take = takeProse(rest, done);
    if (take.kind === "wait") break;
    if (take.kind === "sentence") {
      cursor.consumed += take.length;
      if (take.text) out.push({ kind: "text", text: take.text });
      continue;
    }
    if (take.before) out.push({ kind: "text", text: take.before });
    out.push({ kind: "fence", info: take.info });
    cursor.consumed += take.beforeLength + take.markerLength;
    cursor.inFence = true;
  }
  return out;
}

const isWhitespace = (character: string | undefined) => !!character && /\s/u.test(character);
const isAlphabetic = (character: string | undefined) => !!character && /\p{L}/u.test(character);
const isAlphanumeric = (character: string | undefined) =>
  !!character && /[\p{L}\p{N}]/u.test(character);

function takeProse(rest: string[], done: boolean): Take {
  let lineStart = 0;
  let lastSoftBreak: number | null = null;
  let lastSpace: number | null = null;
  let index = 0;
  while (index < rest.length) {
    if (index === lineStart) {
      const trimmed = skipIndent(rest, index);
      if (startsWith(rest, trimmed, "```") || startsWith(rest, trimmed, "~~~")) {
        const newline = findNewline(rest, trimmed);
        if (newline === null) {
          if (done)
            return {
              kind: "fence",
              before: clean(collect(rest.slice(0, index))),
              beforeLength: index,
              info: collect(rest.slice(trimmed + 3)).trim(),
              markerLength: rest.length - index,
            };
          return index > 0
            ? { kind: "sentence", length: index, text: clean(collect(rest.slice(0, index))) }
            : { kind: "wait" };
        }
        return {
          kind: "fence",
          before: clean(collect(rest.slice(0, index))),
          beforeLength: index,
          info: collect(rest.slice(trimmed + 3, newline)).trim(),
          markerLength: newline + 1 - index,
        };
      }
      if (trimmed < rest.length && rest[trimmed] === "`" && trimmed + 3 > rest.length && !done)
        return { kind: "wait" };
    }
    const character = rest[index];
    if (character === "\n") {
      const nextBlank = rest[index + 1] === "\n";
      const nextBlock = ["#", "-", "*", "+", ">", "|"].includes(rest[index + 1] ?? "");
      const text = clean(collect(rest.slice(0, index)));
      if ((nextBlank || nextBlock || endsSentence(text)) && text)
        return { kind: "sentence", length: index + 1, text };
      if (!text) return { kind: "sentence", length: index + 1, text: "" };
      lineStart = index + 1;
      lastSpace = index;
      index += 1;
      continue;
    }
    if (isTerminal(character)) {
      const followedBySpace = isWhitespace(rest[index + 1]);
      if (followedBySpace && !isAbbreviation(rest, index)) {
        const text = clean(collect(rest.slice(0, index + 1)));
        if (Array.from(text).length >= MIN_SENTENCE_CHARS)
          return { kind: "sentence", length: index + 1, text };
      }
    }
    if (character === "," || character === ";" || character === ":") lastSoftBreak = index;
    if (character === " ") lastSpace = index;
    if (index + 1 >= MAX_SENTENCE_CHARS) {
      const cut = lastSoftBreak ?? lastSpace;
      if (cut !== null && cut > 0)
        return { kind: "sentence", length: cut + 1, text: clean(collect(rest.slice(0, cut + 1))) };
    }
    index += 1;
  }
  if (done) return { kind: "sentence", length: rest.length, text: clean(collect(rest)) };
  return { kind: "wait" };
}

function skipIndent(rest: string[], from: number): number {
  let index = from;
  while (index < rest.length && index - from < 4 && rest[index] === " ") index += 1;
  return index;
}

function startsWith(rest: string[], at: number, pattern: string): boolean {
  return Array.from(pattern).every((expected, offset) => rest[at + offset] === expected);
}

function findNewline(rest: string[], from: number): number | null {
  for (let index = from; index < rest.length; index++) if (rest[index] === "\n") return index;
  return null;
}

/** Just past a fenced block's closing line, or null. */
function fenceClose(rest: string[]): number | null {
  let lineStart = 0;
  while (lineStart < rest.length) {
    const newline = findNewline(rest, lineStart);
    const trimmed = skipIndent(rest, lineStart);
    const lineEnd = newline ?? rest.length;
    const marker = startsWith(rest, trimmed, "```") || startsWith(rest, trimmed, "~~~");
    if (marker && !collect(rest.slice(trimmed + 3, lineEnd)).trim())
      return newline === null ? null : newline + 1;
    if (newline === null) return null;
    lineStart = newline + 1;
  }
  return null;
}

function isTerminal(character: string): boolean {
  return [".", "!", "?", "…", "。", "！", "？"].includes(character);
}

function endsSentence(text: string): boolean {
  const last = Array.from(text).at(-1);
  return !!last && (isTerminal(last) || last === ":");
}

const ABBREVIATIONS = [
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "st.",
  "no.",
  "p.",
  "m.",
  "mme.",
  "env.",
  "cf.",
  "ex.",
];

/** "e.g." and "Dr." end with a full stop, not a sentence. */
function isAbbreviation(rest: string[], dot: number): boolean {
  if (rest[dot] !== ".") return false;
  let start = dot;
  while (start > 0 && (isAlphabetic(rest[start - 1]) || rest[start - 1] === ".")) start -= 1;
  const word = collect(rest.slice(start, dot + 1)).toLowerCase();
  return ABBREVIATIONS.includes(word) || (Array.from(word).length === 2 && isAlphabetic(word[0]));
}

/** Markdown as a voice reads it: one line of plain words. */
export function clean(markdown: string): string {
  const lines: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^[-*_ ]+$/.test(line)) continue;
    if (line.startsWith("|")) {
      if (/^[|\-: ]+$/.test(line)) continue;
      const cells = line
        .replace(/^\|+|\|+$/g, "")
        .split("|")
        .map((cell) => inline(cell.trim()))
        .filter(Boolean);
      if (cells.length) lines.push(cells.join(", "));
      continue;
    }
    line = line.replace(/^#+/, "").trimStart();
    if (line.startsWith("> ")) line = line.slice(2);
    else if (line.startsWith(">")) line = line.slice(1);
    const bullet = /^[-*+] /.exec(line);
    if (bullet) line = line.slice(2);
    else {
      // "1. " or "1) ", read the way `split_once` reads it: at the first one.
      const dot = line.indexOf(". ");
      const at = dot >= 0 ? dot : line.indexOf(") ");
      if (at > 0 && /^[0-9]+$/.test(line.slice(0, at))) line = line.slice(at + 2);
    }
    const text = inline(line);
    if (text) lines.push(text);
  }
  return lines.join(" ").trim();
}

/** Strips the inline markup a voice cannot pronounce. */
function inline(text: string): string {
  const chars = Array.from(text);
  let out = "";
  let index = 0;
  while (index < chars.length) {
    const character = chars[index];
    const image = character === "!" && chars[index + 1] === "[";
    if (character === "[" || image) {
      const open = image ? index + 1 : index;
      const close = chars.indexOf("]", open);
      if (close >= 0 && chars[close + 1] === "(") {
        const end = chars.indexOf(")", close + 1);
        if (end >= 0) {
          if (!image) out += collect(chars.slice(open + 1, close));
          index = end + 1;
          continue;
        }
      }
    }
    if (character === "<") {
      const end = chars.indexOf(">", index);
      if (end >= 0) {
        const first = chars[index + 1];
        if (first && (/[A-Za-z]/.test(first) || first === "/")) {
          out += " ";
          index = end + 1;
          continue;
        }
      }
    }
    if (character === "*" || character === "`" || character === "~") {
      index += 1;
      continue;
    }
    if (
      character === "_" &&
      (index === 0 ||
        index + 1 === chars.length ||
        !isAlphanumeric(chars[index - 1]) ||
        !isAlphanumeric(chars[index + 1]))
    ) {
      index += 1;
      continue;
    }
    out += character;
    index += 1;
  }
  return out.split(/\s+/).filter(Boolean).join(" ");
}
