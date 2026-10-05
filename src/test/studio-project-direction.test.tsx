import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectDirection, directionFromRecipe } from "../components/studio/ProjectDirection";
import { newProject } from "../lib/studio/projects";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

const model = (id: string, name: string, mediaType: MediaModel["mediaType"]): MediaModel =>
  ({ id, name, mediaType, offline: false, costCredits: 10 }) as MediaModel;

function renderWith(models: MediaModel[]) {
  const document = { ...newProject().document, filmDirection: directionFromRecipe("noir") };
  render(
    <ProjectDirection
      document={document}
      catalog={{ backend: "carpe-diem", models } as MediaCatalog}
      editDocument={() => undefined}
    />,
  );
}

describe("the film direction panel", () => {
  it("shows the opening and style the routed family actually receives", () => {
    renderWith([model("veo3.1-full-text-to-video", "Veo 3.1", "video")]);
    // A long family gets the light and the texture as well.
    expect(screen.getByText(/black and white, hard direct light/)).toBeInTheDocument();
    expect(screen.getByText(/heavy grain/)).toBeInTheDocument();
  });

  it("says which models get which wording when the families differ", () => {
    renderWith([
      model("veo3.1-full-text-to-video", "Veo 3.1", "video"),
      model("seedance-2-0-reference-to-video-basic", "Seedance 2.0", "referenceToVideo"),
    ]);
    expect(screen.getByText("Written into every shot on Veo 3.1")).toBeInTheDocument();
    expect(screen.getByText("Written into every shot on Seedance 2.0")).toBeInTheDocument();
  });

  it("fills every field from a recipe", () => {
    expect(directionFromRecipe("intimate-drama")).toMatchObject({
      genre: "intimate-drama",
      moods: ["melancholic", "intimate"],
      look: "film-35",
      music: "none",
      shotDefaults: { framing: { size: "close-up", lens: "85mm" }, move: { kind: "push-in" } },
    });
  });
});
