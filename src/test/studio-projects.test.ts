import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorClip } from "../lib/studio/editor/document";
import type { StudioArtifact } from "../lib/studio/types";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listFilms: vi.fn(),
  shotList: vi.fn(),
  getNote: vi.fn(),
  listBibleEntries: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../lib/studio/bible", () => ({ listBibleEntries: native.listBibleEntries }));
vi.mock("../lib/tauri", () => ({
  listFilms: native.listFilms,
  shotList: native.shotList,
  getNote: native.getNote,
}));

import {
  copyProjectBible,
  importLegacyFilms,
  montageArtifacts,
  newProject,
  newShot,
  organizeArtifact,
  projectDocumentFits,
  ProjectWriter,
  shotSignature,
  type StudioProject,
} from "../lib/studio/projects";

type SaveRequest = Omit<StudioProject, "revision" | "updatedAt"> & {
  expectedRevision: number | null;
};

beforeEach(() => {
  vi.resetAllMocks();
  native.listBibleEntries.mockResolvedValue([]);
});

describe("project saves", () => {
  it("rejects a LUT that would exceed the native document limit", () => {
    const project = newProject("Oversized LUT");
    const clip = createEditorClip({
      id: "clip",
      trackId: "picture",
      name: "Take",
      duration: 30,
      artifactId: "take.mp4",
    });
    clip.grade.lut = {
      name: "High precision cube",
      size: 65,
      values: Array(65 ** 3 * 3).fill(0.1234567890123456),
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
    };
    project.document.timeline.clips = [clip];
    expect(projectDocumentFits(project.document)).toBe(false);
    clip.grade.lut = undefined;
    expect(projectDocumentFits(project.document)).toBe(true);
  });
  it("organizes gallery and project membership in one native operation", async () => {
    native.invoke.mockResolvedValue({ id: "clip.mp4", title: "Clip", projectIds: ["film-1"] });
    await expect(
      organizeArtifact({ id: "clip.mp4", title: "Clip", projectIds: ["film-1"] }),
    ).resolves.toMatchObject({ projectIds: ["film-1"] });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("studio_artifact_organize", {
      request: { id: "clip.mp4", title: "Clip", projectIds: ["film-1"] },
    });
  });

  it("surfaces an atomic organizer failure without issuing follow-up writes", async () => {
    native.invoke.mockRejectedValue(new Error("studio_project_conflict"));

    await expect(
      organizeArtifact({ id: "clip.mp4", title: "Clip", projectIds: ["film-1"] }),
    ).rejects.toThrow("studio_project_conflict");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("serializes immutable edit snapshots with the returned revision", async () => {
    const project = newProject("Concert");
    project.revision = 4;
    let finishFirst: (project: StudioProject) => void = () => undefined;
    native.invoke.mockImplementationOnce(
      () =>
        new Promise<StudioProject>((resolve) => {
          finishFirst = resolve;
        }),
    );
    native.invoke.mockImplementationOnce(async (_command, args: { request: SaveRequest }) => ({
      ...args.request,
      revision: 6,
      updatedAt: "later",
    }));
    const writer = new ProjectWriter(project);
    project.document.script = "First edit";
    const first = writer.save(project);
    project.document.script = "Second edit";
    const second = writer.save(project);
    project.document.script = "Still typing";
    await Promise.resolve();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls[0][1].request).toMatchObject({
      expectedRevision: 4,
      document: { script: "First edit" },
    });
    finishFirst({ ...project, revision: 5 });
    await first;
    await second;
    await writer.flush();
    expect(native.invoke.mock.calls[1][1].request).toMatchObject({
      expectedRevision: 5,
      document: { script: "Second edit" },
    });
  });

  it("stops queued writes after a conflict and exposes the failure on flush", async () => {
    native.invoke.mockRejectedValue("studio_project_conflict");
    const project = newProject("Concert");
    project.revision = 1;
    const writer = new ProjectWriter(project);
    const first = writer.save(project);
    project.document.script = "Keep my unsaved edit";
    const second = writer.save(project);
    await expect(first).rejects.toBe("studio_project_conflict");
    await expect(second).rejects.toBe("studio_project_conflict");
    await expect(writer.flush()).rejects.toBe("studio_project_conflict");
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(project.document.script).toBe("Keep my unsaved edit");
  });

  it("retries a later edit after a transient save failure with the whole current draft", async () => {
    const project = newProject("Concert");
    project.revision = 1;
    native.invoke.mockRejectedValueOnce("studio_project_storage_error");
    native.invoke.mockImplementation(async (_command, args: { request: SaveRequest }) => ({
      ...args.request,
      revision: 2,
    }));
    const writer = new ProjectWriter(project);
    project.document.script = "First edit";
    await expect(writer.save(project)).rejects.toBe("studio_project_storage_error");
    await expect(writer.flush()).rejects.toBe("studio_project_storage_error");
    project.document.script = "First edit and a correction";
    await expect(writer.save(project)).resolves.toMatchObject({ revision: 2 });
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(native.invoke.mock.calls[1][1].request).toMatchObject({
      expectedRevision: 1,
      document: { script: "First edit and a correction" },
    });
  });

  it("retries a failed draft before navigation but keeps a true revision conflict", async () => {
    const project = newProject("Concert");
    project.revision = 1;
    const writer = new ProjectWriter(project);
    native.invoke.mockRejectedValueOnce("studio_project_storage_error");
    native.invoke.mockResolvedValueOnce({ ...project, revision: 2 });
    await expect(writer.save(project)).rejects.toBe("studio_project_storage_error");
    await expect(writer.flush(project)).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledTimes(2);

    native.invoke.mockRejectedValue("studio_project_conflict");
    await expect(writer.save(project)).rejects.toBe("studio_project_conflict");
    await expect(writer.flush(project)).rejects.toBe("studio_project_conflict");
    expect(native.invoke.mock.calls.at(-1)?.[1].request.expectedRevision).toBe(2);
  });

  it("does not mark input stale when selecting a take, but does after changing its prompt", () => {
    const project = newProject("Concert");
    const shot = newShot(0);
    shot.action = "The musician enters";
    const original = shotSignature(shot, project.document);
    shot.takeIds.push("take-one");
    shot.activeTakeId = "take-one";
    shot.imageCandidates.push("candidate-one");
    shot.renderedSignature = original;
    expect(shotSignature(shot, project.document)).toBe(original);
    shot.action = "The musician exits";
    expect(shotSignature(shot, project.document)).not.toBe(original);
  });
  it("keeps media referenced by the montage available after project removal", () => {
    const project = newProject("Concert");
    project.id = "film-1";
    project.document.timeline.clips.push(
      createEditorClip({
        id: "clip",
        trackId: "picture",
        name: "Take",
        duration: 60,
        artifactId: "used.mp4",
      }),
    );
    const artifact = (id: string): StudioArtifact => ({
      id,
      projectIds: [],
      kind: "video",
      path: id,
      fileName: id,
      bytes: 1,
      model: "test",
      prompt: "test",
      createdAt: 0,
    });
    const artifacts = [artifact("used.mp4"), artifact("unused.mp4")];
    expect(montageArtifacts(project, artifacts).map((artifact) => artifact.id)).toEqual([
      "used.mp4",
    ]);
  });
});

describe("legacy film migration", () => {
  it("imports recoverable films once and never replaces an edited project", async () => {
    const saved = new Map<string, StudioProject>();
    const originalShot = { ...newShot(0), mode: undefined, action: "Enter", continues: true };
    native.listFilms.mockResolvedValue([{ noteId: "note-one", title: "Concert" }]);
    native.shotList.mockResolvedValue({ shotsJson: JSON.stringify({ shots: [originalShot] }) });
    native.getNote.mockResolvedValue({
      editedContent: "My edited script",
      generatedContent: "Old script",
    });
    native.invoke.mockImplementation(
      async (command: string, args: { id?: string; request?: SaveRequest }) => {
        if (command === "studio_project_get") return saved.get(args.id ?? "") ?? null;
        if (command === "studio_project_save" && args.request) {
          const project = { ...args.request, revision: 1, updatedAt: "now" };
          saved.set(project.id, project);
          return project;
        }
        if (command === "workflow_run_list") return [];
        throw new Error(`Unexpected command: ${command}`);
      },
    );
    await importLegacyFilms();
    const project = saved.get("legacy-film-note-one");
    expect(project?.document.script).toBe("My edited script");
    expect(project?.document.shots[0]).toMatchObject({
      id: "legacy-film-note-one-0",
      action: "Enter",
      mode: "continuation",
    });
    if (!project) throw new Error("Missing imported film");
    project.document.script = "Changed after migration";
    await importLegacyFilms();
    expect(saved.get(project.id)?.document.script).toBe("Changed after migration");
    expect(native.shotList).toHaveBeenCalledTimes(1);
    expect(
      native.invoke.mock.calls.filter(([command]) => command === "studio_project_save"),
    ).toHaveLength(1);
  });

  it("accepts an idempotent create conflict from another window without overwriting it", async () => {
    native.listFilms.mockResolvedValue([{ noteId: "shared", title: "Concert" }]);
    native.shotList.mockResolvedValue({ shotsJson: JSON.stringify([newShot(0)]) });
    native.getNote.mockResolvedValue({ generatedContent: "Script" });
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "studio_project_get") return null;
      if (command === "workflow_run_list") return [];
      throw new Error("studio_project_conflict");
    });
    await expect(importLegacyFilms()).resolves.toBeUndefined();
    expect(
      native.invoke.mock.calls.find(([command]) => command === "studio_project_save")?.[1].request
        .expectedRevision,
    ).toBeNull();
  });
});

describe("migration recovery boundaries", () => {
  it("skips damaged films and copies only named bible entries with independent ids", async () => {
    native.listFilms.mockResolvedValue([
      { noteId: "broken", title: "Broken" },
      { noteId: "null", title: "Null" },
      { noteId: "good", title: "Concert" },
    ]);
    native.shotList.mockImplementation(async (id: string) => ({
      shotsJson:
        id === "broken"
          ? "{bad"
          : id === "null"
            ? "null"
            : JSON.stringify([null, { ...newShot(0), characters: [" BAPTISTE ", 7] }]),
    }));
    native.getNote.mockResolvedValue({ editedContent: "Script" });
    const bible = [
      {
        id: "person",
        kind: "character",
        name: "Baptiste",
        traits: "Dark jacket",
        note: "Private",
        createdAt: "",
        updatedAt: "",
        refs: [
          {
            id: "portrait",
            entryId: "person",
            artifactId: "face.png",
            role: "portrait",
            label: "Front",
            ordinal: 0,
          },
        ],
      },
      {
        id: "unrelated",
        kind: "character",
        name: "Elsewhere",
        traits: "",
        note: "",
        createdAt: "",
        updatedAt: "",
        refs: [],
      },
    ];
    native.listBibleEntries.mockResolvedValue(bible);
    let saved: SaveRequest | undefined;
    native.invoke.mockImplementation(async (command: string, args: { request: SaveRequest }) => {
      if (command === "studio_project_get") return null;
      if (command === "workflow_run_list") return [];
      saved = args.request;
      return { ...saved, revision: 1 };
    });
    await importLegacyFilms();
    expect(saved?.id).toBe("legacy-film-good");
    expect(saved?.document.shots).toHaveLength(1);
    expect(saved?.document.shots[0].mode).toBe("text");
    expect(saved?.document.bible).toHaveLength(1);
    const copied = saved?.document.bible[0];
    expect(copied?.originId).toBe("person");
    expect(copied?.id).not.toBe("person");
    expect(copied?.refs[0].entryId).toBe(copied?.id);
    expect(saved?.document.artifactIds).toEqual(["face.png"]);
    if (!copied) throw new Error("Missing copied identity");
    copied.refs[0].label = "Changed in film";
    expect(bible[0].refs[0].label).toBe("Front");
  });

  it("recovers takes, audio, and copied bible references from a frozen run", async () => {
    native.listFilms.mockResolvedValue([]);
    native.listBibleEntries.mockResolvedValue([
      {
        id: "person",
        kind: "character",
        name: "Baptiste",
        traits: "Dark jacket",
        note: "",
        createdAt: "",
        updatedAt: "",
        refs: [
          {
            id: "front",
            entryId: "person",
            artifactId: "face-one.png",
            role: "portrait",
            label: "Front",
            ordinal: 0,
          },
          {
            id: "side",
            entryId: "person",
            artifactId: "face-two.png",
            role: "profile",
            label: "Side",
            ordinal: 1,
          },
        ],
      },
    ]);
    const graph = {
      nodes: [
        { id: "portrait-ref", type: "asset", label: "", params: { artifactId: "face-one.png" } },
        {
          id: "shot-1",
          type: "video",
          label: "Entrance",
          params: {
            model: "text-video",
            prompt: "Enter the hall",
            duration: "5",
            modelDirection: "text",
          },
        },
        { id: "handoff-2", type: "lastFrame", label: "", params: {} },
        {
          id: "shot-2",
          type: "video",
          label: "Continue",
          params: { model: "image-video", prompt: "Sit down", modelDirection: "image" },
        },
        { id: "line-1", type: "tts", label: "", params: { text: "Good evening" } },
        { id: "assemble", type: "assemble", label: "", params: {} },
      ],
      edges: [{ source: "handoff-2", target: "shot-2", targetPort: "openingFrame" }],
    };
    let saved: SaveRequest | undefined;
    native.invoke.mockImplementation(async (command: string, args: { request: SaveRequest }) => {
      if (command === "workflow_run_list")
        return [
          { id: "old-run", name: "Concert", definition: JSON.stringify(graph), status: "failed" },
        ];
      if (command === "studio_project_get") return null;
      if (command === "workflow_run_get")
        return {
          nodes: [
            {
              nodeId: "shot-1",
              status: "done",
              output: JSON.stringify({ kind: "video", artifactId: "take-one.mp4" }),
            },
            {
              nodeId: "line-1",
              status: "done",
              output: JSON.stringify({ kind: "audio", artifactId: "line.wav" }),
            },
            { nodeId: "shot-2", status: "failed", output: "bad-json" },
          ],
        };
      if (command === "studio_project_save") {
        saved = args.request;
        return { ...saved, revision: 1 };
      }
      throw new Error(`Execution is forbidden: ${command}`);
    });
    await importLegacyFilms();
    expect(saved?.id).toBe("legacy-run-old-run");
    expect(saved?.document.shots[0]).toMatchObject({
      id: "1",
      mode: "text",
      activeTakeId: "take-one.mp4",
      dialogue: "Good evening",
    });
    expect(saved?.document.shots[1]).toMatchObject({ id: "2", mode: "continuation", takeIds: [] });
    expect(saved?.document.artifactIds).toEqual([
      "face-one.png",
      "take-one.mp4",
      "line.wav",
      "face-two.png",
    ]);
    expect(saved?.document.runs).toEqual([
      { id: "old-run", shotSignatures: {}, appliedNodeIds: ["shot-1", "line-1"] },
    ]);
  });

  it("copies bible identities independently between two projects", () => {
    const entry = {
      id: "person",
      kind: "character" as const,
      name: "Baptiste",
      traits: "Dark jacket",
      note: "",
      createdAt: "",
      updatedAt: "",
      refs: [],
    };
    const a = copyProjectBible([entry], "film-a");
    const b = copyProjectBible([entry], "film-b");
    a[0].traits = "Bright jacket";
    expect(b[0].traits).toBe("Dark jacket");
    expect(entry.traits).toBe("Dark jacket");
    expect(a[0].id).not.toBe(b[0].id);
  });
});
