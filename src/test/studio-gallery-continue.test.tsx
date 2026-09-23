import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryStrip } from "../components/studio/GalleryStrip";
import type { StudioArtifact } from "../lib/studio/types";

const CLIP: StudioArtifact = {
  id: "clip-1.mp4",
  kind: "video",
  path: "/gallery/clip-1.mp4",
  fileName: "clip-1.mp4",
  bytes: 1024,
  model: "seedance-2-0-image-to-video",
  prompt: "A woman walks along a rainy platform",
  createdAt: 0,
};

const IMAGE: StudioArtifact = { ...CLIP, id: "shot.png", kind: "image", fileName: "shot.png" };

const artifacts = vi.hoisted(() => ({ list: vi.fn() }));
const projects = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }));

vi.mock("../lib/studio/projects", () => ({
  listProjects: projects.list,
  organizeArtifact: projects.save,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: artifacts.list,
  deleteArtifact: vi.fn(),
  exportArtifact: vi.fn(),
}));

describe("continue a shot from the gallery", () => {
  beforeEach(() => {
    artifacts.list.mockReset();
    projects.list.mockReset();
    projects.save.mockReset();
    projects.list.mockResolvedValue([]);
  });

  it("offers the gesture on a clip and hands the artifact over", async () => {
    artifacts.list.mockResolvedValue([CLIP]);
    const onContinue = vi.fn();
    render(<GalleryStrip kind="video" epoch={0} onContinue={onContinue} />);

    const button = await screen.findByRole("button", { name: "Continue this shot" });
    await userEvent.click(button);
    expect(onContinue).toHaveBeenCalledWith(CLIP);
  });

  it("disables the gesture on the clip being read, and only that one", async () => {
    const second = { ...CLIP, id: "clip-2.mp4", fileName: "clip-2.mp4" };
    artifacts.list.mockResolvedValue([CLIP, second]);
    render(<GalleryStrip kind="video" epoch={0} onContinue={vi.fn()} continuingId="clip-1.mp4" />);

    const buttons = await screen.findAllByRole("button", { name: "Continue this shot" });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
  });

  it("stays out of the way when no handler is wired, and off images", async () => {
    artifacts.list.mockResolvedValue([CLIP]);
    const { unmount } = render(<GalleryStrip kind="video" epoch={0} />);
    await screen.findByRole("button", { name: "Save a copy" });
    expect(screen.queryByRole("button", { name: "Continue this shot" })).toBeNull();
    unmount();

    artifacts.list.mockResolvedValue([IMAGE]);
    render(<GalleryStrip kind="image" epoch={0} onContinue={vi.fn()} />);
    await waitFor(() => expect(artifacts.list).toHaveBeenCalledWith("image"));
    expect(screen.queryByRole("button", { name: "Continue this shot" })).toBeNull();
  });

  it("renames a clip and files it under a project without changing the media file", async () => {
    let entries = [{ ...CLIP, title: "First name", projectIds: [] as string[] }];
    artifacts.list.mockImplementation(async () => entries);
    projects.list.mockResolvedValue([
      { id: "film-1", name: "Concert", archived: false, revision: 1, updatedAt: "" },
    ]);
    projects.save.mockImplementation(
      async (request: { id: string; title: string; projectIds: string[] }) => {
        entries = entries.map((entry) =>
          entry.id === request.id
            ? { ...entry, title: request.title, projectIds: request.projectIds }
            : entry,
        );
        return entries[0];
      },
    );
    render(<GalleryStrip kind="video" epoch={0} />);

    await userEvent.click(await screen.findByRole("button", { name: "Organize media" }));
    const dialog = screen.getByRole("dialog", { name: "Organize media" });
    await userEvent.clear(within(dialog).getByLabelText("Media name"));
    await userEvent.type(within(dialog).getByLabelText("Media name"), "Final concert take");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Concert" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(projects.save).toHaveBeenCalledWith({
        id: CLIP.id,
        title: "Final concert take",
        projectIds: ["film-1"],
      }),
    );
    await waitFor(() => expect(screen.getByText("Final concert take")).toBeVisible());
    await userEvent.selectOptions(screen.getByLabelText("Filter by project"), "film-1");
    expect(screen.getByText("Final concert take")).toBeVisible();
    expect(artifacts.list).toHaveBeenCalledWith("video");
  });
});
