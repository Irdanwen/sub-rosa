// How full a conversation is, against the model's context window: a rough
// reading for a ring in the chat, not a meter for billing. A model forgets
// the start of a long chat or refuses it outright, and the gauge is how the
// user sees that coming and starts a new chat first.
//
// Characters divided by four is the usual estimate for English and close
// enough for the languages the app speaks; the allowance covers what every
// turn carries besides the messages (the system prompt, the remembered facts
// and the tool declarations).

/** Characters per token, on average. */
export const CHARS_PER_TOKEN = 4;
/** What every turn sends besides the conversation: the system prompt, the
 * memory block and the tool declarations. */
export const SYSTEM_ALLOWANCE_TOKENS = 4000;
/** Past this share of the window the gauge warns and suggests a new chat. */
export const CONTEXT_WARNING_RATIO = 0.8;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type ContextGaugeReading = {
  used: number;
  total: number;
  /** used / total, clamped to [0, 1]. */
  ratio: number;
  tone: "normal" | "warning";
};

/** The reading for a conversation, or `null` when the model's window is not
 * known (the ring is then not drawn rather than drawn wrong). */
export function readContextGauge({
  messages,
  draft = "",
  contextTokens,
}: {
  messages: readonly { content: string }[];
  /** What is typed but not sent yet: it will be part of the next turn. */
  draft?: string;
  contextTokens: number | undefined;
}): ContextGaugeReading | null {
  if (!contextTokens || contextTokens <= 0) return null;
  const used =
    SYSTEM_ALLOWANCE_TOKENS +
    messages.reduce((sum, message) => sum + estimateTokens(message.content), 0) +
    estimateTokens(draft);
  const ratio = Math.min(1, used / contextTokens);
  return {
    used,
    total: contextTokens,
    ratio,
    tone: ratio > CONTEXT_WARNING_RATIO ? "warning" : "normal",
  };
}

/** A token count as a person reads it: 950, 12K, 1.2M. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 999_500) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(Math.round(tokens));
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
