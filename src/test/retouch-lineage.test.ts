import { describe, expect, it } from "vitest";
import {
  childrenOf,
  lineageFor,
  nextVersionNumber,
  parentOf,
  pathTo,
  redoTarget,
  rootIdOf,
  sessionOf,
  sessionsIn,
  undoTarget,
} from "../lib/studio/retouch/lineage";
import type { RetouchLineage, StudioArtifact } from "../lib/studio/types";

let clock = 1000;
function image(
  id: string,
  edit?: Omit<RetouchLineage, "root"> & { root?: string },
): StudioArtifact {
  clock += 10;
  return {
    id,
    kind: "image",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1,
    model: "ideogram-v4-5-edit",
    prompt: id,
    createdAt: clock,
    ...(edit ? { edit: { root: "root.png", ...edit } } : {}),
  };
}

// root ─ v1 ─ v2
//          └─ v3 (a branch made from v1 after an undo)
function tree() {
  const root = image("root.png");
  const v1 = image("v1.png", { of: "root.png", op: "prompt", n: 1 });
  const v2 = image("v2.png", { of: "v1.png", op: "prompt", n: 2 });
  const v3 = image("v3.png", { of: "v1.png", op: "zone", n: 3 });
  const unrelated = image("other.png");
  return { root, v1, v2, v3, unrelated, all: [unrelated, v3, root, v2, v1] };
}

describe("a retouch session", () => {
  it("collects the original and its versions, oldest first", () => {
    const { all } = tree();
    const session = sessionOf(all, "root.png");
    expect(session?.versions.map((version) => version.id)).toEqual([
      "root.png",
      "v1.png",
      "v2.png",
      "v3.png",
    ]);
  });

  it("knows each version's parent and children, branches included", () => {
    const { all } = tree();
    const session = sessionOf(all, "root.png");
    if (!session) throw new Error("no session");
    expect(parentOf(session, "root.png")).toBeUndefined();
    expect(parentOf(session, "v3.png")?.id).toBe("v1.png");
    expect(childrenOf(session, "v1.png").map((child) => child.id)).toEqual(["v2.png", "v3.png"]);
    expect(pathTo(session, "v2.png").map((step) => step.id)).toEqual([
      "root.png",
      "v1.png",
      "v2.png",
    ]);
  });

  it("undoes to the parent and redoes to the branch it left, else the newest", () => {
    const { all } = tree();
    const session = sessionOf(all, "root.png");
    if (!session) throw new Error("no session");
    expect(undoTarget(session, "v2.png")?.id).toBe("v1.png");
    expect(redoTarget(session, "v1.png", "v2.png")?.id).toBe("v2.png");
    expect(redoTarget(session, "v1.png")?.id).toBe("v3.png");
    expect(redoTarget(session, "v3.png")).toBeUndefined();
  });

  it("numbers the next version past the highest one", () => {
    const { all } = tree();
    const session = sessionOf(all, "root.png");
    if (!session) throw new Error("no session");
    expect(nextVersionNumber(session)).toBe(4);
    expect(lineageFor(session, session.byId.get("v2.png") as StudioArtifact, "upscale", 4)).toEqual(
      {
        of: "v2.png",
        root: "root.png",
        op: "upscale",
        n: 4,
      },
    );
  });

  it("keeps a branch reachable when a version in the middle is deleted", () => {
    const { root, v2, v3 } = tree();
    const session = sessionOf([root, v2, v3], "root.png");
    if (!session) throw new Error("no session");
    expect(parentOf(session, "v2.png")?.id).toBe("root.png");
    expect(childrenOf(session, "root.png").map((child) => child.id)).toEqual(["v2.png", "v3.png"]);
  });

  it("stands the oldest version in for a deleted original", () => {
    const { v1, v2 } = tree();
    const session = sessionOf([v2, v1], "root.png");
    expect(session?.root.id).toBe("v1.png");
    expect(session?.versions.map((version) => version.id)).toEqual(["v1.png", "v2.png"]);
  });

  it("ignores videos and unrelated images", () => {
    const { all } = tree();
    const video = {
      ...image("clip.mp4", { of: "root.png", op: "prompt", n: 9 }),
      kind: "video" as const,
    };
    const session = sessionOf([...all, video], "root.png");
    expect(session?.versions.some((version) => version.id === "clip.mp4")).toBe(false);
    expect(session?.versions.some((version) => version.id === "other.png")).toBe(false);
    expect(sessionOf(all, "missing.png")).toBeUndefined();
  });
});

describe("sessions in the gallery", () => {
  it("lists every session once, most recently touched first", () => {
    const { all, root, v1 } = tree();
    const second = image("w1.png", { of: "other.png", root: "other.png", op: "prompt", n: 1 });
    const sessions = sessionsIn([...all, second]);
    expect(sessions.map((entry) => entry.rootId)).toEqual(["other.png", "root.png"]);
    expect(sessions[1]).toMatchObject({ versionCount: 3 });
    expect(sessions[1].latest.id).toBe("v3.png");
    expect(rootIdOf(v1)).toBe("root.png");
    expect(rootIdOf(root)).toBe("root.png");
  });
});
