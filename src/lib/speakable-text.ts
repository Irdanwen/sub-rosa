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

import {
  speakableReply as speakableReplyWith,
  type SpeakableOptions,
  speakableMarkdown as speakableMarkdownWith,
} from "@subrosa/chat-core/speakable-text";
import { chatBlockKindOf } from "./chat-blocks";
import { t } from "./i18n";

export {
  CHUNK_CHARS,
  FIRST_CHUNK_CHARS,
  MAX_SPOKEN_REPLY_CHARS,
  type SpeakableOptions,
  speechChunks,
} from "@subrosa/chat-core/speakable-text";

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
  return speakableMarkdownWith(markdown, { fenceLabel, ...options });
}

/** A chat reply as a voice reads it: cards and code named, tables read by
 * cell, capped. */
export function speakableReply(markdown: string): string {
  return speakableReplyWith(markdown, fenceLabel);
}
