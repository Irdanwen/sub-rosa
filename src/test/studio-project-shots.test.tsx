import { fireEvent, render, screen } from "@testing-library/react";
import { SHOT_REWRITE_VERSION } from "../lib/studio/studio-rewrite";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ProjectShots } from "../components/studio/ProjectShots";
import { newProject, newShot, shotSignature } from "../lib/studio/projects";
import type { MediaCatalog } from "../lib/studio/types";

const catalog: MediaCatalog = { backend: "carpe-diem", models: [] };

describe("project shot removal", () => {
  it("does not reinsert a removed shot that a saved revision already restored", () => {
    const original = newProject().document;
    original.shots = [{ ...newShot(0), id: "shot-1", action: "A pianist bows" }];
    function Harness() {
      const [document, setDocument] = useState(original);
      return (
        <>
          <button type="button" onClick={() => setDocument(original)}>
            Restore saved shots
          </button>
          <output data-testid="shot-count">{document.shots.length}</output>
          <ProjectShots
            document={document}
            onChange={(shots) => setDocument((previous) => ({ ...previous, shots }))}
            artifacts={[]}
            catalog={catalog}
            onGenerate={() => undefined}
            onImage={() => undefined}
            onBible={() => undefined}
            busy={false}
          />
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByTestId("shot-count")).toHaveTextContent("0");
    fireEvent.click(screen.getByRole("button", { name: "Restore saved shots" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo removal" }));
    expect(screen.getByTestId("shot-count")).toHaveTextContent("1");
    expect(screen.queryByRole("button", { name: "Undo removal" })).not.toBeInTheDocument();
  });
});

describe("a shot's AI-written prompt", () => {
  const video = (id: string, name: string) => ({
    id,
    name,
    mediaType: "video" as const,
    offline: false,
  });
  const withModels: MediaCatalog = {
    backend: "carpe-diem",
    models: [video("kling-2-6", "Kling 2.6"), video("wan-2-5", "Wan 2.5")],
  };
  function renderShot(modelId: string, promptVersion: string | null = SHOT_REWRITE_VERSION) {
    const document = newProject().document;
    document.shots = [
      {
        ...newShot(0),
        id: "shot-1",
        action: "Marie runs",
        prompt: "Marie runs through the rain.",
        modelId,
        promptOptimizedFor: "kling-2-6",
        promptVersion: promptVersion ?? undefined,
      },
    ];
    render(
      <ProjectShots
        document={document}
        onChange={() => undefined}
        artifacts={[]}
        catalog={withModels}
        onGenerate={() => undefined}
        onImage={() => undefined}
        onBible={() => undefined}
        busy={false}
      />,
    );
  }

  it("says which model it was written for", () => {
    renderShot("kling-2-6");
    expect(screen.getByText("Optimized for Kling 2.6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Improve with AI/ })).toBeInTheDocument();
  });

  it("says when AI wrote it with the previous method, and offers the composed prompt", () => {
    renderShot("kling-2-6", null);
    expect(screen.getByText(/One prompt was written with the previous method/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Use the composed prompt" }).length,
    ).toBeGreaterThan(0);
  });

  it("shows the prompt the take renders from, block by block", () => {
    renderShot("kling-2-6");
    expect(screen.getByText(/Composed prompt, replaced by yours/)).toBeInTheDocument();
    expect(screen.getByText(/No dialogue\./)).toBeInTheDocument();
  });

  it("warns when the shot now renders with another model", () => {
    renderShot("wan-2-5");
    expect(
      screen.getByText("This prompt was written for Kling 2.6. Improve it again for Wan 2.5."),
    ).toBeInTheDocument();
  });
});

describe("the shot signature", () => {
  it("does not treat the AI label as an input", () => {
    const document = newProject().document;
    const shot = { ...newShot(0), prompt: "A" };
    expect(shotSignature({ ...shot, promptOptimizedFor: "kling-2-6" }, document)).toBe(
      shotSignature(shot, document),
    );
  });
});
