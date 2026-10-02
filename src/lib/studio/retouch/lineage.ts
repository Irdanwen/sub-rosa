// A retouch session is a tree of gallery images: the original at the root,
// every version pointing at the one it was made from (`edit.of`). Nothing is
// stored about the tree itself; it is read back from the artifacts, so a
// version that landed while the app was closed joins its session on its own.

import type { RetouchLineage, RetouchOperation, StudioArtifact } from "../types";

export interface RetouchSession {
  root: StudioArtifact;
  /** The original first, then every version oldest first. */
  versions: StudioArtifact[];
  byId: Map<string, StudioArtifact>;
}

/** The original an image belongs to: itself unless it is a version. */
export function rootIdOf(artifact: StudioArtifact): string {
  return artifact.edit?.root ?? artifact.id;
}

/** Version number shown to the person: 0 for the original. */
export function versionNumber(artifact: StudioArtifact): number {
  return artifact.edit?.n ?? 0;
}

/** The session rooted at `rootId`, or undefined when the original is gone and
 * no version survives either. A missing original is replaced by the oldest
 * surviving version, which then stands as the root. */
export function sessionOf(artifacts: StudioArtifact[], rootId: string): RetouchSession | undefined {
  const versions = artifacts
    .filter((artifact) => artifact.kind === "image" && artifact.edit?.root === rootId)
    .sort((a, b) => a.createdAt - b.createdAt || versionNumber(a) - versionNumber(b));
  const original = artifacts.find((artifact) => artifact.id === rootId);
  const root = original ?? versions[0];
  if (!root) return undefined;
  const ordered = [root, ...versions.filter((version) => version.id !== root.id)];
  return { root, versions: ordered, byId: new Map(ordered.map((entry) => [entry.id, entry])) };
}

/** The version `id` was made from. A parent deleted since falls back to the
 * root, so a branch stays reachable. */
export function parentOf(session: RetouchSession, id: string): StudioArtifact | undefined {
  if (id === session.root.id) return undefined;
  const version = session.byId.get(id);
  if (!version) return undefined;
  const parent = version.edit ? session.byId.get(version.edit.of) : undefined;
  return parent && parent.id !== id ? parent : session.root;
}

/** Versions made directly from `id`, oldest first. */
export function childrenOf(session: RetouchSession, id: string): StudioArtifact[] {
  return session.versions.filter(
    (version) => version.id !== session.root.id && parentOf(session, version.id)?.id === id,
  );
}

/** The root, then each version down to `id`. */
export function pathTo(session: RetouchSession, id: string): StudioArtifact[] {
  const path: StudioArtifact[] = [];
  const seen = new Set<string>();
  let current = session.byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = parentOf(session, current.id);
  }
  return path;
}

/** One past the highest version number in the session. */
export function nextVersionNumber(session: RetouchSession): number {
  return session.versions.reduce((max, version) => Math.max(max, versionNumber(version)), 0) + 1;
}

/** Where undo goes: the version this one was made from. */
export function undoTarget(session: RetouchSession, id: string): StudioArtifact | undefined {
  return parentOf(session, id);
}

/** Where redo goes: the child last left by undo when there is one, else the
 * newest child. */
export function redoTarget(
  session: RetouchSession,
  id: string,
  preferredChildId?: string,
): StudioArtifact | undefined {
  const children = childrenOf(session, id);
  return children.find((child) => child.id === preferredChildId) ?? children.at(-1);
}

/** The lineage of a new version made from `parent`. */
export function lineageFor(
  session: RetouchSession,
  parent: StudioArtifact,
  op: RetouchOperation,
  n: number,
  extra: Omit<RetouchLineage, "of" | "root" | "op" | "n"> = {},
): RetouchLineage {
  return { ...extra, of: parent.id, root: session.root.id, op, n };
}

export interface RetouchSessionSummary {
  rootId: string;
  latest: StudioArtifact;
  versionCount: number;
}

/** Every session in the gallery, most recently touched first. An image with
 * no versions is not a session yet. */
export function sessionsIn(artifacts: StudioArtifact[]): RetouchSessionSummary[] {
  const byRoot = new Map<string, RetouchSessionSummary>();
  for (const artifact of artifacts) {
    if (artifact.kind !== "image" || !artifact.edit) continue;
    const current = byRoot.get(artifact.edit.root);
    if (!current) {
      byRoot.set(artifact.edit.root, {
        rootId: artifact.edit.root,
        latest: artifact,
        versionCount: 1,
      });
      continue;
    }
    current.versionCount += 1;
    if (artifact.createdAt > current.latest.createdAt) current.latest = artifact;
  }
  return [...byRoot.values()].sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}
