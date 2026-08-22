/**
 * The spoken recap: a note, read out loud.
 *
 * The evening commute is the moment this exists for — which is why playback
 * has to survive a locked screen (iOS already carries `UIBackgroundModes:
 * audio` for recording), and why the text handed to the model is the note's
 * prose with its markdown scaffolding stripped: nobody wants to hear "hash
 * hash Decisions, dash".
 *
 * Speech is billed per character, so the text is capped before it is sent and
 * the audio is cached in memory for the session — pressing play twice on the
 * same note must not pay twice.
 */

import { fetchMediaCatalog, modelsOfType } from "./studio/catalog";
import { SPEECH_INPUT_LIMIT, generateSpeech } from "./studio/speech";

/** Hard stop on what one press of play can cost. Roughly ten minutes of
 * speech, which is longer than any recap has a right to be. */
const MAX_SPOKEN_CHARS = Math.min(SPEECH_INPUT_LIMIT, 4_000);

/**
 * Turns a generated note into something worth hearing: headings become
 * sentences, list markers and emphasis disappear, code blocks and tables are
 * dropped outright (reading a pipe table aloud is noise).
 */
export function speakableText(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line || /^([-*_])\1{2,}$/.test(line)) continue;
    // Tables read as gibberish out loud.
    if (line.startsWith("|")) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      // A heading is a sentence when spoken, so it gets a full stop and the
      // pause that comes with it.
      const text = inline(heading[1]);
      if (text) out.push(text.endsWith(".") ? text : `${text}.`);
      continue;
    }
    const bullet = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const text = inline(bullet ? bullet[2] : line);
    if (text) out.push(text);
  }
  const spoken = out.join("\n").trim();
  return spoken.length > MAX_SPOKEN_CHARS
    ? `${spoken.slice(0, MAX_SPOKEN_CHARS).trimEnd()}…`
    : spoken;
}

/** Strips the inline markup a voice cannot pronounce. */
function inline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Audio already paid for, this session. Keyed by note id + text, so an edit
 * re-renders but a second press does not. */
const cache = new Map<string, string>();

function cacheKey(noteId: string, text: string): string {
  // Cheap, stable, and enough to notice an edit.
  return `${noteId}:${text.length}:${text.slice(0, 64)}`;
}

/**
 * Renders (or returns) a playable object URL for a note's recap.
 *
 * Blob URL, never a data: URL — WKWebView byte-range-requests media sources
 * and leaves a `data:` audio element silent (the same trap the gallery hit).
 */
export async function noteSpeechUrl(
  noteId: string,
  markdown: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | null> {
  const text = speakableText(markdown);
  if (!text) return null;
  const key = cacheKey(noteId, text);
  const cached = cache.get(key);
  if (cached) return cached;

  const catalog = await fetchMediaCatalog();
  const model = modelsOfType(catalog, "tts")[0];
  if (!model) return null;

  const { base64, contentType } = await generateSpeech({
    model: model.id,
    input: text,
    signal: options.signal,
  });
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType || "audio/mpeg" }));
  cache.set(key, url);
  return url;
}
