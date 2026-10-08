// The fence a chat block rides in (ADR-0024): a fenced code block whose info
// string is `subrosa:<kind>`. Both shells and the web client read it the same.

export const CHAT_BLOCK_FENCE_PREFIX = "subrosa:";

/** The `<kind>` of a `subrosa:<kind>` fence info string, or null. */
export function chatBlockKindOf(info: string): string | null {
  const lang = info.trim().toLowerCase();
  if (!lang.startsWith(CHAT_BLOCK_FENCE_PREFIX)) return null;
  const kind = lang.slice(CHAT_BLOCK_FENCE_PREFIX.length).trim();
  return kind || null;
}
