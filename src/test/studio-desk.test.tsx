/**
 * The desktop Studio's desk (ADR-0110): the image desk end to end (idle
 * canvas, chips, a render landing on the scene and in the filmstrip, the
 * inspector folding), the shared popover and model list, the header's
 * renders-in-flight and balance, and where a saved tab from the old set
 * opens now.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImageStudio } from "../components/studio/ImageStudio";
import { StudioStatus } from "../components/studio/desk/StudioStatus";
import { studioPlaceFor } from "../components/studio/StudioView";
import { DockSelectChip } from "../components/studio/stage/DockChip";
import { ModelPickerChip } from "../components/studio/stage/ModelPicker";
import { Popover } from "../components/ui/Popover";
import type { MediaCatalog } from "../lib/studio/types";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const studio = vi.hoisted(() => ({
  artifacts: vi.fn(),
  generate: vi.fn(),
  save: vi.fn(),
  credits: vi.fn(),
  raw: vi.fn(),
  remove: vi.fn(),
  exportFile: vi.fn(),
  cutout: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  listArtifacts: studio.artifacts,
  saveArtifactFromBase64: studio.save,
  deleteArtifact: studio.remove,
  exportArtifact: studio.exportFile,
}));
vi.mock("../lib/studio/generate-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/generate-image")>()),
  generateImages: studio.generate,
}));
vi.mock("../lib/studio/edit-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/edit-image")>()),
  removeBackground: studio.cutout,
}));
vi.mock("../lib/carpe-diem-credits", () => ({ useCarpeDiemCredits: studio.credits }));
vi.mock("../lib/credits-purchase", () => ({ usePayPolicy: () => ({ linkAllowed: true }) }));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaGet: vi.fn().mockRejectedValue(new Error("offline")),
  mediaRaw: studio.raw,
}));

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function catalog(): MediaCatalog {
  return {
    backend: "carpe-diem",
    priceMultiplier: 1,
    models: [
      {
        id: "flux",
        name: "Flux",
        mediaType: "image",
        offline: false,
        costCredits: 6,
        constraints: { aspectRatios: ["1:1", "16:9"], resolutions: ["1k", "2k"] },
      },
      {
        id: "chroma",
        name: "Chroma",
        mediaType: "image",
        offline: false,
        constraints: { aspectRatios: ["1:1", "16:9"], resolutions: ["1k", "2k"] },
      },
    ],
  } as MediaCatalog;
}

beforeEach(() => {
  localStorage.clear();
  tauri.invoke.mockReset().mockResolvedValue([]);
  tauri.listen.mockReset().mockResolvedValue(() => undefined);
  studio.artifacts.mockReset().mockResolvedValue([
    {
      id: "a.png",
      kind: "image",
      path: "/g/a.png",
      fileName: "a.png",
      bytes: 10,
      model: "flux",
      prompt: "A lighthouse in the fog",
      createdAt: 1,
    },
  ]);
  studio.generate.mockReset().mockResolvedValue([PNG]);
  studio.save.mockReset().mockResolvedValue({ id: "b.png" });
  studio.credits.mockReset().mockReturnValue(null);
  studio.raw.mockReset().mockResolvedValue({ ok: true, status: 200, bodyBase64: PNG });
  studio.remove.mockReset().mockResolvedValue(undefined);
  studio.exportFile.mockReset().mockResolvedValue(null);
  studio.cutout.mockReset().mockResolvedValue(PNG);
});

describe("the image desk", () => {
  it("opens on the idle canvas, renders onto the scene, and fills the filmstrip", async () => {
    const onWorking = vi.fn();
    render(
      <ImageStudio catalog={catalog()} tool="create" tools={<p>tools</p>} onWorking={onWorking} />,
    );
    expect(screen.getByText("Describe an image. It will appear here.")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Recent" })).toBeInTheDocument();

    // The chips that matter on every render ride in the dock.
    expect(screen.getByRole("button", { name: "Aspect ratio, 1:1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolution, 1K" })).toBeInTheDocument();

    const send = screen.getByRole("button", { name: "Generate" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "A red door");
    expect(send).toBeEnabled();
    await userEvent.click(send);
    await waitFor(() => expect(studio.generate).toHaveBeenCalledTimes(1));
    expect(studio.generate.mock.calls[0][1]).toMatchObject({ prompt: "A red door" });
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Generated image" })).toHaveAttribute(
        "src",
        `data:image/png;base64,${PNG}`,
      ),
    );
    expect(onWorking).toHaveBeenCalledWith(1);
    expect(onWorking).toHaveBeenLastCalledWith(0);
  });

  it("folds the inspector away and remembers it", async () => {
    render(<ImageStudio catalog={catalog()} tool="create" tools={null} />);
    expect(screen.getByRole("complementary", { name: "Settings" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hide settings" }));
    expect(screen.queryByRole("complementary", { name: "Settings" })).toBeNull();
    expect(localStorage.getItem("subrosa:studio:inspector-open")).toBe("false");
    fireEvent.keyDown(window, { code: "KeyI", altKey: true, metaKey: true });
    expect(screen.getByRole("complementary", { name: "Settings" })).toBeInTheDocument();
  });

  it("says what an upscale needs before it can send", async () => {
    render(<ImageStudio catalog={catalog()} tool="upscale" tools={null} />);
    expect(
      screen.getByText("Pick an image to enlarge (at least 256 by 256 pixels)."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upscale" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upscale factor, x2" })).toBeInTheDocument();
  });
});

describe("the image desk's other tools and its filmstrip", () => {
  it("upscales a picked file and lands the result on the scene", async () => {
    const { container } = render(<ImageStudio catalog={catalog()} tool="upscale" tools={null} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], "a.png", {
      type: "image/png",
    });
    await userEvent.upload(input, file);
    const send = screen.getByRole("button", { name: "Upscale" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Upscale factor, x2" }));
    await userEvent.click(screen.getByRole("option", { name: "x4" }));
    await userEvent.click(send);
    await waitFor(() => expect(studio.raw).toHaveBeenCalledTimes(1));
    expect(studio.raw.mock.calls[0][1]).toMatchObject({ scale: 4, enhance: false });
    await waitFor(() => expect(studio.save).toHaveBeenCalled());
  });

  it("cuts the background out of a picked file", async () => {
    const { container } = render(<ImageStudio catalog={catalog()} tool="cutout" tools={null} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    const send = screen.getByRole("button", { name: "Remove background" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await waitFor(() => expect(studio.cutout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(studio.save).toHaveBeenCalled());
  });

  it("opens a recent picture, puts its prompt back, and deletes it after asking", async () => {
    render(<ImageStudio catalog={catalog()} tool="create" tools={null} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open A lighthouse in the fog" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Reuse the prompt" }));
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("A lighthouse in the fog");

    await userEvent.click(screen.getByRole("button", { name: "Open A lighthouse in the fog" }));
    await userEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    expect(studio.exportFile).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getAllByRole("button", { name: "Delete" }).at(-1) as HTMLElement;
    await userEvent.click(confirm);
    await waitFor(() => expect(studio.remove).toHaveBeenCalledTimes(1));
  });

  it("says when a comparison run partly failed", async () => {
    studio.generate.mockImplementation(async (model: string) => {
      if (model === "chroma") throw new Error("busy");
      return [PNG];
    });
    render(<ImageStudio catalog={catalog()} tool="create" tools={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a model to compare" }));
    const other = screen
      .getAllByRole("option")
      .find((option) => /Flux|Chroma/.test(option.textContent ?? ""));
    if (other) await userEvent.click(other);
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Two takes");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(studio.generate).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Some models failed/);
  });
});

describe("the chips and the popover", () => {
  it("chooses a value from a short menu under the chip, and closes on Escape", async () => {
    const onChange = vi.fn();
    render(
      <DockSelectChip
        label="Aspect ratio"
        value="1:1"
        options={["1:1", "16:9"]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Aspect ratio, 1:1" }));
    const list = screen.getByRole("listbox", { name: "Aspect ratio" });
    await userEvent.click(within(list).getByRole("option", { name: "16:9" }));
    expect(onChange).toHaveBeenCalledWith("16:9");
    expect(screen.queryByRole("listbox")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Aspect ratio, 1:1" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes a popover when a press lands outside it", async () => {
    function Harness() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={anchor} type="button">
            anchor
          </button>
          <p>outside</p>
          <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} label="Menu">
            <button type="button">inside</button>
          </Popover>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "inside" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText("outside"));
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  });

  it("searches models, pins the recommended one, and keeps a star", async () => {
    const onSelect = vi.fn();
    render(
      <ModelPickerChip
        label="Image model"
        selectedId="b"
        pinnedId="c"
        entries={[
          { id: "a", name: "Alpha" },
          { id: "b", name: "Bravo" },
          { id: "c", name: "Charlie", tags: [{ label: "Recommended" }] },
        ]}
        filters={[{ id: "fast", label: "Fast" }]}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Image model, Bravo" }));
    const list = screen.getByRole("dialog", { name: "Image model" });
    const rows = within(list).getAllByRole("button", { name: /Alpha|Bravo|Charlie/ });
    expect(rows[0]).toHaveTextContent("Charlie");
    await userEvent.click(within(list).getAllByRole("button", { name: "Add favorite" })[1]);
    expect(localStorage.getItem("subrosa:mobile:model-favorites")).toContain('"a"');
    await userEvent.click(screen.getByRole("button", { name: "Fast" }));
    expect(screen.getByText("No model matches this search.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search models" }), "alp{Enter}");
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});

describe("the Studio header", () => {
  it("says how many renders are in flight and opens the balance on what the rate means", async () => {
    studio.credits.mockReturnValue({ availableCredits: 317, priceMultiplier: 0.43 });
    render(<StudioStatus running={2} />);
    expect(screen.getByRole("status")).toHaveTextContent("2 renders in progress");
    await userEvent.click(screen.getByRole("button", { name: "Available credits: 317 credits" }));
    expect(screen.getByRole("dialog", { name: "Credits" })).toHaveTextContent(
      "57% below the base price",
    );
    expect(screen.getByRole("button", { name: "Top up" })).toBeInTheDocument();
  });

  it("shows no pill when the balance is not a number", () => {
    studio.credits.mockReturnValue({});
    render(<StudioStatus running={0} />);
    expect(screen.queryByRole("button", { name: /Available credits/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("where a saved tab opens now", () => {
  it("sends every tab of the old set to its new home", () => {
    expect(studioPlaceFor("start")).toEqual({ tab: "image" });
    expect(studioPlaceFor("retouch")).toEqual({ tab: "image", tool: "retouch" });
    expect(studioPlaceFor("compose")).toEqual({ tab: "image", tool: "compose" });
    expect(studioPlaceFor("music")).toEqual({ tab: "audio" });
    expect(studioPlaceFor("film")).toEqual({ tab: "projects", section: "films" });
    expect(studioPlaceFor("bible")).toEqual({ tab: "projects", section: "bible" });
    expect(studioPlaceFor("assemble")).toEqual({ tab: "projects", section: "assemble" });
    expect(studioPlaceFor("workflows")).toEqual({ tab: "projects", section: "workflows" });
    expect(studioPlaceFor(null)).toEqual({ tab: "image" });
    expect(studioPlaceFor("gallery")).toEqual({ tab: "gallery" });
  });
});

describe("a filmstrip of clips", () => {
  it("shows a cell per render in flight and offers to continue a shot", async () => {
    const { Filmstrip } = await import("../components/studio/desk/Filmstrip");
    studio.artifacts.mockResolvedValue([
      {
        id: "c.mp4",
        kind: "video",
        path: "/g/c.mp4",
        fileName: "c.mp4",
        bytes: 10,
        model: "wave",
        prompt: "The sea at dusk",
        createdAt: 2,
      },
    ]);
    const onContinue = vi.fn();
    const onOpenGallery = vi.fn();
    render(
      <Filmstrip
        kinds={["video"]}
        epoch={0}
        pending={2}
        onContinue={onContinue}
        onOpenGallery={onOpenGallery}
      />,
    );
    expect(screen.getAllByRole("img", { name: "Rendering" })).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Open the gallery" }));
    expect(onOpenGallery).toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Open The sea at dusk" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue this shot" }));
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ id: "c.mp4" }));
  });
});

describe("the audio scene", () => {
  it("stays blank until the last track is asked for, then plays it", async () => {
    const { AudioScene } = await import("../components/studio/desk/AudioScene");
    const { container } = render(
      <AudioScene
        newest={{
          id: "t.mp3",
          kind: "music",
          path: "/g/t.mp3",
          fileName: "t.mp3",
          bytes: 1,
          model: "tune",
          prompt: "Calm piano",
          createdAt: 1,
        }}
        hint="Describe a track. It will play here."
      />,
    );
    expect(container.querySelector("audio")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Last creation" }));
    expect(container.querySelector("audio")?.getAttribute("src")).toBe("asset:///g/t.mp3");
  });
});
