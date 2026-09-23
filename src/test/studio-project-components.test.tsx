import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectShots } from "../components/studio/ProjectShots";
import { ProjectBible } from "../components/studio/ProjectBible";
import { ProjectMedia } from "../components/studio/ProjectMedia";
import {
  newProject,
  newShot,
  type ProjectBibleEntry,
  type ProjectDocument,
  type ProjectShot,
} from "../lib/studio/projects";
import type { MediaCatalog, MediaModel, StudioArtifact } from "../lib/studio/types";

const fixtures = vi.hoisted(() => ({ invoke: vi.fn(), picked: "image-1", onChange: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fixtures.invoke }));
vi.mock("../lib/studio/artifacts", () => ({
  artifactSrc: (artifact: StudioArtifact) => `asset://${artifact.fileName}`,
  exportArtifact: vi.fn(async () => undefined),
}));
vi.mock("../components/studio/MediaModelPicker", () => ({
  mediaModelOption: (model: MediaModel) => ({ id: model.id, name: model.name }),
  MediaModelPicker: ({
    options,
    value,
    onChange,
    ariaLabel,
  }: {
    options: Array<{ id: string; name: string }>;
    value: string;
    onChange: (id: string) => void;
    ariaLabel: string;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose model</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../components/studio/GalleryPicker", () => ({
  GalleryPicker: ({
    onPick,
    onClose,
  }: {
    onPick: (data: string, artifact: StudioArtifact) => void;
    onClose: () => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onPick("", artifact(fixtures.picked));
        onClose();
      }}
    >
      Choose gallery fixture
    </button>
  ),
}));

function artifact(id: string, kind: StudioArtifact["kind"] = "image"): StudioArtifact {
  return {
    id,
    kind,
    fileName: id,
    path: `/gallery/${id}`,
    bytes: 10,
    model: "model",
    prompt: "",
    createdAt: 1,
    projectIds: ["project-a", "project-b"],
  };
}
function model(id: string, mediaType: MediaModel["mediaType"]): MediaModel {
  return {
    id,
    mediaType,
    name: id,
    offline: false,
    costCredits: 1,
    constraints: { durations: ["5s", "10s"], resolutions: ["720p", "1080p"] },
  };
}
const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    model("video-text", "video"),
    model("video-image", "imageToVideo"),
    model("video-reference", "referenceToVideo"),
    model("image-edit", "imageEdit"),
    model("portrait-image", "image"),
  ],
};
function Shots({
  initial,
  onImage = vi.fn(),
}: {
  initial: ProjectDocument;
  onImage?: (id: string) => void;
}) {
  const [document, setDocument] = useState(initial);
  return (
    <ProjectShots
      document={document}
      onChange={(shots) => {
        fixtures.onChange(shots);
        setDocument({ ...document, shots });
      }}
      artifacts={[
        artifact("image-1"),
        artifact("image-2"),
        artifact("image-3"),
        artifact("image-4"),
      ]}
      catalog={catalog}
      onGenerate={vi.fn()}
      onImage={onImage}
      onBible={vi.fn()}
      busy={false}
    />
  );
}
function shotDocument(patch: Partial<ProjectShot> = {}): ProjectDocument {
  const document = newProject("Film").document;
  document.shots = [{ ...newShot(0), id: "shot-one", modelId: "video-text", ...patch }];
  return document;
}
function bibleEntry(kind: ProjectBibleEntry["kind"] = "location"): ProjectBibleEntry {
  return {
    id: "entry",
    name: "Concert hall",
    kind,
    traits: "Warm lights",
    note: "",
    refs: [],
    imageModelId: "portrait-image",
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.invoke.mockResolvedValue([]);
  fixtures.picked = "image-1";
});

describe("shot editing", () => {
  it("edits accessible prompts and duration independently and preserves choices on mode change", () => {
    render(<Shots initial={shotDocument({ action: "An old prompt" })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Video prompt" }), {
      target: { value: "Move closer" },
    });
    fireEvent.change(screen.getByLabelText("Generation duration"), { target: { value: "10s" } });
    expect(fixtures.onChange.mock.lastCall?.[0][0]).toMatchObject({
      prompt: "Move closer",
      action: "An old prompt",
      duration: "10s",
    });
    fireEvent.change(screen.getByLabelText("Generation mode"), { target: { value: "image" } });
    const choices = screen.getByLabelText("Video model") as HTMLSelectElement;
    expect(Array.from(choices.options, (option) => option.value)).toEqual(["", "video-image"]);
    fireEvent.change(choices, { target: { value: "video-image" } });
    expect(fixtures.onChange.mock.lastCall?.[0][0]).toMatchObject({
      prompt: "Move closer",
      modelId: "video-image",
      duration: "10s",
      mode: "image",
    });
  });

  it("deduplicates image references and requires explicit opening image selection", () => {
    const onImage = vi.fn();
    render(
      <Shots
        initial={shotDocument({
          mode: "image",
          modelId: "video-image",
          imageReferenceIds: ["image-1", "image-2"],
        })}
        onImage={onImage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add reference image" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose gallery fixture" }));
    expect(fixtures.onChange).not.toHaveBeenCalled();
    fixtures.picked = "image-3";
    fireEvent.click(screen.getByRole("button", { name: "Add reference image" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose gallery fixture" }));
    expect(fixtures.onChange.mock.lastCall?.[0][0].imageReferenceIds).toEqual([
      "image-1",
      "image-2",
      "image-3",
    ]);
    expect(screen.getByRole("button", { name: "Add reference image" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Image prompt" }), {
      target: { value: "Compose a wide shot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Quote opening image" }));
    expect(onImage).toHaveBeenCalledWith("shot-one");
    expect(fixtures.onChange.mock.lastCall?.[0][0].openingArtifactId).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Choose opening image" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose gallery fixture" }));
    expect(fixtures.onChange.mock.lastCall?.[0][0].openingArtifactId).toBe("image-3");
  });

  it("keeps over-limit legacy references visible and blocks their generation instead of truncating", () => {
    render(
      <Shots
        initial={shotDocument({
          mode: "image",
          modelId: "video-image",
          imageReferenceIds: ["image-1", "image-2", "image-3", "image-4"],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Quote opening image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add reference image" })).toBeDisabled();
    expect(screen.getAllByRole("img")).toHaveLength(4);
    expect(fixtures.onChange).not.toHaveBeenCalled();
  });
});

describe("project bible", () => {
  it("registers copied library references with the project", async () => {
    const source = {
      ...bibleEntry("character"),
      refs: [
        {
          id: "library-ref",
          entryId: "entry",
          artifactId: "portrait.png",
          role: "portrait" as const,
          label: "Portrait",
          ordinal: 0,
        },
      ],
    };
    fixtures.invoke.mockResolvedValueOnce([source]);
    const onArtifact = vi.fn();
    render(
      <ProjectBible
        entries={[]}
        onChange={fixtures.onChange}
        artifacts={[artifact("portrait.png")]}
        catalog={catalog}
        onArtifact={onArtifact}
        onGenerate={vi.fn()}
        busy={false}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Copy from your library")).toHaveTextContent("Concert hall"),
    );
    fireEvent.change(screen.getByLabelText("Copy from your library"), {
      target: { value: "entry" },
    });
    expect(onArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: "portrait.png" }));
    expect(fixtures.onChange.mock.lastCall?.[0][0].refs[0]).toMatchObject({
      artifactId: "portrait.png",
      role: "portrait",
    });
  });

  it("uses a compatible role when a location is initially selected", async () => {
    const onGenerate = vi.fn();
    render(
      <ProjectBible
        entries={[bibleEntry()]}
        onChange={fixtures.onChange}
        artifacts={[]}
        catalog={catalog}
        onArtifact={vi.fn()}
        onGenerate={onGenerate}
        busy={false}
      />,
    );
    await waitFor(() => expect(fixtures.invoke).toHaveBeenCalledWith("list_bible_entries"));
    expect(screen.getByLabelText("Reference role")).toHaveValue("wide");
    fireEvent.change(screen.getByRole("textbox", { name: "Invariant traits" }), {
      target: { value: "Cold daylight" },
    });
    expect(fixtures.onChange.mock.lastCall?.[0][0]).toMatchObject({
      id: "entry",
      traits: "Cold daylight",
    });
    fireEvent.click(screen.getByRole("button", { name: /Generate reference/ }));
    expect(onGenerate).toHaveBeenCalledWith("entry", "wide");
  });

  it("renames by stable id so the parent can preserve shot links", async () => {
    render(
      <ProjectBible
        entries={[bibleEntry("character")]}
        onChange={fixtures.onChange}
        artifacts={[]}
        catalog={catalog}
        onArtifact={vi.fn()}
        onGenerate={vi.fn()}
        busy={false}
      />,
    );
    await waitFor(() => expect(fixtures.invoke).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Baptiste" } });
    expect(fixtures.onChange.mock.lastCall?.[0][0]).toMatchObject({
      id: "entry",
      name: "Baptiste",
    });
  });
});

describe("project media", () => {
  it("renames a media file while retaining every project membership", async () => {
    const onMetadata = vi.fn(async () => undefined);
    const clip = artifact("take.mp4", "video");
    render(
      <ProjectMedia
        artifacts={[clip]}
        projects={[]}
        projectId="project-a"
        onMetadata={onMetadata}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "take.mp4" }));
    fireEvent.change(screen.getByLabelText("Media name"), { target: { value: "Final take" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onMetadata).toHaveBeenCalledWith(clip, "Final take", ["project-a", "project-b"]),
    );
  });

  it("does not attach media when persisting membership fails", async () => {
    const onAttach = vi.fn();
    render(
      <ProjectMedia
        artifacts={[{ ...artifact("line.wav", "speech"), projectIds: [] }]}
        projects={[]}
        projectId="project-a"
        onMetadata={vi.fn(async () => {
          throw new Error("studio_project_storage_error");
        })}
        onAttach={onAttach}
      />,
    );
    fireEvent.click(screen.getByLabelText("Show all projects"));
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    await screen.findByRole("alert");
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("finds imported files by filename and offers sound effects as a media type", () => {
    render(
      <ProjectMedia
        artifacts={[artifact("steps.wav", "sfx"), artifact("dialogue.wav", "speech")]}
        projects={[]}
        onMetadata={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Media type"), { target: { value: "sfx" } });
    fireEvent.change(screen.getByLabelText("Search media"), { target: { value: "steps.wav" } });
    expect(screen.getByRole("button", { name: "steps.wav" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "dialogue.wav" })).not.toBeInTheDocument();
  });
});
