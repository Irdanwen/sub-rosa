import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(),
}));

import { Popover } from "../components/ui/Popover";
import { StageScene } from "../components/studio/stage/Scene";
import { clipThumbnailSrc } from "../lib/studio/artifacts";

// What the first real render in the native window showed (2026-10-13), that
// a browser and jsdom do not: WKWebView paints no frame of a paused clip, and
// refuses focus to a hidden element.
describe("the native webview", () => {
  it("asks a clip thumbnail to seek, so its first frame is painted", () => {
    expect(clipThumbnailSrc({ path: "/gallery/lake.mp4" })).toBe(
      "asset://localhost/%2Fgallery%2Flake.mp4#t=0.1",
    );
  });

  it("seeks a clip on the stage that has no poster, and leaves one that has", () => {
    const { container, rerender } = render(
      <StageScene result={{ kind: "video", src: "asset://clip.mp4" }} />,
    );
    expect(container.querySelector("video")?.getAttribute("src")).toBe("asset://clip.mp4#t=0.1");
    rerender(
      <StageScene
        result={{ kind: "video", src: "asset://clip.mp4", poster: "data:image/png;base64,x" }}
      />,
    );
    expect(container.querySelector("video")?.getAttribute("src")).toBe("asset://clip.mp4");
  });

  it("keeps an unplaced popover focusable: transparent, never hidden", () => {
    const anchor = createRef<HTMLButtonElement>();
    render(
      <Popover anchorRef={anchor} open onClose={() => undefined} label="Models">
        <input aria-label="Search models" />
      </Popover>,
    );
    const surface = screen.getByLabelText("Models", { selector: "div" });
    expect(surface.style.visibility).not.toBe("hidden");
    expect(surface.style.opacity).toBe("0");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search models" }));
  });
});
