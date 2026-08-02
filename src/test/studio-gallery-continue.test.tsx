import { render, screen, waitFor } from "@testing-library/react";
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
});
