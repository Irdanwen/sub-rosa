/** One `agent-lite://delta` event: `text` to append to the reply shown so
 * far, after taking back its last `retract` UTF-16 code units. A retraction
 * comes alone (`text` empty) when a streamed attempt broke and is about to be
 * replayed, so the replay does not print the same words twice. */
export interface AgentLiteDeltaDto {
  taskId: string;
  text: string;
  retract?: number;
}

export function applyAgentLiteDelta(shown: string, delta: AgentLiteDeltaDto): string {
  const retract = Math.max(0, delta.retract ?? 0);
  const kept = retract > 0 ? shown.slice(0, Math.max(0, shown.length - retract)) : shown;
  return kept + delta.text;
}
