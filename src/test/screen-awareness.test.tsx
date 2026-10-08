/**
 * "What I'm looking at" (ADR-0094): the chip says what will be attached, can
 * be removed, and the composer's menu item turns a capture into ordinary
 * attachments only after a click.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let awareness: unknown = { enabled: true, screenshots: false };
let capture: () => unknown = () => ({});
const invokeMock = vi.fn(async (command: string, _args?: unknown) => {
  if (command === "screen_awareness_settings") return awareness;
  if (command === "screen_awareness_capture") return capture();
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

import { LookingAtMenuItem } from "../components/agent/LookingAtMenuItem";
import { LookingAtChip } from "../components/chat-bar/LookingAtChip";
import {
  type LookingAt,
  lookingAtChipDetail,
  lookingAtChipLabel,
  lookingAtPaths,
  screenshotNotice,
} from "../lib/screen-awareness";

const sample: LookingAt = {
  appName: "Safari",
  windowTitle: "Flights to Lisbon",
  selectedText: "Departs 07:10",
  accessibility: true,
  contextPath: "/data/looking-at/1/Looking at Safari.md",
  capturedAt: "2026-10-08T10:00:00Z",
};

beforeEach(() => {
  invokeMock.mockClear();
  awareness = { enabled: true, screenshots: false };
  capture = () => sample;
});

describe("the chip", () => {
  it("names the app and window, and what rides along", () => {
    expect(lookingAtChipLabel(sample)).toBe("Safari: Flights to Lisbon");
    expect(lookingAtChipLabel({ ...sample, windowTitle: "Safari" })).toBe("Safari");
    expect(lookingAtChipLabel({ ...sample, windowTitle: "x".repeat(80) })).toHaveLength(
      "Safari: ".length + 48,
    );
    expect(lookingAtChipDetail(sample)).toBe("13 characters selected");
    expect(lookingAtChipDetail({ ...sample, selectedText: null, accessibility: false })).toBe(
      "Selected text needs the Accessibility permission",
    );
    const withPicture = { ...sample, screenshotPath: "/data/looking-at/1/Window.jpg" };
    expect(lookingAtChipDetail(withPicture)).toContain("a picture of the window");
    expect(lookingAtPaths(withPicture)).toEqual([sample.contextPath, withPicture.screenshotPath]);
    expect(screenshotNotice({ ...sample, screenshotError: "permission" })).toContain(
      "Screen Recording",
    );
    expect(screenshotNotice(sample)).toBeNull();
  });

  it("can be removed before sending", () => {
    const onRemove = vi.fn();
    render(<LookingAtChip value={sample} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove what I’m looking at" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

describe("the composer's menu item", () => {
  it("captures on click and hands the files to the composer", async () => {
    const attach = vi.fn(async () => true);
    const close = vi.fn();
    render(<LookingAtMenuItem attach={attach} close={close} />);
    const item = await screen.findByRole("menuitem", { name: "What I’m looking at" });
    // Nothing is read before the click.
    expect(invokeMock).not.toHaveBeenCalledWith("screen_awareness_capture", expect.anything());
    fireEvent.click(item);
    await waitFor(() => expect(attach).toHaveBeenCalledWith([sample.contextPath]));
    expect(invokeMock).toHaveBeenCalledWith("screen_awareness_capture", { screenshot: false });
    expect(close).toHaveBeenCalledWith(false);
    expect(
      screen.queryByRole("menuitem", { name: "What I’m looking at, with a picture" }),
    ).toBeNull();
  });

  it("says why nothing was attached", async () => {
    capture = () => {
      throw {
        code: "screen_awareness_off",
        message:
          "Turn on screen awareness in Settings, Privacy, to attach what you are looking at.",
      };
    };
    const attach = vi.fn(async () => true);
    render(<LookingAtMenuItem attach={attach} close={vi.fn()} />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "What I’m looking at" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Turn on screen awareness");
    expect(attach).not.toHaveBeenCalled();
  });

  it("offers the picture only once it is allowed", async () => {
    awareness = { enabled: true, screenshots: true };
    render(<LookingAtMenuItem attach={vi.fn(async () => true)} close={vi.fn()} />);
    expect(
      await screen.findByRole("menuitem", { name: "What I’m looking at, with a picture" }),
    ).toBeInTheDocument();
  });
});
