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

import { speakableMarkdown } from "./speakable-text";
import { SPEECH_INPUT_LIMIT } from "./studio/speech";
import { renderPreferredSpeech, voicePreferenceKey } from "./voice-preference";

/** Hard stop on what one press of play can cost. Roughly ten minutes of
 * speech, which is longer than any recap has a right to be. */
const MAX_SPOKEN_CHARS = Math.min(SPEECH_INPUT_LIMIT, 4_000);

/**
 * Turns a generated note into something worth hearing: headings become
 * sentences, list markers and emphasis disappear, code blocks and tables are
 * dropped outright (reading a pipe table aloud is noise). The stripping is
 * shared with "Read aloud" on a chat reply (speakable-text.ts).
 */
export function speakableText(markdown: string): string {
  const spoken = speakableMarkdown(markdown);
  return spoken.length > MAX_SPOKEN_CHARS
    ? `${spoken.slice(0, MAX_SPOKEN_CHARS).trimEnd()}…`
    : spoken;
}

/** Audio already paid for, this session. Keyed by note id + text + voice, so
 * an edit or another voice re-renders but a second press does not. */
const cache = new Map<string, string>();

function cacheKey(noteId: string, text: string): string {
  // Cheap, stable, and enough to notice an edit.
  return `${noteId}:${text.length}:${text.slice(0, 64)}:${voicePreferenceKey()}`;
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

  // A recap read aloud now, so the one-call rail only: a queued voice-over
  // takes minutes, and this plays while the note is open (ADR-0076). The
  // voice is the one chosen in Settings, shared with Read aloud on a reply.
  let url: string;
  try {
    url = await renderPreferredSpeech(text, { signal: options.signal });
  } catch (error) {
    if (error instanceof Error && error.message === "no speech model") return null;
    throw error;
  }
  cache.set(key, url);
  return url;
}
