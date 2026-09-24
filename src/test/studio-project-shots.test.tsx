import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ProjectShots } from "../components/studio/ProjectShots";
import { newProject, newShot } from "../lib/studio/projects";
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
