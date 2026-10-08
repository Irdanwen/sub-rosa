/**
 * "Ask Sub Rosa" on a selection: the passage goes to the chat as a quote.
 *
 * The selection lives in a note (or a canvas), the composer lives in the chat,
 * and on the phone they are on different tabs. So the toolbar dispatches one
 * window event, each shell's root brings the chat forward, and the composer
 * takes the quote, whether it was already on screen or mounts a moment later.
 * The quote waits here until one composer takes it, so it lands exactly once.
 */

export const ASK_ABOUT_SELECTION_EVENT = "subrosa:ask-about-selection";

/** A quote is context for a question, not the document: past this it is cut. */
export const MAX_QUOTE_CHARS = 4_000;

let pending: string | null = null;

/** The selection as a markdown quote, followed by a blank line to type in. */
export function quoteSelection(text: string): string {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (!trimmed) return "";
  const capped =
    trimmed.length > MAX_QUOTE_CHARS ? `${trimmed.slice(0, MAX_QUOTE_CHARS - 1)}…` : trimmed;
  const quoted = capped
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

export function askAboutSelection(text: string) {
  const quote = quoteSelection(text);
  if (!quote) return;
  pending = quote;
  window.dispatchEvent(new CustomEvent(ASK_ABOUT_SELECTION_EVENT, { detail: { quote } }));
}

/** The quote waiting for a composer, handed over once. */
export function takePendingQuote(): string | null {
  const quote = pending;
  pending = null;
  return quote;
}
