import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the media client wholesale: no network, no Tauri invoke. The
// async-job poller imports the same module, so retrieve polling is mocked too.
vi.mock("../lib/studio/client", () => {
  class MediaError extends Error {
    status: number;
    code?: string;
    retryAfterMs?: number;

    constructor(message: string, options: { status: number; code?: string }) {
      super(message);
      this.name = "MediaError";
      this.status = options.status;
      this.code = options.code;
    }
  }
  return {
    MediaError,
    mediaJson: vi.fn(),
    mediaBinary: vi.fn(),
    mediaGet: vi.fn(),
    mediaRaw: vi.fn(),
  };
});

// The music node resolves the backend (Carpe Diem vs Venice paths) from the
// cached catalog; pin it so the test never reaches a Tauri invoke.
vi.mock("../lib/studio/catalog", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/studio/catalog")>();
  return {
    ...original,
    fetchMediaCatalog: vi.fn(async () => ({ backend: "carpe-diem", models: [] })),
  };
});

import { mediaBinary, mediaJson, mediaRaw } from "../lib/studio/client";
import {
  resolvePrompt,
  runWorkflow,
  topoLevels,
  WorkflowRunError,
} from "../lib/studio/workflow/engine";
import {
  defaultParams,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../lib/studio/workflow/schema";

const mediaJsonMock = vi.mocked(mediaJson);
const mediaBinaryMock = vi.mocked(mediaBinary);
const mediaRawMock = vi.mocked(mediaRaw);

function node(
  id: string,
  type: WorkflowNodeType,
  params: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  };
}

function edge(source: string, target: string): WorkflowEdge {
  return { id: `${source}-${target}`, source, target };
}

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf", name: "Test", nodes, edges, createdAt: 0, updatedAt: 0 };
}

function callsTo(path: string): unknown[][] {
  return mediaJsonMock.mock.calls.filter((call) => call[0] === path);
}

beforeEach(() => {
  mediaJsonMock.mockReset();
  mediaBinaryMock.mockReset();
  mediaRawMock.mockReset();
});

describe("topoLevels", () => {
  it("groups a diamond into three levels with the parallel middle together", () => {
    const nodes = [
      node("A", "textInput", { text: "t" }),
      node("B", "chat", { model: "m", prompt: "p" }),
      node("C", "chat", { model: "m", prompt: "p" }),
      node("D", "output"),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const levels = topoLevels(nodes, edges);
    expect(levels).toHaveLength(3);
    expect(levels[0]).toEqual(["A"]);
    expect([...levels[1]].sort()).toEqual(["B", "C"]);
    expect(levels[2]).toEqual(["D"]);
  });

  it("throws on a cycle", () => {
    const nodes = [
      node("a", "chat", { model: "m", prompt: "p" }),
      node("b", "chat", { model: "m", prompt: "p" }),
    ];
    expect(() => topoLevels(nodes, [edge("a", "b"), edge("b", "a")])).toThrow(/cycle/);
  });
});

describe("resolvePrompt", () => {
  it("substitutes {{input}} globally", () => {
    expect(resolvePrompt("Draw {{input}}, then {{input}} again", "a fox")).toBe(
      "Draw a fox, then a fox again",
    );
  });

  it("appends the input after a prompt without the marker", () => {
    expect(resolvePrompt("Summarize this", "some text")).toBe("Summarize this\n\nsome text");
    expect(resolvePrompt("Summarize this", "")).toBe("Summarize this");
  });

  it("passes the input through when the prompt is empty", () => {
    expect(resolvePrompt("", "just the input")).toBe("just the input");
  });
});

describe("runWorkflow", () => {
  it("chains text input through chat into image and surfaces the image at the output", async () => {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/chat/completions") {
        return {
          choices: [
            { message: { content: "<think>palette...</think>A painterly red fox portrait" } },
          ],
        };
      }
      if (path === "/image/generate") {
        return { images: ["QkFTRTY0"] };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const updates: string[] = [];
    const results = await runWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "a red fox" }),
          node("llm", "chat", { model: "qwen3-next-80b", prompt: "Describe: {{input}}" }),
          node("img", "image", { model: "seedream-v4" }),
          node("out", "output"),
        ],
        [edge("in", "llm"), edge("llm", "img"), edge("img", "out")],
      ),
      { onUpdate: (result) => updates.push(`${result.nodeId}:${result.status}`) },
    );

    const chatBody = callsTo("/chat/completions")[0]?.[1] as Record<string, unknown>;
    expect(chatBody.messages).toEqual([{ role: "user", content: "Describe: a red fox" }]);

    // The chat output (think block stripped) feeds the image prompt.
    const imageBody = callsTo("/image/generate")[0]?.[1] as Record<string, unknown>;
    expect(imageBody.prompt).toBe("A painterly red fox portrait");
    expect(imageBody.hide_watermark).toBe(true);

    expect(results.get("llm")?.output).toEqual({
      kind: "text",
      text: "A painterly red fox portrait",
    });
    expect(results.get("out")?.output).toEqual({
      kind: "image",
      base64: "QkFTRTY0",
      mimeType: "image/png",
    });
    for (const id of ["in", "llm", "img", "out"]) {
      expect(results.get(id)?.status).toBe("done");
    }
    expect(updates).toContain("llm:running");
    expect(updates).toContain("out:done");
  });

  it("rejects on a node failure but keeps finished results in the map", async () => {
    mediaJsonMock.mockRejectedValue(new Error("boom"));

    const run = runWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "hello" }),
          node("llm", "chat", { model: "m" }),
          node("out", "output"),
        ],
        [edge("in", "llm"), edge("llm", "out")],
      ),
    );

    const caught: unknown = await run.then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(caught).toBeInstanceOf(WorkflowRunError);
    if (!(caught instanceof WorkflowRunError)) throw new Error("expected WorkflowRunError");
    const error = caught;
    expect(error.message).toBe("boom");
    expect(error.nodeId).toBe("llm");
    expect(error.results.get("in")?.status).toBe("done");
    expect(error.results.get("in")?.output).toEqual({ kind: "text", text: "hello" });
    expect(error.results.get("llm")?.status).toBe("error");
    expect(error.results.get("llm")?.error).toBe("boom");
    expect(error.results.get("out")?.status).toBe("pending");
  });

  it("throws before running when validation fails", async () => {
    const run = runWorkflow(workflow([node("llm", "chat", { prompt: "p" })], []));
    await expect(run).rejects.toBeInstanceOf(WorkflowRunError);
    expect(mediaJsonMock).not.toHaveBeenCalled();
  });

  it("queues a video and retrieves it with the id and the model", async () => {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/video/queue") return { id: "vid-1" };
      throw new Error(`Unexpected path: ${path}`);
    });
    mediaRawMock.mockImplementation(async (path: string) => {
      if (path === "/video/retrieve") {
        return {
          status: 200,
          ok: true,
          json: { status: "completed", video_url: "https://cdn.example/clip.mp4" },
        };
      }
      throw new Error(`Unexpected retrieve path: ${path}`);
    });

    const results = await runWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "neon city flyover" }),
          node("clip", "video", {
            model: "kling-2.5-turbo-pro-text-to-video",
            duration: "5s",
            aspectRatio: "16:9",
          }),
          node("out", "output"),
        ],
        [edge("in", "clip"), edge("clip", "out")],
      ),
    );

    const queueBody = callsTo("/video/queue")[0]?.[1] as Record<string, unknown>;
    expect(queueBody.prompt).toBe("neon city flyover");
    expect(queueBody.duration).toBe("5s");

    // Retrieve sends the superset shape: Venice reads `id`, Carpe Diem reads
    // `queue_id` + `model` (both required there).
    const retrieveBody = mediaRawMock.mock.calls.find((call) => call[0] === "/video/retrieve")?.[1];
    expect(retrieveBody).toEqual({
      id: "vid-1",
      queue_id: "vid-1",
      model: "kling-2.5-turbo-pro-text-to-video",
    });

    expect(results.get("out")?.output).toEqual({
      kind: "video",
      url: "https://cdn.example/clip.mp4",
    });
  });

  it("treats a binary music retrieve response as the finished track", async () => {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/audio/music/queue") return { queue_id: "song-1" };
      throw new Error(`Unexpected path: ${path}`);
    });
    // Carpe Diem answers the poll with the MP3 itself once the job is done
    // (one shot — the job is dropped server-side right after), not with a
    // completed-status JSON carrying an audio_url.
    mediaRawMock.mockImplementation(async () => ({
      status: 200,
      ok: true,
      bodyBase64: "TVAzREFUQQ==",
      contentType: "audio/mpeg",
    }));

    const results = await runWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "an upbeat jazz rock instrumental" }),
          node("track", "music", { model: "elevenlabs-music" }),
          node("out", "output"),
        ],
        [edge("in", "track"), edge("track", "out")],
      ),
    );

    expect(results.get("out")?.output).toEqual({
      kind: "audio",
      base64: "TVAzREFUQQ==",
      mimeType: "audio/mpeg",
      source: "music",
    });
  });

  it("rejects with an AbortError when the signal fires mid run", async () => {
    mediaJsonMock.mockImplementation(
      (_path: string, _body?: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const controller = new AbortController();
    const run = runWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "hello" }),
          node("llm", "chat", { model: "m" }),
          node("out", "output"),
        ],
        [edge("in", "llm"), edge("llm", "out")],
      ),
      { signal: controller.signal },
    );

    // Let the run reach the pending chat call, then cancel.
    await Promise.resolve();
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});
