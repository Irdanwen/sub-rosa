import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrameCaptureDialog } from "../components/studio/FrameCaptureDialog";
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

const frames = vi.hoisted(() => ({ handoff: vi.fn(), at: vi.fn() }));
const artifacts = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: artifacts.list,
  saveArtifactFromBase64: artifacts.save,
  deleteArtifact: vi.fn(),
  exportArtifact: vi.fn(),
}));
vi.mock("../lib/studio/frames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/frames")>()),
  extractHandoffFrame: frames.handoff,
  extractFrameAt: frames.at,
}));

/** A decoded frame, as `frames.ts` hands one back. */
function frame(timeSeconds: number, dataUrl: string) {
  return { dataUrl, timeSeconds, durationSeconds: 5, sharpness: 1, width: 1920, height: 1080 };
}

describe("capturing a frame", () => {
  beforeEach(() => {
    frames.handoff.mockReset();
    frames.at.mockReset();
    artifacts.list.mockReset();
    artifacts.save.mockReset();
    frames.handoff.mockResolvedValue(frame(4.5, "data:image/jpeg;base64,preview"));
    frames.at.mockResolvedValue(frame(4.5, "data:image/png;base64,full"));
    artifacts.save.mockResolvedValue({ ...IMAGE, id: "still.png", fileName: "still.png" });
  });

  it("opens on the sharpest frame near the end rather than on the first one", async () => {
    render(<FrameCaptureDialog artifact={CLIP} onClose={vi.fn()} />);

    await waitFor(() => expect(frames.handoff).toHaveBeenCalledWith("asset:///gallery/clip-1.mp4"));
    expect(await screen.findByAltText("Frame at 4.5s")).toBeTruthy();
  });

  it("saves the full-quality re-read, not the preview the scrubber affords", async () => {
    const onCaptured = vi.fn();
    render(<FrameCaptureDialog artifact={CLIP} onClose={vi.fn()} onCaptured={onCaptured} />);
    await screen.findByAltText("Frame at 4.5s");

    await userEvent.click(screen.getByRole("button", { name: "Save to the gallery" }));

    await waitFor(() => expect(artifacts.save).toHaveBeenCalled());
    // The preview on screen is a downscaled JPEG; what gets saved is a fresh
    // read at capture encoding, which is the whole point of the second pass.
    expect(frames.at).toHaveBeenCalledWith("asset:///gallery/clip-1.mp4", 4.5, {
      encoding: "capture",
    });
    const [base64, extension] = artifacts.save.mock.calls[0];
    expect(base64).toBe("full");
    expect(extension).toBe("png");
    expect(onCaptured).toHaveBeenCalled();
  });

  it("records where the still came from without joining the clip's chain", async () => {
    render(<FrameCaptureDialog artifact={CLIP} onClose={vi.fn()} />);
    await screen.findByAltText("Frame at 4.5s");

    await userEvent.click(screen.getByRole("button", { name: "Save to the gallery" }));

    await waitFor(() => expect(artifacts.save).toHaveBeenCalled());
    const metadata = artifacts.save.mock.calls[0][2];
    expect(metadata.sourceArtifactId).toBe("clip-1.mp4");
    expect(metadata.sourceTimeSeconds).toBe(4.5);
    expect(metadata.kind).toBe("image");
    // `chain.ts` walks parentId to rebuild a shot chain; a still is not a shot.
    expect(metadata.parentId).toBeUndefined();
    // Nothing generated this image, so no model may claim it.
    expect(metadata.model).toBe("");
  });

  it("keeps the reset available after jumping to the last frame", async () => {
    // The reset compares against where the automatic pick landed, not against
    // whatever the preview currently shows - otherwise every settled position
    // reads as "the default" and greys the button out where it is most wanted.
    render(<FrameCaptureDialog artifact={CLIP} onClose={vi.fn()} />);
    await screen.findByAltText("Frame at 4.5s");
    const reset = screen.getByRole("button", { name: "Sharpest near the end" });
    expect(reset).toBeDisabled();

    frames.at.mockResolvedValue(frame(4.96, "data:image/jpeg;base64,tail"));
    await userEvent.click(screen.getByRole("button", { name: "Last frame" }));

    await waitFor(() => expect(reset).toBeEnabled());
    expect(screen.getByRole("button", { name: "Last frame" })).toBeDisabled();
    // Not "5s of 5s": the tenth-of-a-second rounding would print the end stop
    // as the full duration, contradicting the note about stopping short.
    expect(screen.getByText("Last frame of 5s")).toBeTruthy();
    expect(screen.queryByText("5s of 5s")).toBeNull();
  });

  it("says where the still went, since it lands out of sight of a clip list", async () => {
    artifacts.list.mockResolvedValue([CLIP]);
    render(<GalleryStrip kind="video" epoch={0} />);
    await userEvent.click(await screen.findByRole("button", { name: "Capture a frame" }));
    await screen.findByAltText("Frame at 4.5s");

    await userEvent.click(screen.getByRole("button", { name: "Save to the gallery" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Saved to the image gallery.");
  });

  it("keeps the clip out of the gallery when the read fails", async () => {
    frames.handoff.mockRejectedValue(new Error("no decoder"));
    render(<FrameCaptureDialog artifact={CLIP} onClose={vi.fn()} />);

    expect(await screen.findByText("Couldn't read a frame from that clip.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save to the gallery" })).toBeDisabled();
    expect(artifacts.save).not.toHaveBeenCalled();
  });

  it("is offered on clips and withheld from images", async () => {
    artifacts.list.mockResolvedValue([CLIP]);
    const { unmount } = render(<GalleryStrip kind="video" epoch={0} />);
    expect(await screen.findByRole("button", { name: "Capture a frame" })).toBeTruthy();
    unmount();

    artifacts.list.mockResolvedValue([IMAGE]);
    render(<GalleryStrip kind="image" epoch={0} />);
    await waitFor(() => expect(artifacts.list).toHaveBeenCalledWith("image"));
    expect(screen.queryByRole("button", { name: "Capture a frame" })).toBeNull();
  });
});
