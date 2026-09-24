import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/studio/editor/compositor", () => ({
  EditorCompositor: class {
    prepare = vi.fn(async () => {});
    seek = vi.fn(async () => {});
    dispose = vi.fn();
  },
  recordEditor: vi.fn(),
}));

import { ProjectTimeline } from "../components/studio/ProjectTimeline";
import { createEditorClip, createEditorDocument } from "../lib/studio/editor/document";

function TimelineHarness() {
  const [value, setValue] = useState(createEditorDocument);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setValue((previous) => ({
            ...previous,
            clips: [
              ...previous.clips,
              createEditorClip({
                id: "external-take",
                trackId: "picture",
                name: "External take",
                duration: 30,
                artifactId: "take.mp4",
              }),
            ],
          }))
        }
      >
        Append outside editor
      </button>
      <output data-testid="clip-ids">{value.clips.map((clip) => clip.id).join(",")}</output>
      <ProjectTimeline
        value={value}
        onChange={setValue}
        onAddMedia={async () =>
          createEditorClip({ trackId: "picture", name: "Unused", duration: 30 })
        }
        artifacts={[]}
        onExportArtifact={async () => {}}
        exportDisabled={false}
        onExportStart={() => true}
        onExportEnd={() => {}}
      />
    </>
  );
}

describe("montage history", () => {
  it("clears undo history when a take is appended outside the editor", () => {
    render(<TimelineHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Add title" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Append outside editor" }));

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByTestId("clip-ids")).toHaveTextContent("external-take");
  });
});
