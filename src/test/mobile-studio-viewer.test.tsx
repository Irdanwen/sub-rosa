/**
 * The viewer: one item full screen, its neighbours a swipe away, a pull down
 * to close, a delete that asks first, what the item is one tap away, and a
 * clip's own controls instead of the system bar.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioViewer } from "../components/mobile/screens/studio/StudioViewer";
import type { StudioArtifact } from "../lib/studio/types";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const uuid = (n: number) => `0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c${String(n).padStart(2, "0")}`;
function item(n: number, kind: StudioArtifact["kind"], prompt: string): StudioArtifact {
  const ext = kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3";
  return {
    id: `${uuid(n)}.${ext}`,
    kind,
    path: `/gallery/${uuid(n)}.${ext}`,
    fileName: `${uuid(n)}.${ext}`,
    bytes: 10,
    model: "kling-v3",
    prompt,
    createdAt: Date.UTC(2026, 9, 3, 12),
    width: 1920,
    height: 1080,
    durationMs: 8000,
  };
}
const LIST = [
  item(1, "image", "A lighthouse"),
  item(2, "video", "A tram"),
  item(3, "music", "A waltz"),
];

beforeEach(() => {
  tauri.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "studio_library_list") return { collections: [], marks: [] };
    if (command === "carpe_diem_media_read_artifact") return "AAAA";
    return undefined;
  });
});

function renderViewer(at: number, overrides: Partial<Parameters<typeof StudioViewer>[0]> = {}) {
  const props = {
    artifact: LIST[at],
    among: LIST,
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onUpscaled: vi.fn(),
    ...overrides,
  };
  render(<StudioViewer {...props} />);
  return props;
}

function swipe(element: Element, dx: number, dy: number) {
  fireEvent.touchStart(element, { touches: [{ clientX: 200, clientY: 300 }], timeStamp: 0 });
  fireEvent.touchMove(element, { touches: [{ clientX: 200 + dx / 2, clientY: 300 + dy / 2 }] });
  fireEvent.touchMove(element, { touches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
  fireEvent.touchEnd(element, { touches: [], timeStamp: 600 });
}

describe("the viewer", () => {
  it("says where it is in the list and moves to the neighbours", async () => {
    const props = renderViewer(1);
    expect(screen.getByText("2 of 3")).toBeTruthy();
    await userEvent.keyboard("{ArrowRight}");
    expect(props.onNavigate).toHaveBeenLastCalledWith(LIST[2]);
    await userEvent.keyboard("{ArrowLeft}");
    expect(props.onNavigate).toHaveBeenLastCalledWith(LIST[0]);
  });

  it("goes to the next item on a swipe left and closes on a pull down", () => {
    const props = renderViewer(1);
    const stage = document.querySelector(".viewer-stage") as HTMLElement;
    swipe(stage, -260, 0);
    expect(props.onNavigate).toHaveBeenCalledWith(LIST[2]);
    swipe(stage, 0, 220);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("does not move past the last item", () => {
    const props = renderViewer(2);
    swipe(document.querySelector(".viewer-stage") as HTMLElement, -260, 0);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("asks before deleting", async () => {
    const props = renderViewer(0);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(
      screen.getByText("They are deleted from this device and from your other synced devices."),
    ).toBeTruthy();
    const sheets = screen.getAllByRole("dialog");
    await userEvent.click(
      within(sheets.at(-1) as HTMLElement).getByRole("button", { name: "Delete" }),
    );
    expect(props.onDelete).toHaveBeenCalled();
  });

  it("shows what the item is on request", async () => {
    renderViewer(1);
    await userEvent.click(screen.getByRole("button", { name: "About this item" }));
    const info = screen.getByRole("region", { name: "About this item" });
    expect(within(info).getByText("A tram")).toBeTruthy();
    expect(within(info).getByText("kling-v3")).toBeTruthy();
    expect(within(info).getByText("1920 × 1080")).toBeTruthy();
    expect(within(info).getByText("0:08")).toBeTruthy();
  });

  it("plays a clip with its own controls rather than the system bar", () => {
    renderViewer(1);
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video).toBeTruthy();
    expect(video.hasAttribute("controls")).toBe(false);
    // Eight seconds: a moving photo, so it loops.
    expect(video.loop).toBe(true);
    expect(screen.getByRole("slider", { name: "Position" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^(Play|Pause)$/ })).toBeTruthy();
  });
});
