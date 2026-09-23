import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLocale, t } from "../lib/i18n";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  save: vi.fn(),
  flush: vi.fn(),
  quote: vi.fn(),
  run: vi.fn(),
  resume: vi.fn(),
  budget: vi.fn(),
  mediaSeconds: vi.fn(),
  organize: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../lib/studio/projects", async (original) => ({
  ...(await original<typeof import("../lib/studio/projects")>()),
  getProject: mocks.getProject,
  listProjects: mocks.listProjects,
  importLegacyFilms: vi.fn(),
  saveProject: mocks.save,
  listArtifactMetadata: vi.fn(async () => []),
  saveArtifactMetadata: vi.fn(async () => {}),
  organizeArtifact: mocks.organize,
  ProjectWriter: class {
    save = mocks.save;
    flush = mocks.flush;
  },
}));
vi.mock("../lib/studio/artifacts", () => ({
  listArtifacts: vi.fn(async () => []),
  artifactSrc: vi.fn(),
}));
vi.mock("../lib/studio/reference-media", () => ({ mediaSeconds: mocks.mediaSeconds }));
vi.mock("../lib/studio/project-production", async (original) => ({
  ...(await original<typeof import("../lib/studio/project-production")>()),
  quoteProject: mocks.quote,
  productionBudget: mocks.budget,
}));
vi.mock("../lib/studio/workflow-run", () => ({
  descendantsOf: (_workflow: Workflow, ids: string[]) => new Set(ids),
  activeWorkflowRuns: () => [],
  runAndSaveWorkflow: mocks.run,
  resumeWorkflowRun: mocks.resume,
}));
vi.mock("../components/ui/Dialog", () => ({
  Dialog: ({
    title,
    children,
    footer,
  }: {
    title: string;
    children: ReactNode;
    footer: ReactNode;
  }) => (
    <section role="dialog" aria-label={title}>
      {children}
      {footer}
    </section>
  ),
}));
vi.mock("../components/studio/NotePicker", () => ({
  NotePicker: ({ onPick }: { onPick: (note: { id: string }) => void }) => (
    <button type="button" onClick={() => onPick({ id: "picked-note" })}>
      Pick selected note
    </button>
  ),
}));
vi.mock("../components/studio/MediaModelPicker", () => ({
  MediaModelPicker: () => null,
  mediaModelOption: (value: unknown) => value,
}));
vi.mock("../components/studio/ProjectBible", () => ({
  ProjectBible: ({
    entries,
    onChange,
  }: {
    entries: StudioProject["document"]["bible"];
    onChange: (entries: StudioProject["document"]["bible"]) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChange(entries.map((entry) => ({ ...entry, name: "Morgan" })))}
    >
      Rename Bible entry
    </button>
  ),
}));
vi.mock("../components/studio/ProjectMedia", () => ({
  ProjectMedia: ({
    onMetadata,
  }: {
    onMetadata: (artifact: StudioArtifact, title: string, projectIds: string[]) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() =>
        void onMetadata(
          {
            id: "media-1",
            kind: "image",
            path: "/gallery/media-1.png",
            fileName: "media-1.png",
            bytes: 1,
            model: "test",
            prompt: "test",
            createdAt: 0,
          },
          "Renamed media",
          ["project-1"],
        )
      }
    >
      Save media metadata
    </button>
  ),
}));
vi.mock("../components/studio/ProjectTimeline", () => ({
  ProjectTimeline: ({
    artifacts,
    value,
    onChange,
    onExportArtifact,
  }: {
    artifacts: Array<{ id: string }>;
    value: StudioProject["document"]["timeline"];
    onChange: (value: StudioProject["document"]["timeline"]) => void;
    onExportArtifact: (artifact: StudioArtifact) => Promise<void>;
  }) => (
    <>
      <output data-testid="timeline-artifacts">
        {artifacts.map((artifact) => artifact.id).join(",")}
      </output>
      <output data-testid="timeline-first-duration">{value.clips[0]?.duration ?? ""}</output>
      <button
        type="button"
        onClick={() =>
          onChange({
            ...value,
            clips: value.clips.map((clip, index) =>
              index === 0 ? { ...clip, duration: 20 } : clip,
            ),
          })
        }
      >
        Trim existing clip
      </button>
      <button
        type="button"
        onClick={() => {
          const clip = createEditorClip({
            id: "large-lut",
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
          onChange({ ...value, clips: [clip] });
        }}
      >
        Apply oversized LUT
      </button>
      <button
        type="button"
        onClick={() =>
          void onExportArtifact({
            id: "rendered.mp4",
            kind: "video",
            path: "/gallery/rendered.mp4",
            fileName: "rendered.mp4",
            bytes: 5,
            model: "assembly",
            prompt: "Montage export",
            createdAt: 1,
          })
        }
      >
        Complete montage export
      </button>
    </>
  ),
}));
vi.mock("../components/studio/ProjectShots", () => ({
  ProjectShots: ({ onGenerate }: { onGenerate: (id: string) => void }) => (
    <button type="button" onClick={() => onGenerate("s1")}>
      Generate shot
    </button>
  ),
}));

import { ProjectStudio } from "../components/studio/ProjectStudio";
import { listArtifacts } from "../lib/studio/artifacts";
import { createEditorClip } from "../lib/studio/editor/document";
import {
  newProject,
  newShot,
  listArtifactMetadata,
  saveArtifactMetadata,
  type StudioProject,
} from "../lib/studio/projects";
import type { MediaCatalog, StudioArtifact } from "../lib/studio/types";
import type { Workflow } from "../lib/studio/workflow/schema";
import type { NodeRunResult } from "../lib/studio/workflow/engine";
import { STUDIO_FILM_NOTE_KEY } from "../components/studio/studio-keys";
const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    {
      id: "test-text-to-video",
      name: "Test video",
      mediaType: "video",
      offline: false,
      costCredits: 10,
    },
  ],
};
let project: StudioProject;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(STUDIO_FILM_NOTE_KEY);
  vi.mocked(listArtifacts).mockResolvedValue([]);
  project = newProject("Concert");
  project.id = "project-1";
  project.document.shots = [
    { ...newShot(0), id: "s1", action: "The pianist bows", modelId: "test-text-to-video" },
  ];
  localStorage.setItem("os-june:studio-project", project.id);
  mocks.getProject.mockImplementation(async () => project);
  mocks.listProjects.mockResolvedValue([project]);
  mocks.save.mockImplementation(async (value: StudioProject) => {
    project = value;
    return value;
  });
  mocks.flush.mockResolvedValue(undefined);
  mocks.organize.mockImplementation(async (request: { id: string }) => {
    project.document.artifactIds = [...new Set([...project.document.artifactIds, request.id])];
    return request;
  });
  mocks.budget.mockReturnValue(vi.fn());
  mocks.mediaSeconds.mockReset().mockResolvedValue(5);
  mocks.quote.mockImplementation(async (workflow: Workflow) => ({
    nodes: workflow.nodes
      .filter((node) => node.type === "video")
      .map((node) => ({
        nodeId: node.id,
        type: "video",
        label: node.label,
        kind: "flat",
        credits: 10,
        quotable: false,
      })),
    credits: 10,
    metered: 0,
    quotable: 0,
  }));
  mocks.invoke.mockResolvedValue(null);
  mocks.run.mockResolvedValue(new Map());
  mocks.resume.mockResolvedValue(new Map());
});
const mount = async () => {
  const result = render(<ProjectStudio catalog={catalog} />);
  await screen.findByRole("button", { name: "Generate shot" });
  return result;
};

describe("project production confirmation", () => {
  it("keeps the last chosen film when an earlier project read finishes later", async () => {
    localStorage.removeItem("os-june:studio-project");
    const second = newProject("Second film");
    second.id = "project-2";
    mocks.listProjects.mockResolvedValue([project, second]);
    let finishFirst: (value: StudioProject) => void = () => {};
    let finishSecond: (value: StudioProject) => void = () => {};
    mocks.getProject.mockImplementation(
      (id: string) =>
        new Promise<StudioProject>((resolve) => {
          if (id === project.id) finishFirst = resolve;
          else finishSecond = resolve;
        }),
    );
    const view = render(<ProjectStudio catalog={catalog} />);
    await screen.findByText("Second film");
    const cards = view.container.querySelectorAll<HTMLButtonElement>(".project-card-open");
    fireEvent.click(cards[0]);
    fireEvent.click(cards[1]);
    await act(async () => finishSecond(second));
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Second film");
    await act(async () => finishFirst(project));
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Second film");
  });

  it("does not open a duplicate after another film was chosen", async () => {
    localStorage.removeItem("os-june:studio-project");
    const second = newProject("Second film");
    second.id = "project-2";
    mocks.listProjects.mockResolvedValue([project, second]);
    let finishDuplicate: (value: StudioProject) => void = () => {};
    mocks.getProject.mockImplementation((id: string) =>
      id === project.id
        ? new Promise<StudioProject>((resolve) => {
            finishDuplicate = resolve;
          })
        : Promise.resolve(second),
    );
    const view = render(<ProjectStudio catalog={catalog} />);
    await screen.findByText("Second film");
    fireEvent.click(screen.getAllByRole("button", { name: "Duplicate" })[0]);
    const cards = view.container.querySelectorAll<HTMLButtonElement>(".project-card-open");
    fireEvent.click(cards[1]);
    expect(await screen.findByRole("textbox", { name: "Project name" })).toHaveValue("Second film");
    await act(async () => finishDuplicate(project));
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Second film");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("shows aspect ratio substitutions before a paid render is confirmed", async () => {
    project.document.settings.aspectRatio = "9:16";
    const restricted = {
      ...catalog,
      models: [{ ...catalog.models[0], constraints: { aspect_ratios: ["16:9"] } }],
    };
    render(<ProjectStudio catalog={restricted} />);
    await screen.findByRole("button", { name: "Generate shot" });
    fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
    const dialog = await screen.findByRole("dialog", { name: t("Review generation costs") });
    expect(within(dialog).getByText(/9:16/)).toHaveTextContent("16:9");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("keeps an oversized LUT out of the visible and saved project", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Montage" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply oversized LUT" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("too large to save");
    expect(project.document.timeline.clips).toHaveLength(0);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("opens the film linked to a note instead of the last-opened project", async () => {
    const other = newProject("Other film");
    other.id = "project-2";
    project.document.noteId = "selected-note";
    localStorage.setItem(STUDIO_FILM_NOTE_KEY, "selected-note");
    localStorage.setItem("os-june:studio-project", other.id);
    mocks.listProjects.mockResolvedValue([other, project]);
    mocks.getProject.mockImplementation(async (id: string) => (id === other.id ? other : project));

    await mount();

    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Concert");
    expect(localStorage.getItem(STUDIO_FILM_NOTE_KEY)).toBeNull();
  });

  it("creates a project from a selected note when that note has no film yet", async () => {
    localStorage.setItem(STUDIO_FILM_NOTE_KEY, "selected-note");
    mocks.listProjects.mockResolvedValue([]);
    mocks.invoke.mockImplementation(async (command) =>
      command === "get_note"
        ? { id: "selected-note", title: "Note film", editedContent: "A quiet hall." }
        : null,
    );

    render(<ProjectStudio catalog={catalog} />);
    expect(await screen.findByRole("textbox", { name: "Film script" })).toHaveValue(
      "A quiet hall.",
    );
    expect(project.document.noteId).toBe("selected-note");
    expect(project.name).toBe("Note film");
    expect(localStorage.getItem(STUDIO_FILM_NOTE_KEY)).toBeNull();
  });

  it("locks project navigation while media organization is being saved", async () => {
    let finishOrganization: (value: { id: string }) => void = () => {};
    mocks.organize.mockReturnValue(
      new Promise((resolve) => {
        finishOrganization = resolve;
      }),
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Media" }));
    fireEvent.click(screen.getByRole("button", { name: "Save media metadata" }));
    await waitFor(() => expect(mocks.organize).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Script" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "All projects" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Project name" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Script" }));
    expect(screen.getByRole("button", { name: "Media" })).toHaveAttribute("aria-current", "page");
    await act(async () => finishOrganization({ id: "media-1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Script" })).toBeEnabled());
  });

  it("does not apply a slowly loaded note to a different film", async () => {
    const second = newProject("Second film");
    second.id = "project-2";
    second.document.script = "Keep this script.";
    mocks.listProjects.mockResolvedValue([project, second]);
    mocks.getProject.mockImplementation(async (id: string) =>
      id === project.id ? project : second,
    );
    let finishNote: (note: { editedContent: string }) => void = () => {};
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "get_note")
        return new Promise((resolve) => {
          finishNote = resolve;
        });
      return null;
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Script" }));
    fireEvent.click(screen.getByRole("button", { name: "From your notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick selected note" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("get_note", {
        request: { noteId: "picked-note" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    fireEvent.click(await screen.findByRole("button", { name: /Second film/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Second film"),
    );
    await act(async () => finishNote({ editedContent: "Wrong script" }));
    expect(second.document.script).toBe("Keep this script.");
    expect(second.document.noteId).toBeUndefined();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("updates differently cased shot references when a bible entry is renamed", async () => {
    project.document.bible = [
      {
        id: "person",
        kind: "character",
        name: "Alice",
        traits: "Dark jacket",
        note: "",
        refs: [],
        createdAt: "",
        updatedAt: "",
      },
    ];
    project.document.shots[0].characters = ["ALICE"];
    project.document.shots[0].location = " alice ";
    project.document.shots[0].speaker = "AlIcE";
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Bible" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Bible entry" }));
    expect(project.document.shots[0]).toMatchObject({
      characters: ["Morgan"],
      location: "Morgan",
      speaker: "Morgan",
    });
  });

  it("shows project dates in the selected app language", async () => {
    applyLocale("fr");
    try {
      localStorage.removeItem("os-june:studio-project");
      project.updatedAt = "2026-09-23T12:00:00.000Z";
      render(<ProjectStudio catalog={catalog} />);
      await screen.findByText("Concert");
      expect(document.querySelector(".project-card small")?.textContent).toBe(
        new Date(project.updatedAt).toLocaleDateString("fr-FR"),
      );
    } finally {
      applyLocale("en");
    }
  });

  it("formats quoted totals and steps in the app language", async () => {
    applyLocale("fr");
    try {
      project.document.settings.budget = 2000;
      mocks.quote.mockImplementation(async (workflow: Workflow) => ({
        nodes: workflow.nodes
          .filter((node) => node.type === "video")
          .map((node) => ({
            nodeId: node.id,
            type: "video",
            label: node.label,
            kind: "flat",
            credits: 1000.5,
            quotable: false,
          })),
        credits: 1000.5,
        metered: 0,
        quotable: 0,
      }));
      await mount();
      fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
      const dialog = await screen.findByRole("dialog", { name: t("Review generation costs") });
      const amount = (1000.5).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
      expect(
        within(dialog).getByRole("button", {
          name: t("Generate · {credits} credits", { credits: amount }),
        }),
      ).toBeInTheDocument();
      expect(dialog.querySelector(".project-quote-row strong")?.textContent).toBe(
        t("{credits} credits", { credits: amount }),
      );
    } finally {
      applyLocale("en");
    }
  });

  it("files a rendered montage in the film and its gallery membership", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Montage" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete montage export" }));
    await waitFor(() =>
      expect(mocks.organize).toHaveBeenCalledWith({
        id: "rendered.mp4",
        title: "",
        projectIds: ["project-1"],
      }),
    );
    expect(project.document.artifactIds).toContain("rendered.mp4");
  });

  it("keeps montage edits made while an export reload is pending", async () => {
    project.document.timeline.clips = [
      createEditorClip({
        id: "first",
        trackId: "picture",
        name: "First",
        duration: 30,
        artifactId: "first.mp4",
      }),
    ];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Montage" }));
    const stale = structuredClone(project);
    let resolveReload!: (value: StudioProject) => void;
    const reload = new Promise<StudioProject>((resolve) => {
      resolveReload = resolve;
    });
    const priorLoads = mocks.getProject.mock.calls.length;
    mocks.getProject.mockReturnValue(reload);

    fireEvent.click(screen.getByRole("button", { name: "Complete montage export" }));
    await waitFor(() => expect(mocks.getProject.mock.calls.length).toBe(priorLoads + 1));
    fireEvent.click(screen.getByRole("button", { name: "Trim existing clip" }));
    expect(screen.getByTestId("timeline-first-duration")).toHaveTextContent("20");
    await act(async () => resolveReload(stale));
    expect(screen.getByTestId("timeline-first-duration")).toHaveTextContent("20");
  });

  it("appends selected takes after the latest picture edit even when audio runs longer", async () => {
    project.document.timeline.clips = [
      createEditorClip({
        id: "first",
        trackId: "picture",
        name: "First",
        duration: 30,
        artifactId: "first.mp4",
      }),
      createEditorClip({
        id: "score",
        trackId: "music",
        name: "Score",
        duration: 100,
        artifactId: "score.mp3",
      }),
    ];
    project.document.shots[0].activeTakeId = "take.mp4";
    vi.mocked(listArtifacts).mockResolvedValue([
      {
        id: "take.mp4",
        kind: "video",
        path: "/media/take.mp4",
        fileName: "take.mp4",
        bytes: 1,
        model: "test",
        prompt: "test",
        createdAt: 0,
      },
    ]);
    let finishMetadata: (seconds: number) => void = () => {};
    mocks.mediaSeconds.mockReturnValue(
      new Promise<number>((resolve) => {
        finishMetadata = resolve;
      }),
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Montage" }));
    fireEvent.click(screen.getByRole("button", { name: "Append selected takes" }));
    await waitFor(() => expect(mocks.mediaSeconds).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Trim existing clip" }));
    finishMetadata(5);
    await waitFor(() => expect(project.document.timeline.clips).toHaveLength(3));
    expect(project.document.timeline.clips[0].duration).toBe(20);
    expect(project.document.timeline.clips[1].duration).toBe(100);
    expect(project.document.timeline.clips[2].start).toBe(20);
  });

  it.each(["locked", "hidden"] as const)(
    "does not append takes to a %s picture track",
    async (state) => {
      project.document.timeline.tracks[0][state] = true;
      project.document.shots[0].activeTakeId = "take.mp4";
      vi.mocked(listArtifacts).mockResolvedValue([
        {
          id: "take.mp4",
          kind: "video",
          path: "/media/take.mp4",
          fileName: "take.mp4",
          bytes: 1,
          model: "test",
          prompt: "test",
          createdAt: 0,
        },
      ]);
      await mount();
      fireEvent.click(screen.getByRole("button", { name: "Montage" }));
      fireEvent.click(screen.getByRole("button", { name: "Append selected takes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Unlock and show the picture track before appending takes.",
      );
      expect(project.document.timeline.clips).toHaveLength(0);
    },
  );

  it("reads an imported script through a project-owned note and keeps the returned cast", async () => {
    project.document.noteId = "source-note";
    project.document.script = "A pianist enters the hall.";
    project.document.shots = [];
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "shot_list") return null;
      if (command === "create_note") return { id: "project-reading" };
      if (command === "update_note") return { id: "project-reading" };
      if (command === "build_shot_list")
        return {
          noteId: "project-reading",
          status: "ready",
          shotsJson: JSON.stringify({
            cast: [{ name: "Mira", kind: "character", traits: "Silver coat" }],
            shots: [{ scene: "Hall", action: "Mira enters" }],
          }),
        };
      return null;
    });

    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Script" }));
    fireEvent.click(screen.getByRole("button", { name: "Break into shots" }));

    await waitFor(() => expect(project.document.shots).toHaveLength(1));
    expect(project.document.noteId).toBe("source-note");
    await waitFor(() => expect(project.document.readingNoteId).toBeUndefined());
    expect(mocks.invoke).toHaveBeenCalledWith("delete_notes", {
      request: { noteIds: ["project-reading"] },
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("shot_list", { noteId: "source-note" });
    expect(mocks.invoke).toHaveBeenCalledWith("update_note", {
      request: {
        noteId: "project-reading",
        title: "Concert",
        editedContent: "A pianist enters the hall.",
      },
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "update_note",
      expect.objectContaining({ request: expect.objectContaining({ noteId: "source-note" }) }),
    );
    expect(project.document.bible).toMatchObject([
      { name: "Mira", kind: "character", traits: "Silver coat", refs: [] },
    ]);
  });

  it.each([
    ["failed", "The reader failed", "The reader failed"],
    ["ready", undefined, "The script could not be read."],
  ])(
    "keeps the reading error visible after cleaning up a %s result",
    async (status, lastError, message) => {
      project.document.shots = [];
      project.document.script = "A pianist enters the hall.";
      mocks.invoke.mockImplementation(async (command) => {
        if (command === "create_note") return { id: "project-reading" };
        if (command === "build_shot_list") return { noteId: "project-reading", status, lastError };
        return null;
      });
      await mount();
      fireEvent.click(screen.getByRole("button", { name: "Script" }));
      fireEvent.click(screen.getByRole("button", { name: "Break into shots" }));
      await waitFor(() => expect(project.document.readingNoteId).toBeUndefined());
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(mocks.invoke).toHaveBeenCalledWith("delete_notes", {
        request: { noteIds: ["project-reading"] },
      });
    },
  );

  it("keeps a failed note update owned by its project and reuses it on retry", async () => {
    project.document.shots = [];
    project.document.script = "A pianist enters the hall.";
    let updates = 0;
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "create_note") return { id: "project-reading" };
      if (command === "update_note" && updates++ === 0) throw new Error("Update failed");
      if (command === "build_shot_list") return { noteId: "project-reading", status: "pending" };
      return null;
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Script" }));
    fireEvent.click(screen.getByRole("button", { name: "Break into shots" }));
    await screen.findByText("Update failed");
    expect(project.document.readingNoteId).toBe("project-reading");
    fireEvent.click(screen.getByRole("button", { name: "Break into shots" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("build_shot_list", { noteId: "project-reading" }),
    );
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_note")).toHaveLength(
      1,
    );
  });

  it("deletes a newly created reading note if its project ownership cannot be saved", async () => {
    project.document.shots = [];
    project.document.script = "A pianist enters the hall.";
    mocks.save.mockRejectedValueOnce(new Error("Project save failed"));
    mocks.invoke.mockImplementation(async (command) =>
      command === "create_note" ? { id: "project-reading" } : null,
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Script" }));
    fireEvent.click(screen.getByRole("button", { name: "Break into shots" }));
    await screen.findByText("Project save failed");
    expect(mocks.invoke).toHaveBeenCalledWith("delete_notes", {
      request: { noteIds: ["project-reading"] },
    });
    expect(project.document.readingNoteId).toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalledWith("update_note", expect.anything());
  });

  it("adds archived projects to the active list when requested", async () => {
    mocks.listProjects.mockResolvedValue([
      project,
      { id: "archived-film", name: "Archived film", archived: true, revision: 1, updatedAt: "" },
    ]);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    expect(await screen.findByText("Concert")).toBeVisible();
    expect(screen.queryByText("Archived film")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
    expect(screen.getByText("Concert")).toBeVisible();
    expect(screen.getByText("Archived film")).toBeVisible();
  });

  it("removes a dismissed run without blocking restoration of later productions", async () => {
    project.document.runs = [
      { id: "dismissed-run", shotSignatures: {} },
      { id: "retained-run", shotSignatures: {} },
    ];
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command !== "workflow_run_get") return null;
      if ((args as { id: string }).id === "dismissed-run")
        throw { code: "workflow_run_missing", message: "That run no longer exists." };
      return { run: { status: "completed" }, nodes: [] };
    });

    await mount();

    await waitFor(() =>
      expect(project.document.runs.map((run) => run.id)).toEqual(["retained-run"]),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("workflow_run_get", { id: "retained-run" });
    expect(screen.queryByText("That run no longer exists.")).toBeNull();
  });

  it("does not restore another film's runs after navigating away", async () => {
    project.document.runs = [
      { id: "first-run", shotSignatures: {} },
      { id: "second-run", shotSignatures: {} },
    ];
    let releaseFirst!: (value: { run: { status: string }; nodes: [] }) => void;
    const first = new Promise<{ run: { status: string }; nodes: [] }>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command !== "workflow_run_get") return null;
      return (args as { id: string }).id === "first-run"
        ? first
        : {
            run: { status: "completed" },
            nodes: [
              {
                nodeId: "shot-s1",
                status: "done",
                output: JSON.stringify({ kind: "video", artifactId: "old-take.mp4" }),
              },
            ],
          };
    });
    await mount();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("workflow_run_get", { id: "first-run" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));
    await screen.findByRole("textbox", { name: "Film script" });
    await act(async () => releaseFirst({ run: { status: "completed" }, nodes: [] }));
    expect(mocks.invoke).not.toHaveBeenCalledWith("workflow_run_get", { id: "second-run" });
    expect(project.document.artifactIds).not.toContain("old-take.mp4");
  });

  it("can explicitly reopen the saved film after a conflicting autosave", async () => {
    project.document.script = "Saved script";
    mocks.save.mockRejectedValueOnce("studio_project_conflict");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Script" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Film script" }), {
      target: { value: "Unsaved script" },
    });
    await screen.findByRole("button", { name: "Reopen saved version" });
    fireEvent.click(screen.getByRole("button", { name: "Reopen saved version" }));
    const dialog = await screen.findByRole("dialog", { name: "Reopen the saved version?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen saved version" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Film script" })).toHaveValue("Saved script"),
    );
  });

  it("remounts the montage after reopening a saved revision", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Montage" }));
    const abandonedEditor = screen.getByTestId("timeline-artifacts");
    mocks.save.mockRejectedValueOnce("studio_project_conflict");
    fireEvent.click(screen.getByRole("button", { name: "Trim existing clip" }));
    await screen.findByRole("button", { name: "Reopen saved version" });
    mocks.getProject.mockResolvedValue({ ...project, revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Reopen saved version" }));
    const dialog = await screen.findByRole("dialog", { name: "Reopen the saved version?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen saved version" }));
    await waitFor(() => expect(screen.getByTestId("timeline-artifacts")).not.toBe(abandonedEditor));
  });

  it("shows the stored project name after discarding a conflicting rename", async () => {
    project.name = "Original film";
    await mount();
    mocks.save.mockRejectedValueOnce("studio_project_conflict");
    const name = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(name, { target: { value: "Discarded name" } });
    fireEvent.blur(name);
    await screen.findByRole("button", { name: "Reopen saved version" });
    mocks.getProject.mockResolvedValue({ ...project, name: "Saved remotely", revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Reopen saved version" }));
    const dialog = await screen.findByRole("dialog", { name: "Reopen the saved version?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen saved version" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Saved remotely"),
    );
  });

  it("keeps a montage clip's media available after removing its project membership", async () => {
    project.document.artifactIds = [];
    project.document.timeline.clips = [
      createEditorClip({
        id: "clip",
        trackId: "picture",
        name: "Take",
        duration: 30,
        artifactId: "used.mp4",
      }),
    ];
    vi.mocked(listArtifacts).mockResolvedValue([
      {
        id: "used.mp4",
        projectIds: [],
        kind: "video",
        path: "/media/used.mp4",
        fileName: "used.mp4",
        bytes: 1,
        model: "test",
        prompt: "test",
        createdAt: 0,
      },
    ]);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Montage" }));
    expect(screen.getByTestId("timeline-artifacts")).toHaveTextContent("used.mp4");
  });

  it("re-enables script editing when leaving a project whose shot list is still reading", async () => {
    project.document.readingNoteId = "note-one";
    mocks.invoke.mockImplementation(async (command) =>
      command === "shot_list" ? { noteId: "note-one", status: "pending" } : null,
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Script" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Film script" })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Film script" })).not.toBeDisabled(),
    );
  });

  it("duplicates a film without linking the copy to the original production runs", async () => {
    const originalShots = structuredClone(project.document.shots);
    project.document.runs = [{ id: "original-run", shotSignatures: {} }];
    project.document.readingNoteId = "original-reading";
    mocks.invoke.mockImplementation(async (command) =>
      command === "workflow_run_get" ? { run: { status: "completed" }, nodes: [] } : null,
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    const copy = mocks.save.mock.calls.at(-1)?.[0] as StudioProject;
    expect(copy.id).not.toBe("project-1");
    expect(copy.document.runs).toEqual([]);
    expect(copy.document.readingNoteId).toBeUndefined();
    expect(copy.document.shots).toEqual(originalShots);
  });

  it("does not pay until the quoted production is confirmed and records its owner first", async () => {
    vi.mocked(listArtifactMetadata).mockResolvedValue([
      { id: "take.mp4", title: "Alternate view", projectIds: ["other-project"] },
    ]);
    mocks.run.mockImplementation(async (_workflow, options) => {
      await options.onRunRecorded("run-1");
      expect(project.document.runs[0].id).toBe("run-1");
      options.onUpdate({
        nodeId: "shot-s1",
        status: "done",
        output: { kind: "video", artifactId: "take.mp4" },
      });
      return new Map();
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
    await screen.findByRole("dialog", { name: "Review generation costs" });
    expect(mocks.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await waitFor(() => expect(project.document.shots[0].takeIds).toContain("take.mp4"));
    expect(project.document.runs[0].appliedNodeIds).toContain("shot-s1");
    expect(mocks.run.mock.calls[0][1]).toMatchObject({ requireDurable: true });
    await waitFor(() =>
      expect(saveArtifactMetadata).toHaveBeenCalledWith({
        id: "take.mp4",
        title: "Alternate view",
        projectIds: ["other-project", "project-1"],
      }),
    );
  });

  it("keeps a render failure visible when an earlier result save finishes later", async () => {
    let finishSave: (() => void) | undefined;
    mocks.save.mockImplementation(async (value: StudioProject) => {
      if (value.document.shots[0]?.takeIds.includes("take.mp4"))
        await new Promise<void>((resolve) => {
          finishSave = resolve;
        });
      project = value;
      return value;
    });
    mocks.run.mockImplementation(async (_workflow, options) => {
      await options.onRunRecorded("run-1");
      options.onUpdate({
        nodeId: "shot-s1",
        status: "done",
        output: { kind: "video", artifactId: "take.mp4" },
      });
      throw new Error("Second shot failed");
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
    await screen.findByRole("dialog", { name: "Review generation costs" });
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Second shot failed");
    await waitFor(() => expect(finishSave).toBeDefined());
    await act(async () => finishSave?.());
    expect(screen.getByRole("alert")).toHaveTextContent("Second shot failed");
  });

  it("does not restore project membership for a finished take removed from its media library", async () => {
    project.document.runs = [
      {
        id: "run-1",
        shotSignatures: {},
        appliedNodeIds: ["shot-s1"],
      },
    ];
    project.document.shots[0].takeIds = ["take.mp4"];
    project.document.artifactIds = [];
    mocks.invoke.mockImplementation(async (command) =>
      command === "workflow_run_get"
        ? {
            run: { status: "completed" },
            nodes: [
              {
                nodeId: "shot-s1",
                status: "done",
                output: JSON.stringify({ kind: "video", artifactId: "take.mp4" }),
              },
            ],
          }
        : null,
    );

    await mount();

    expect(project.document.artifactIds).toEqual([]);
    expect(saveArtifactMetadata).not.toHaveBeenCalled();
  });

  it("repairs a gallery membership lost after the applied marker was saved", async () => {
    project.document.runs = [{ id: "run-1", shotSignatures: {}, appliedNodeIds: ["shot-s1"] }];
    project.document.artifactIds = ["take.mp4"];
    vi.mocked(listArtifactMetadata).mockResolvedValue([
      { id: "take.mp4", title: "Concert take", projectIds: [] },
    ]);
    mocks.invoke.mockImplementation(async (command) =>
      command === "workflow_run_get"
        ? {
            run: { status: "completed" },
            nodes: [
              {
                nodeId: "shot-s1",
                status: "done",
                output: JSON.stringify({ kind: "video", artifactId: "take.mp4" }),
              },
            ],
          }
        : null,
    );

    await mount();

    await waitFor(() =>
      expect(saveArtifactMetadata).toHaveBeenCalledWith({
        id: "take.mp4",
        title: "Concert take",
        projectIds: ["project-1"],
      }),
    );
    expect(project.document.runs[0].appliedNodeIds).toEqual(["shot-s1"]);
  });

  it("re-quotes only unpaid resume steps and waits for confirmation", async () => {
    project.document.runs = [{ id: "run-1", shotSignatures: {} }];
    project.document.settings.budget = 30;
    const definition: Workflow = {
      id: "graph",
      name: "Concert",
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: ["finished", "pending", "s1"].map((id) => ({
        id: `shot-${id}`,
        type: "video",
        label: id,
        position: { x: 0, y: 0 },
        params: { model: "test-text-to-video", prompt: "A shot" },
      })),
    };
    mocks.invoke.mockImplementation(async (command) =>
      command === "media_job_list"
        ? [{ id: "paid-job", status: "processing" }]
        : command === "workflow_run_get"
          ? {
              run: {
                status: "failed",
                definition: JSON.stringify(definition),
                nodeCosts: JSON.stringify({ "shot-finished": 8, "shot-pending": 8, "shot-s1": 8 }),
              },
              nodes: [
                {
                  nodeId: "shot-finished",
                  status: "done",
                  output: JSON.stringify({ kind: "video", artifactId: "finished.mp4" }),
                },
                {
                  nodeId: "shot-pending",
                  status: "error",
                  output: JSON.stringify({ pendingJobId: "paid-job" }),
                },
                { nodeId: "shot-s1", status: "pending" },
              ],
            }
          : null,
    );
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resume production" }));
    await screen.findByRole("dialog", { name: "Review generation costs" });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.quote.mock.calls.at(-1)?.[0].nodes.map((node: { id: string }) => node.id)).toEqual(
      ["shot-s1"],
    );
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await waitFor(() =>
      expect(mocks.resume).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          requireExistingOutputs: true,
          nodeCosts: { "shot-finished": 8, "shot-pending": 8, "shot-s1": 10 },
        }),
      ),
    );
    expect(mocks.budget).toHaveBeenCalledWith(expect.anything(), 14);
  });

  it("quotes a replacement for a definitively failed render before resuming", async () => {
    project.document.runs = [{ id: "run-1", shotSignatures: {} }];
    project.document.settings.budget = 30;
    const definition: Workflow = {
      id: "graph",
      name: "Concert",
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: [
        {
          id: "shot-s1",
          type: "video",
          label: "Shot",
          position: { x: 0, y: 0 },
          params: { model: "test-text-to-video", prompt: "A shot" },
        },
      ],
    };
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "media_job_list")
        return [{ id: "failed-job", status: "failed", submissionConfirmed: true }];
      if (command === "workflow_run_get")
        return {
          run: {
            status: "failed",
            definition: JSON.stringify(definition),
            nodeCosts: JSON.stringify({ "shot-s1": 8 }),
          },
          nodes: [
            {
              nodeId: "shot-s1",
              status: "error",
              output: JSON.stringify({ pendingJobId: "failed-job" }),
            },
          ],
        };
      return null;
    });
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resume production" }));
    await screen.findByRole("dialog", { name: "Review generation costs" });
    expect(mocks.quote.mock.calls.at(-1)?.[0].nodes.map((node: { id: string }) => node.id)).toEqual(
      ["shot-s1"],
    );
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await waitFor(() =>
      expect(mocks.resume).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ redoNodeIds: ["shot-s1"], requireExistingOutputs: true }),
      ),
    );
    expect(mocks.budget).toHaveBeenCalledWith(expect.anything(), 22);
  });

  it("quotes a new synchronous take and warns that the first request may have charged", async () => {
    project.document.runs = [{ id: "run-1", shotSignatures: {} }];
    project.document.settings.budget = 30;
    const definition: Workflow = {
      id: "graph",
      name: "Concert",
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: [
        {
          id: "voice",
          type: "tts",
          label: "Line 1",
          position: { x: 0, y: 0 },
          params: { model: "tts-kokoro", text: "Hello" },
        },
      ],
    };
    mocks.quote.mockResolvedValue({
      nodes: [{ nodeId: "voice", type: "tts", label: "Line 1", kind: "flat", credits: 10 }],
      credits: 10,
      metered: 0,
      quotable: 0,
    });
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "media_job_list") return [];
      if (command === "workflow_run_get")
        return {
          run: {
            status: "failed",
            definition: JSON.stringify(definition),
            nodeCosts: JSON.stringify({ voice: 8 }),
          },
          nodes: [
            {
              nodeId: "voice",
              status: "error",
              output: JSON.stringify({ submissionStarted: true }),
            },
          ],
        };
      return null;
    });
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resume production" }));
    const dialog = await screen.findByRole("dialog", { name: "Review generation costs" });
    expect(within(dialog).getByText(/may already have been charged/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Generate · 10 credits/ }));
    await waitFor(() =>
      expect(mocks.resume).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ redoNodeIds: ["voice"], requireExistingOutputs: true }),
      ),
    );
    expect(mocks.budget).toHaveBeenCalledWith(expect.anything(), 22);
  });

  it("requires a new quote after the draft changes", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
    await screen.findByRole("dialog");
    fireEvent.blur(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "New title" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await screen.findByText(
      "The project changed while quoting. Review its settings and quote again.",
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("keeps a recorded run when unmounted so paid work can be recovered", async () => {
    let publish: ((result: NodeRunResult) => void) | undefined;
    mocks.run.mockImplementation(async (_workflow, options) => {
      await options.onRunRecorded("run-1");
      publish = options.onUpdate;
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Paused", "AbortError")),
        ),
      );
    });
    const mounted = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await waitFor(() => expect(project.document.runs[0]?.id).toBe("run-1"));
    expect(screen.getByRole("button", { name: "Media" })).toBeDisabled();
    await act(async () => mounted.unmount());
    expect(project.document.runs[0].id).toBe("run-1");
    // A delivery that wins the abort race still belongs to the originating project.
    await act(async () =>
      publish?.({
        nodeId: "shot-s1",
        status: "done",
        output: { kind: "video", artifactId: "late.mp4", src: "late.mp4" },
      }),
    );
    await waitFor(() => expect(project.document.artifactIds).toContain("late.mp4"));
  });
});
