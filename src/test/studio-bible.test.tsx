import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BibleStudio } from "../components/studio/BibleStudio";
import { GalleryPicker } from "../components/studio/GalleryPicker";
import type { BibleEntry } from "../lib/studio/bible";
import type { MediaCatalog, StudioArtifact } from "../lib/studio/types";

const hoisted = vi.hoisted(() => ({
  invoke: vi.fn(),
  listArtifacts: vi.fn(),
  artifactDataUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invoke }));
vi.mock("../lib/artifact-media", () => ({ artifactDataUrl: hoisted.artifactDataUrl }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: hoisted.listArtifacts,
  saveArtifactFromBase64: vi.fn(),
}));

function artifact(id: string, kind: StudioArtifact["kind"] = "image"): StudioArtifact {
  return {
    id,
    kind,
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1,
    model: "m",
    prompt: `prompt ${id}`,
    createdAt: 1,
  };
}

function entry(over: Partial<BibleEntry> = {}): BibleEntry {
  return {
    id: "e1",
    kind: "character",
    name: "Nera",
    traits: "green coat",
    note: "",
    refs: [
      {
        id: "r1",
        entryId: "e1",
        artifactId: "nera.png",
        role: "portrait",
        label: "",
        ordinal: 0,
      },
      {
        id: "r2",
        entryId: "e1",
        artifactId: "nera-side.png",
        role: "profile",
        label: "",
        ordinal: 1,
      },
    ],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const catalog = { models: [] } as unknown as MediaCatalog;

beforeEach(() => {
  hoisted.invoke.mockReset();
  hoisted.listArtifacts
    .mockReset()
    .mockResolvedValue([artifact("nera.png"), artifact("other.png")]);
  hoisted.artifactDataUrl.mockReset().mockResolvedValue("data:image/png;base64,AA");
});

describe("the bible panel", () => {
  it("shows an entry, its traits, and the order its references will be sent in", async () => {
    hoisted.invoke.mockImplementation(async (command: string) =>
      command === "list_bible_entries" ? [entry()] : undefined,
    );
    render(<BibleStudio catalog={catalog} />);

    expect(await screen.findByText("Nera")).toBeInTheDocument();
    expect(screen.getByText("green coat")).toBeInTheDocument();
    // The order is the contract: the first image is the identity anchor.
    const roles = screen.getAllByText(/Portrait|Profile/).map((node) => node.textContent);
    expect(roles).toEqual(["Portrait", "Profile"]);
  });

  it("reports a reference whose file the gallery no longer has, rather than repairing it", async () => {
    // The gallery is reconciled against the disk and its index is capped, so a
    // pointer can legitimately aim at nothing. Deleting it on the user's behalf
    // would throw away the only record that the angle ever existed.
    hoisted.invoke.mockImplementation(async (command: string) =>
      command === "list_bible_entries" ? [entry()] : undefined,
    );
    hoisted.listArtifacts.mockResolvedValue([artifact("nera.png")]);
    render(<BibleStudio catalog={catalog} />);
    expect(
      await screen.findByText(/1 reference point at files that are no longer in your gallery/),
    ).toBeInTheDocument();
  });

  it("says what a bible is for, and where a film actually gets made", async () => {
    // Somebody who has just named a cast has no reason to know that the next
    // step is a note, or that the button using it lives three tabs away.
    const onMakeAFilm = vi.fn();
    hoisted.invoke.mockImplementation(async (command: string) =>
      command === "list_bible_entries" ? [entry()] : undefined,
    );
    render(<BibleStudio catalog={catalog} onMakeAFilm={onMakeAFilm} />);

    expect(await screen.findByText(/Now write the film as a note/)).toBeInTheDocument();
    // And the reason the names matter, said before it costs anything.
    expect(screen.getByText(/exactly what you called them here/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make a film from a note" }));
    expect(onMakeAFilm).toHaveBeenCalledTimes(1);
  });

  it("refuses to save something with no name", async () => {
    hoisted.invoke.mockResolvedValue([]);
    render(<BibleStudio catalog={catalog} />);
    const button = await screen.findByRole("button", { name: "Add to the bible" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nera" } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(hoisted.invoke).toHaveBeenCalledWith(
        "save_bible_entry",
        expect.objectContaining({ request: expect.objectContaining({ name: "Nera" }) }),
      ),
    );
  });
});

describe("auditioning a voice", () => {
  it("is offered for a character once the account has a voice to try", async () => {
    // A voice is chosen on how it handles a beat, so every take says the same
    // line. The takes are ordinary gallery artifacts, not a special case: the
    // one kept becomes the character's donor, the others can be deleted.
    hoisted.invoke.mockImplementation(async (command: string) =>
      command === "list_bible_entries" ? [entry({ refs: [] })] : "new-ref",
    );
    render(
      <BibleStudio
        catalog={
          {
            backend: "carpe-diem",
            models: [
              {
                id: "tts-1",
                name: "TTS",
                mediaType: "tts",
                offline: false,
                voices: ["ash", "sage"],
              },
            ],
          } as unknown as MediaCatalog
        }
      />,
    );
    expect(await screen.findByRole("button", { name: "Audition voices" })).toBeEnabled();
  });

  it("offers no audition for a location, which has no voice", async () => {
    hoisted.invoke.mockImplementation(async (command: string) =>
      command === "list_bible_entries"
        ? [entry({ kind: "location", name: "The alley", refs: [] })]
        : undefined,
    );
    render(<BibleStudio catalog={catalog} />);
    expect(await screen.findByText("The alley")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audition voices" })).not.toBeInTheDocument();
  });
});

describe("the gallery picker", () => {
  it("offers the bible above the raw gallery, so a slot is filled from a name", async () => {
    hoisted.invoke.mockImplementation(async (command: string) =>
      command === "list_bible_entries" ? [entry()] : undefined,
    );
    const onPick = vi.fn();
    render(<GalleryPicker onPick={onPick} onClose={vi.fn()} />);

    expect(await screen.findByText("Nera")).toBeInTheDocument();
    expect(screen.getByText("Everything else")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nera, portrait" }));
    // The entry travels with the picture: that third argument is what lets a
    // slot carry a character's invariant traits along with their face.
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(
        "data:image/png;base64,AA",
        expect.objectContaining({ id: "nera.png" }),
        expect.objectContaining({ name: "Nera", traits: "green coat" }),
      ),
    );
  });

  it("does not offer a bible reference whose file is gone", async () => {
    // Reporting it belongs on the Bible tab, where it can be fixed. In the
    // middle of somebody's shot it would just be a tile that does not work.
    hoisted.invoke.mockImplementation(async (command: string) =>
      command === "list_bible_entries" ? [entry()] : undefined,
    );
    hoisted.listArtifacts.mockResolvedValue([artifact("other.png")]);
    render(<GalleryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(hoisted.listArtifacts).toHaveBeenCalled());
    expect(screen.queryByText("Everything else")).not.toBeInTheDocument();
  });

  it("can be told to leave the bible out, so attaching to it is not recursive", async () => {
    render(<GalleryPicker onPick={vi.fn()} onClose={vi.fn()} offerBible={false} />);
    await waitFor(() => expect(hoisted.listArtifacts).toHaveBeenCalled());
    expect(hoisted.invoke).not.toHaveBeenCalledWith("list_bible_entries");
  });
});
