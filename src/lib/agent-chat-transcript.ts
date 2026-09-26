import type { AgentChatPart, AgentChatTurn } from "./agent-chat-runtime";

// Sums turn/part counts plus streamed text lengths so the auto-scroll effect
// re-fires as streamed output grows, not only when a whole turn is added.
export function chatTurnsSignature(turns: AgentChatTurn[]) {
  return turns.reduce(
    (total, turn) =>
      total +
      1 +
      turn.parts.reduce(
        (size, part) =>
          size + 1 + ("text" in part && typeof part.text === "string" ? part.text.length : 0),
        0,
      ),
    0,
  );
}

// Collapse runs of "thinking-only" assistant turns (reasoning/tool, no answer
// text) into the next answer turn, so a back-to-back chain of thoughts shows as
// a single "Thought" disclosure rather than several stacked in a row.
export function mergeThinkingTurns(turns: AgentChatTurn[]): AgentChatTurn[] {
  const isThinkingOnly = (turn: AgentChatTurn): boolean =>
    turn.role === "assistant" &&
    turn.parts.length > 0 &&
    turn.parts.every((part) => part.type === "reasoning" || part.type === "tool");
  const rebuild = (turn: AgentChatTurn, parts: AgentChatPart[]): AgentChatTurn => ({
    id: turn.id,
    role: turn.role,
    createdAt: turn.createdAt,
    status: turn.status,
    parts,
  });

  const out: AgentChatTurn[] = [];
  let pending: AgentChatTurn | undefined;
  for (const turn of turns) {
    if (isThinkingOnly(turn)) {
      pending = pending === undefined ? turn : rebuild(turn, [...pending.parts, ...turn.parts]);
      continue;
    }
    if (turn.role === "assistant" && pending !== undefined) {
      out.push(rebuild(turn, [...pending.parts, ...turn.parts]));
      pending = undefined;
      continue;
    }
    if (pending !== undefined) {
      out.push(pending);
      pending = undefined;
    }
    out.push(turn);
  }
  if (pending !== undefined) out.push(pending);
  return out;
}

// The workspace-relative path the prompt names an attachment by.
export function attachmentPromptPath(path: string) {
  const workspaceMatch = path.match(/(?:^|[/\\])workspace[/\\](.+)$/);
  if (workspaceMatch?.[1]) return workspaceMatch[1];
  return path;
}

// Assigns each workspace file to the first turn that mentions it, so its
// download card renders once instead of at the end of every later response
// that happens to repeat the file name. User turns can claim a file too, using
// either the full artifact path or the workspace-relative path injected for
// attachments, so a file the user just handed us shouldn't bounce back as a
// download. Name-only matches are also deduplicated by name, so two workspace
// copies of the same file don't produce twin cards.
export function assignArtifactsToTurns<Artifact extends { name: string; path: string }>(
  turns: AgentChatTurn[],
  artifacts: Artifact[],
): Map<string, Artifact[]> {
  const byTurn = new Map<string, Artifact[]>();
  if (!artifacts.length) return byTurn;
  const claimedPaths = new Set<string>();
  const claimedNames = new Set<string>();
  for (const turn of turns) {
    const text = turn.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .toLowerCase();
    if (!text.trim()) continue;
    const mentioned: Artifact[] = [];
    for (const artifact of artifacts) {
      const name = artifact.name.toLowerCase();
      if (!name || claimedPaths.has(artifact.path)) continue;
      const pathMentioned =
        text.includes(artifact.path.toLowerCase()) ||
        text.includes(attachmentPromptPath(artifact.path).toLowerCase());
      const nameMentioned =
        turn.role === "assistant" && !claimedNames.has(name) && text.includes(name);
      if (!pathMentioned && !nameMentioned) continue;
      claimedPaths.add(artifact.path);
      claimedNames.add(name);
      if (turn.role === "assistant") mentioned.push(artifact);
    }
    if (mentioned.length) byTurn.set(turn.id, mentioned);
  }
  return byTurn;
}

/**
 * Keeps a rebuilt transcript's unchanged turns identical (`===`) to the ones
 * rendered last time. The transcript is rebuilt from scratch on every published
 * live frame, which minted a new object for every turn, so a memoized row
 * re-rendered (and re-parsed its markdown) for the whole conversation while
 * only the last turn was growing. Structural comparison stops at the first
 * difference; for an unchanged turn it walks the turn once, which costs far less
 * than rendering it.
 */
export type TurnIdentityCache = Map<string, AgentChatTurn>;

export function stabilizeTurns(cache: TurnIdentityCache, turns: AgentChatTurn[]): AgentChatTurn[] {
  const seen = new Set<string>();
  const stable = turns.map((turn) => {
    seen.add(turn.id);
    const previous = cache.get(turn.id);
    if (previous && sameData(previous, turn)) return previous;
    cache.set(turn.id, turn);
    return turn;
  });
  for (const id of [...cache.keys()]) {
    if (!seen.has(id)) cache.delete(id);
  }
  return stable;
}

/** The same for per-turn lists (a turn's artifacts), compared item by item. */
export function stabilizeLists<Item>(
  cache: Map<string, Item[]>,
  lists: Map<string, Item[]>,
): Map<string, Item[]> {
  const stable = new Map<string, Item[]>();
  for (const [key, list] of lists) {
    const previous = cache.get(key);
    const same =
      previous !== undefined &&
      previous.length === list.length &&
      previous.every((item, index) => item === list[index]);
    stable.set(key, same ? previous : list);
  }
  cache.clear();
  for (const [key, list] of stable) cache.set(key, list);
  return stable;
}

/** Structural equality for plain transcript data (objects, arrays, primitives). */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameData(item, b[index]));
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (keys.length !== otherKeys.length) return false;
  return keys.every((key) => sameData(left[key], right[key]));
}
