import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MediaViewer, type MediaViewerItem } from "../components/studio/MediaViewer";
import { artifactLabel, newProject, newShot } from "../lib/studio/projects";
import type { StudioArtifact } from "../lib/studio/types";

vi.mock("../lib/studio/artifacts", () => ({
  artifactSrc: (artifact: StudioArtifact) => `asset://${artifact.fileName}`,
}));

function artifact(id: string, kind: StudioArtifact["kind"] = "image"): StudioArtifact {
  return {
    id,
    kind,
    fileName: `${id}.png`,
    path: `/gallery/${id}`,
    bytes: 10,
    model: "flux",
    prompt: `prompt ${id}`,
    createdAt: 1,
  };
}

function Viewer({
  items,
  onClose = () => undefined,
}: {
  items: MediaViewerItem[];
  onClose?: () => void;
}) {
  const [index, setIndex] = useState(0);
  return <MediaViewer items={items} index={index} onIndex={setIndex} onClose={onClose} />;
}

describe("MediaViewer", () => {
  const items = [
    { artifact: artifact("a"), title: "First" },
    { artifact: artifact("b", "video"), title: "Second" },
    { artifact: artifact("c"), title: "Third" },
  ];

  it("steps through the files with the arrow keys and wraps around", () => {
    render(<Viewer items={items} />);
    const dialog = screen.getByRole("dialog", { name: "First" });
    expect(screen.getByText("1 of 3")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Second" })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByRole("dialog", { name: "Third" })).toBeTruthy();
  });

  it("leaves the arrow keys to a focused player", () => {
    render(<Viewer items={items} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const video = document.querySelector("video");
    expect(video).toBeTruthy();
    fireEvent.keyDown(video as HTMLVideoElement, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Second" })).toBeTruthy();
  });

  it("closes on Escape and gives focus back to what opened it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(<Viewer items={items} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("toggles an image between fitted and actual size, and each file opens fitted", () => {
    render(<Viewer items={items} />);
    fireEvent.click(screen.getByRole("button", { name: "Show at actual size" }));
    expect(
      screen.getByRole("button", { name: "Fit to the window" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Show at actual size" })).toBeTruthy();
  });

  it("hides the stepping controls for a single file", () => {
    render(<Viewer items={[items[0]]} />);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByText("1 of 1")).toBeNull();
  });
});

describe("artifactLabel", () => {
  it("names takes, opening images and bible references by what they are to the project", () => {
    const document = newProject().document;
    const shot = { ...newShot(0), title: "The corridor", takeIds: ["take-1", "take-2"] };
    shot.openingArtifactId = "opening";
    document.shots = [newShot(0), shot];
    document.bible = [
      {
        id: "henri",
        name: "HENRI",
        kind: "character",
        traits: "",
        note: "",
        refs: [
          { id: "r", entryId: "henri", artifactId: "sheet", role: "sheet", label: "", ordinal: 0 },
        ],
        createdAt: "",
        updatedAt: "",
      },
    ];
    expect(artifactLabel(document, "take-2")).toBe("Shot 2: The corridor, take 2");
    expect(artifactLabel(document, "opening")).toBe("Shot 2: The corridor, opening image");
    expect(artifactLabel(document, "sheet")).toBe("HENRI: Character sheet 3×3");
    expect(artifactLabel(document, "elsewhere")).toBeUndefined();
  });
});
