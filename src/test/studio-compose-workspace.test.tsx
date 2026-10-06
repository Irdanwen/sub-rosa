/**
 * The composer's surface: the packs, the price before anything is paid, and
 * the sheet offered only where nine images can share one.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposeWorkspace } from "../components/studio/compose/ComposeWorkspace";
import type { MediaCatalog, StudioArtifact } from "../lib/studio/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  convertFileSrc: (p: string) => p,
}));
vi.mock("../lib/artifact-media", () => ({ useArtifactPreview: () => "data:image/png;base64,AA" }));

const catalog: MediaCatalog = {
  backend: "venice",
  models: [
    {
      id: "ideogram-v4-5-edit",
      mediaType: "imageEdit",
      name: "Ideogram edit",
      offline: false,
      costCredits: 10.8,
      constraints: { aspectRatios: ["1:1", "16:9", "9:16"] },
    },
  ],
};
const source: StudioArtifact = {
  id: "source.png",
  kind: "image",
  path: "/gallery/source.png",
  fileName: "source.png",
  bytes: 1,
  model: "",
  prompt: "A blue car",
  createdAt: 0,
};

describe("the composer", () => {
  it("prices a pack before sending it, and offers a sheet for nine shots", async () => {
    render(
      <ComposeWorkspace
        catalog={catalog}
        source={source}
        layout="desktop"
        onChangeSource={vi.fn()}
      />,
    );
    expect(screen.getByText(/4 paid images · about 43.2 credits/)).toBeInTheDocument();
    expect(screen.queryByText("On one sheet")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Character sheet/ }));
    expect(screen.getByText(/9 paid images · about 97.2 credits/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /On one sheet/ }));
    expect(
      screen.getByText(/9 images from one paid sheet · about 10.8 credits/),
    ).toBeInTheDocument();
  });

  it("waits for a written list before the free pack can be sent", async () => {
    render(
      <ComposeWorkspace
        catalog={catalog}
        source={source}
        layout="phone"
        onChangeSource={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Your own list/ }));
    expect(screen.getByRole("button", { name: "Compose" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "On a beach");
    expect(screen.getByRole("button", { name: "Compose" })).toBeEnabled();
  });
});
