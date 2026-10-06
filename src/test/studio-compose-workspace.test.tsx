/**
 * The composer's surface: the packs, the price before anything is paid, and
 * the sheet offered only where nine images can share one.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeWorkspace } from "../components/studio/compose/ComposeWorkspace";
import type { MediaCatalog, StudioArtifact } from "../lib/studio/types";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (p: string) => p }));
vi.mock("../lib/studio/retouch/canvas-io", () => ({
  prepareSource: async () => "data:image/png;base64,AA",
}));
vi.mock("../lib/artifact-media", () => ({
  useArtifactPreview: () => "data:image/png;base64,AA",
  artifactDataUrl: async () => "data:image/png;base64,AA",
}));

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

beforeEach(() => {
  tauri.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "studio_collection_save") return { id: "folder", name: "Angles" };
    return [];
  });
});

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

  it("counts a result that lands before the sending has finished", async () => {
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "studio_collection_save") return { id: "folder", name: "Angles" };
      if (command === "media_job_queue") {
        const request = (args as { request: { jobId: string; clientContext: { group: string } } })
          .request;
        // The first job finishes while the others are still being sent.
        window.dispatchEvent(
          new CustomEvent("subrosa:compose-result", {
            detail: { group: request.clientContext.group, jobId: request.jobId, artifactIds: [] },
          }),
        );
        return { id: request.jobId };
      }
      return [];
    });
    render(
      <ComposeWorkspace
        catalog={catalog}
        source={source}
        layout="desktop"
        onChangeSource={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Compose" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Compose" })).toBeEnabled());
    expect(screen.queryByLabelText("Rendering")).toBeNull();
  });

  it("picks up a composition still rendering for this image", async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "media_job_list")
        return [
          {
            id: "job-1",
            kind: "image",
            status: "processing",
            source: "compose:g9",
            clientContext: {
              v: 1,
              group: "g9",
              sourceId: "source.png",
              pack: "character",
              mode: "sheet",
              labels: [],
              index: 0,
              of: 1,
            },
          },
        ];
      return [];
    });
    render(
      <ComposeWorkspace
        catalog={catalog}
        source={source}
        layout="desktop"
        onChangeSource={vi.fn()}
      />,
    );
    expect(await screen.findAllByLabelText("Rendering")).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Compose" })).toBeDisabled();
  });
});
