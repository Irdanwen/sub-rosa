import { beforeEach, describe, expect, it, vi } from "vitest";

// No network, no Tauri: the enhancer only talks through the media client.
vi.mock("../lib/studio/client", () => ({
  mediaJson: vi.fn(),
}));

import { mediaJson } from "../lib/studio/client";
import { enhanceImagePrompt, pickEnhanceModel } from "../lib/studio/enhance-prompt";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

const mediaJsonMock = vi.mocked(mediaJson);

function model(id: string, mediaType: MediaModel["mediaType"], offline = false): MediaModel {
  return { id, name: id, mediaType, offline };
}

function catalog(models: MediaModel[]): MediaCatalog {
  return { backend: "carpe-diem", models };
}

beforeEach(() => {
  mediaJsonMock.mockReset();
});

describe("pickEnhanceModel", () => {
  it("prefers a small fast text model, then falls back to any text model", () => {
    const withSmall = catalog([
      model("claude-opus-4-8", "text"),
      model("llama-3.2-3b", "text"),
      model("venice-sd35", "image"),
    ]);
    expect(pickEnhanceModel(withSmall)).toBe("llama-3.2-3b");

    const withoutPreferred = catalog([model("some-new-llm", "text")]);
    expect(pickEnhanceModel(withoutPreferred)).toBe("some-new-llm");

    expect(pickEnhanceModel(catalog([model("venice-sd35", "image")]))).toBeUndefined();
  });

  it("never picks an offline model", () => {
    expect(pickEnhanceModel(catalog([model("llama-3.2-3b", "text", true)]))).toBeUndefined();
  });
});

describe("enhanceImagePrompt", () => {
  const cat = catalog([model("llama-3.2-3b", "text")]);

  it("returns the rewritten prompt from chat completions", async () => {
    mediaJsonMock.mockResolvedValueOnce({
      choices: [{ message: { content: "A red fox at dusk, cinematic rim light" } }],
    });
    const result = await enhanceImagePrompt("a fox", cat);
    expect(result).toBe("A red fox at dusk, cinematic rim light");
    const [path, body] = mediaJsonMock.mock.calls[0];
    expect(path).toBe("/chat/completions");
    expect((body as Record<string, unknown>).model).toBe("llama-3.2-3b");
  });

  it("falls back to the original prompt on failure or empty output", async () => {
    mediaJsonMock.mockRejectedValueOnce(new Error("offline"));
    expect(await enhanceImagePrompt("a fox", cat)).toBe("a fox");

    mediaJsonMock.mockResolvedValueOnce({ choices: [{ message: { content: "   " } }] });
    expect(await enhanceImagePrompt("a fox", cat)).toBe("a fox");
  });

  it("skips the call entirely when no text model exists", async () => {
    expect(await enhanceImagePrompt("a fox", catalog([]))).toBe("a fox");
    expect(mediaJsonMock).not.toHaveBeenCalled();
  });
});
