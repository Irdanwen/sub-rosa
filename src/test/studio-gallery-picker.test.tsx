import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryPicker } from "../components/studio/GalleryPicker";
import type { StudioArtifact } from "../lib/studio/types";

const IMAGE: StudioArtifact = {
  id: "shot.webp",
  kind: "image",
  path: "/gallery/shot.webp",
  fileName: "shot.webp",
  bytes: 2048,
  model: "qwen-image",
  prompt: "A rainy platform at dusk",
  createdAt: 0,
};

const artifacts = vi.hoisted(() => ({ list: vi.fn() }));
const media = vi.hoisted(() => ({ dataUrl: vi.fn() }));

vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: artifacts.list,
}));
vi.mock("../lib/artifact-media", () => ({ artifactDataUrl: media.dataUrl }));

describe("picking from the gallery", () => {
  beforeEach(() => {
    artifacts.list.mockReset();
    media.dataUrl.mockReset();
    media.dataUrl.mockResolvedValue("data:image/webp;base64,bytes");
  });

  it("offers the images already produced and hands one back as a data URI", async () => {
    artifacts.list.mockResolvedValue([IMAGE]);
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<GalleryPicker onPick={onPick} onClose={onClose} />);

    const cell = await screen.findByRole("button", { name: "A rainy platform at dusk" });
    await userEvent.click(cell);

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    // Read through the media loader, so a webp is not mislabelled as a PNG the
    // way a hand-built data URI prefix would.
    // The third argument is the bible entry a pick came from, and there is
    // none here: this one came out of the plain gallery.
    expect(onPick).toHaveBeenCalledWith("data:image/webp;base64,bytes", IMAGE, undefined);
    expect(onClose).toHaveBeenCalled();
  });

  it("only offers the requested kinds, whatever else is in the gallery", async () => {
    const clip: StudioArtifact = {
      ...IMAGE,
      id: "clip.mp4",
      kind: "video",
      path: "/gallery/clip.mp4",
      fileName: "clip.mp4",
      prompt: "A tracking shot",
    };
    artifacts.list.mockResolvedValue([IMAGE, clip]);
    render(<GalleryPicker onPick={vi.fn()} onClose={vi.fn()} />);

    await screen.findByRole("button", { name: "A rainy platform at dusk" });
    expect(screen.queryByRole("button", { name: "A tracking shot" })).toBeNull();
  });

  it("says the gallery is empty rather than showing a blank sheet", async () => {
    artifacts.list.mockResolvedValue([]);
    render(<GalleryPicker onPick={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  it("stays open and says so when the file cannot be read", async () => {
    artifacts.list.mockResolvedValue([IMAGE]);
    media.dataUrl.mockRejectedValue(new Error("gone"));
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<GalleryPicker onPick={onPick} onClose={onClose} />);

    await userEvent.click(await screen.findByRole("button", { name: "A rainy platform at dusk" }));

    expect(await screen.findByText("Couldn't read that item from the gallery.")).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
