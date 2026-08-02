/**
 * Shot chains: the sequence a clip belongs to, rebuilt from the parent links
 * carried on each gallery entry.
 *
 * A chain is not stored as a list anywhere. Each shot only knows the clip it
 * continues (`parentId`) and where it took over (`parentHandoffSeconds`), which
 * is what makes the structure survive anything: deleting a clip in the middle
 * breaks its chain in two rather than corrupting a list, and a render that
 * finished while the app was closed joins its chain the moment it is indexed.
 *
 * Ordering is oldest shot first, the order they would be watched in.
 */

import type { StudioArtifact } from "./types";

/** One shot in a chain, with the cut the next shot implies. */
export interface ChainShot {
  artifact: StudioArtifact;
  /** Where this shot is cut, in seconds: the point its successor took over.
   * Undefined on the last shot, which plays to its end. */
  outSeconds?: number;
}

function byIdOf(artifacts: readonly StudioArtifact[]): Map<string, StudioArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

/** Children per parent, newest first: a shot can be continued more than once,
 * and the branch the user is working on is the one they just made. */
function childrenOf(artifacts: readonly StudioArtifact[]): Map<string, StudioArtifact[]> {
  const children = new Map<string, StudioArtifact[]>();
  for (const artifact of artifacts) {
    if (!artifact.parentId) continue;
    const siblings = children.get(artifact.parentId);
    if (siblings) siblings.push(artifact);
    else children.set(artifact.parentId, [artifact]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => b.createdAt - a.createdAt);
  }
  return children;
}

/**
 * The whole chain the artifact belongs to, oldest first.
 *
 * Walks up to the first shot, then down the most recent branch at every fork.
 * A missing parent (deleted clip, index lost across a reinstall) simply ends
 * the walk: the chain starts at the oldest shot still on disk. Cycles cannot
 * happen through the UI but would hang the walk, so they are cut explicitly.
 */
export function chainOf(
  artifact: StudioArtifact,
  artifacts: readonly StudioArtifact[],
): StudioArtifact[] {
  const byId = byIdOf(artifacts);
  const children = childrenOf(artifacts);

  const seen = new Set<string>([artifact.id]);
  const before: StudioArtifact[] = [];
  let cursor = artifact;
  while (cursor.parentId) {
    const parent = byId.get(cursor.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    before.unshift(parent);
    cursor = parent;
  }

  const after: StudioArtifact[] = [];
  cursor = artifact;
  for (;;) {
    const next = children.get(cursor.id)?.find((child) => !seen.has(child.id));
    if (!next) break;
    seen.add(next.id);
    after.push(next);
    cursor = next;
  }

  return [...before, artifact, ...after];
}

/** True when the artifact is part of a chain of more than one shot. */
export function isChained(artifact: StudioArtifact, artifacts: readonly StudioArtifact[]): boolean {
  if (artifact.parentId && artifacts.some((entry) => entry.id === artifact.parentId)) return true;
  return artifacts.some((entry) => entry.parentId === artifact.id);
}

/**
 * The chain as a cut list: every shot but the last is trimmed at the point its
 * successor took over, so the half second the next shot re-renders is not
 * played twice. That trim is what lets the handoff be taken before the very
 * end (cutting on movement) instead of on the last, blurred frame.
 */
export function chainCuts(chain: readonly StudioArtifact[]): ChainShot[] {
  return chain.map((artifact, index) => {
    const next = chain[index + 1];
    const handoff = next?.parentHandoffSeconds;
    // Only trim on a real link: a successor that continues a different clip
    // (or an entry whose handoff point was never recorded) leaves this shot
    // playing to its end.
    const linked = next?.parentId === artifact.id && typeof handoff === "number" && handoff > 0;
    return linked ? { artifact, outSeconds: handoff } : { artifact };
  });
}

/**
 * The shot a chain's look should be anchored to: its first one. Sending it
 * along as a reference is what keeps a face from drifting over four or five
 * generations, each of which only ever sees its immediate predecessor.
 */
export function anchorOf(chain: readonly StudioArtifact[]): StudioArtifact | undefined {
  return chain[0];
}

/**
 * What the chain has cost so far, in credits, and how much of it is actually
 * known. Shots rendered before prices were recorded (or adopted from disk
 * without an index entry) have no figure, so the caller can say "at least N"
 * rather than quietly under-reporting a total.
 */
export function chainCost(chain: readonly StudioArtifact[]): {
  credits: number;
  known: number;
  total: number;
} {
  let credits = 0;
  let known = 0;
  for (const shot of chain) {
    if (typeof shot.costCredits === "number" && Number.isFinite(shot.costCredits)) {
      credits += shot.costCredits;
      known += 1;
    }
  }
  return { credits, known, total: chain.length };
}

/**
 * How many other continuations a shot has that this chain does not follow.
 *
 * Nothing is ever edited in place: continuing the same shot twice makes a new
 * branch rather than replacing anything. Surfacing the count is what keeps a
 * discarded take from looking like it vanished.
 */
export function alternativeCount(
  shot: StudioArtifact,
  chain: readonly StudioArtifact[],
  artifacts: readonly StudioArtifact[],
): number {
  const followed = chain[chain.indexOf(shot) + 1]?.id;
  return artifacts.filter((entry) => entry.parentId === shot.id && entry.id !== followed).length;
}
