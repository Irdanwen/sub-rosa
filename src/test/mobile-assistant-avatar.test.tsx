import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantAvatar,
  AvatarSheet,
  resetAvatarCache,
} from "../components/mobile/screens/assistants/AssistantAvatar";
import { adoptAvatar, monogramHues, monogramOf } from "../lib/assistant-avatar";
import { type AssistantDefinition, emptyAssistant } from "../lib/assistants";

const { invoke, generateImages, saveArtifactFromBase64, listArtifacts } = vi.hoisted(() => ({
  invoke: vi.fn(),
  generateImages: vi.fn(),
  saveArtifactFromBase64: vi.fn(),
  listArtifacts: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (value: string) => value }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../lib/studio/generate-image", () => ({ generateImages }));
vi.mock("../lib/studio/artifacts", () => ({ saveArtifactFromBase64, listArtifacts }));
vi.mock("../lib/artifact-media", () => ({
  useArtifactThumbnail: (artifact: { id: string } | null) =>
    artifact ? { src: `data:image/png;base64,${artifact.id}`, kind: "still" } : null,
}));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: vi.fn(async () => ({ backend: "carpe-diem", models: [model] })),
  defaultImageModel: () => model,
  estimateCostCredits: () => 4,
}));

const model = {
  id: "gpt-image-2-5",
  mediaType: "image",
  name: "GPT Image 2.5",
  offline: false,
  constraints: { aspectRatios: ["1:1", "16:9"] },
};

const assistant: AssistantDefinition = {
  ...emptyAssistant(),
  id: "a1",
  name: "Plume de voyage",
  description: "Writes travel letters",
  revision: 3,
};

function artifact(id: string) {
  return {
    id,
    kind: "image",
    path: `/gallery/${id}.png`,
    fileName: `${id}.png`,
    bytes: 10,
    model: model.id,
    prompt: `Avatar ${id}`,
    createdAt: Number(id.replace(/\D/g, "")) || 1,
  };
}

/** The backend: a reference is created queued, then reads back ready, and a
 * save returns what it was given at the next revision. */
function backend() {
  const saved: AssistantDefinition[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "assistant_reference_from_artifact")
      return { id: `ref-${args.fileName}`, status: "queued" };
    if (command === "assistant_reference_list")
      return [
        { id: "ref-img1.png", status: "ready" },
        { id: "ref-img2.png", status: "ready" },
      ];
    if (command === "assistant_save") {
      const definition = args.definition as AssistantDefinition;
      saved.push(definition);
      return { ...definition, revision: definition.revision + 1 };
    }
    if (command === "assistant_reference_read") return "data:image/png;base64,face";
    return null;
  });
  return saved;
}

beforeEach(() => {
  invoke.mockReset();
  generateImages.mockReset();
  saveArtifactFromBase64.mockReset();
  listArtifacts.mockReset();
  resetAvatarCache();
  let next = 0;
  saveArtifactFromBase64.mockImplementation(async () => artifact(`img${++next}`));
});

describe("assistant monogram", () => {
  it("takes the first letters of the first two words", () => {
    expect(monogramOf("Plume de voyage")).toBe("PD");
    expect(monogramOf("  écrivain  ")).toBe("É");
    expect(monogramOf("")).toBe("");
  });

  it("derives its colours from the id, so every device draws the same face", () => {
    expect(monogramHues(assistant)).toEqual(monogramHues({ ...assistant, name: "Renamed" }));
    expect(monogramHues(assistant)).not.toEqual(monogramHues({ ...assistant, id: "a2" }));
  });

  it("shows the initial until the picture is read, then the picture", async () => {
    backend();
    const { container, rerender } = render(<AssistantAvatar assistant={assistant} />);
    expect(container.textContent).toBe("PD");
    rerender(<AssistantAvatar assistant={{ ...assistant, avatar_ref: "ref-1" }} />);
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  });
});

describe("changing an assistant's avatar", () => {
  it("states the price before anything is spent, then makes the picture the avatar", async () => {
    const saved = backend();
    generateImages.mockResolvedValue(["b64"]);
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(<AvatarSheet assistant={assistant} onChanged={onChanged} onClose={onClose} />);

    const generate = await screen.findByRole("button", { name: "Generate with AI" });
    await waitFor(() => expect(generate).not.toBeDisabled());
    fireEvent.click(generate);
    const one = screen.getByRole("button", { name: /One avatar/ });
    expect(one.textContent).toContain("4");
    expect(screen.getByRole("button", { name: /Two to choose from/ }).textContent).toContain("8");
    expect(generateImages).not.toHaveBeenCalled();

    fireEvent.click(one);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [modelId, body] = generateImages.mock.calls[0];
    expect(modelId).toBe(model.id);
    expect(body).toMatchObject({ variants: 1, aspect_ratio: "1:1" });
    expect(body.prompt).toContain("Plume de voyage");
    expect(invoke).toHaveBeenCalledWith("assistant_reference_from_artifact", {
      assistantId: "a1",
      fileName: "img1.png",
    });
    expect(saved).toEqual([expect.objectContaining({ id: "a1", avatar_ref: "ref-img1.png" })]);
    expect(onChanged.mock.calls[0][0]).toMatchObject({ avatar_ref: "ref-img1.png", revision: 4 });
    expect(onClose).toHaveBeenCalled();
  });

  it("two proposals are both kept, and the one picked becomes the avatar", async () => {
    const saved = backend();
    generateImages.mockResolvedValue(["b64-a", "b64-b"]);
    const onChanged = vi.fn();
    render(<AvatarSheet assistant={assistant} onChanged={onChanged} onClose={vi.fn()} />);
    const generate = await screen.findByRole("button", { name: "Generate with AI" });
    await waitFor(() => expect(generate).not.toBeDisabled());
    fireEvent.click(generate);
    fireEvent.click(screen.getByRole("button", { name: /Two to choose from/ }));

    const dialog = await screen.findByRole("dialog", { name: "Choose an avatar" });
    expect(saveArtifactFromBase64).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Avatar img2" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(saved).toEqual([expect.objectContaining({ avatar_ref: "ref-img2.png" })]);
  });

  it("an image from the gallery costs nothing and becomes the avatar", async () => {
    const saved = backend();
    listArtifacts.mockResolvedValue([artifact("img2")]);
    const onChanged = vi.fn();
    render(<AvatarSheet assistant={assistant} onChanged={onChanged} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose from the gallery" }));
    fireEvent.click(await screen.findByRole("button", { name: "Avatar img2" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(generateImages).not.toHaveBeenCalled();
    expect(saved).toEqual([expect.objectContaining({ avatar_ref: "ref-img2.png" })]);
  });

  it("going back to the initial clears the picture without deleting it", async () => {
    const saved = backend();
    const onChanged = vi.fn();
    render(
      <AvatarSheet
        assistant={{ ...assistant, avatar_ref: "ref-old" }}
        onChanged={onChanged}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use the initial instead" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(saved).toEqual([expect.objectContaining({ avatar_ref: null })]);
    expect(invoke).not.toHaveBeenCalledWith("assistant_reference_delete", expect.anything());
  });

  it("a failed generation says so and offers the price again", async () => {
    backend();
    generateImages.mockRejectedValue(new Error("The backend returned no image."));
    render(<AvatarSheet assistant={assistant} onChanged={vi.fn()} onClose={vi.fn()} />);
    const generate = await screen.findByRole("button", { name: "Generate with AI" });
    await waitFor(() => expect(generate).not.toBeDisabled());
    fireEvent.click(generate);
    fireEvent.click(screen.getByRole("button", { name: /One avatar/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: /One avatar/ })).toBeTruthy();
  });

  it("a picture still being prepared is never saved as the avatar", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "assistant_reference_from_artifact") return { id: "ref-x", status: "queued" };
      if (command === "assistant_reference_list") return [{ id: "ref-x", status: "queued" }];
      return null;
    });
    await expect(adoptAvatar(assistant, "x.png", async () => undefined)).rejects.toThrow(
      /still being prepared/,
    );
    expect(invoke).not.toHaveBeenCalledWith("assistant_save", expect.anything());
  });

  it("a picture that could not become the avatar leaves no reference behind", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "assistant_reference_from_artifact") return { id: "ref-x", status: "failed" };
      return null;
    });
    await expect(adoptAvatar(assistant, "x.png", async () => undefined)).rejects.toThrow(
      /could not be prepared/,
    );
    expect(invoke).toHaveBeenCalledWith("assistant_reference_delete", { id: "ref-x" });
  });
});
