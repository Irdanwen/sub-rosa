import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioArtifact } from "../lib/studio/types";

const mocks = vi.hoisted(() => ({ importImageFile: vi.fn() }));
vi.mock("../components/studio/retouch/RetouchPicker", () => ({
  importImageFile: mocks.importImageFile,
}));
vi.mock("../lib/artifact-media", () => ({
  useArtifactThumbnail: () => null,
}));

import { RetouchLauncher } from "../components/mobile/screens/studio/RetouchLauncher";
import { OPEN_RETOUCH_EVENT } from "../lib/studio/retouch/jobs";

function image(id: string, edit?: StudioArtifact["edit"]): StudioArtifact {
  return {
    id,
    kind: "image",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1,
    model: "",
    prompt: id,
    createdAt: 1,
    ...(edit ? { edit } : {}),
  };
}

function opened(): string[] {
  const heard: string[] = [];
  window.addEventListener(OPEN_RETOUCH_EVENT, (event) =>
    heard.push((event as CustomEvent<string>).detail),
  );
  return heard;
}

beforeEach(() => mocks.importImageFile.mockReset());

describe("starting a retouch on a phone", () => {
  it("brings a photo from the library into the gallery and opens it", async () => {
    const heard = opened();
    mocks.importImageFile.mockResolvedValue(image("photo.jpg"));
    const { container } = render(<RetouchLauncher galleryImages={[]} />);
    const [library, camera] = container.querySelectorAll<HTMLInputElement>("input[type=file]");
    expect(library.accept).toBe("image/*");
    expect(camera.getAttribute("capture")).toBe("environment");
    const photo = new File(["x"], "IMG_0001.HEIC", { type: "image/heic" });
    await act(async () => {
      fireEvent.change(library, { target: { files: [photo] } });
    });
    expect(mocks.importImageFile).toHaveBeenCalledWith(photo);
    expect(heard).toContain("photo.jpg");
  });

  it("offers the Studio's own pictures and the sessions to pick up", () => {
    const heard = opened();
    render(
      <RetouchLauncher
        galleryImages={[
          image("render.png"),
          image("v1.png", { of: "render.png", root: "render.png", op: "prompt", n: 1 }),
        ]}
      />,
    );
    expect(screen.getByText("Pick up a retouch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "From Studio" }));
    const cells = screen
      .getAllByRole("button")
      .filter((button) => button.className === "mobile-studio-cell");
    // The originals, then the session (opened on its latest version).
    fireEvent.click(cells[cells.length - 1]);
    expect(heard).toContain("v1.png");
  });
});
