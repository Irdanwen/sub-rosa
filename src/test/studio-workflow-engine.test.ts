import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the media client wholesale: no network, no Tauri invoke. The
// async-job poller imports the same module, so retrieve polling is mocked too.
// The spread keeps the real MediaError and isAsyncRetrySignal so the image
// node's queue fallback sees the class the mocks throw.
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
  mediaBinary: vi.fn(),
  mediaGet: vi.fn(),
  mediaRaw: vi.fn(),
}));

// The music node resolves the backend (Carpe Diem vs Venice paths) from the
// cached catalog; pin it so the test never reaches a Tauri invoke.
vi.mock("../lib/studio/catalog", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/studio/catalog")>();
  return {
    ...original,
    fetchMediaCatalog: vi.fn(async () => ({ backend: "carpe-diem", models: [] })),
  };
});

// The assemble node records a canvas in real time; none of that runs under
// jsdom, so the whole module is stubbed and only the wiring is asserted.
vi.mock("../lib/studio/assemble", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/assemble")>()),
  assembleClips: vi.fn(async () => ({ blob: new Blob(["film"]), extension: "mp4" })),
  blobToBase64: vi.fn(async () => "RklMTQ=="),
}));

import { assembleClips } from "../lib/studio/assemble";
import { mediaBinary, mediaJson, mediaRaw } from "../lib/studio/client";
import {
  awaitingGateIds,
  resolvePrompt,
  runWorkflow,
  topoLevels,
  WorkflowRunError,
  type WorkflowStorage,
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
const assembleClipsMock = vi.mocked(assembleClips);

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

function edge(source: string, target: string, targetPort?: string): WorkflowEdge {
  return {
    id: `${source}-${target}${targetPort ? `-${targetPort}` : ""}`,
    source,
    target,
    targetPort,
  };
}

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf", name: "Test", nodes, edges, createdAt: 0, updatedAt: 0 };
}

function callsTo(path: string): unknown[][] {
  return mediaJsonMock.mock.calls.filter((call) => call[0] === path);
}

/** In-memory storage: saves count up, assets/notes are canned. */
function fakeStorage(overrides: Partial<WorkflowStorage> = {}) {
  let saves = 0;
  const save = vi.fn(async () => {
    saves += 1;
    return { artifactId: `art-${saves}`, src: `blob:art-${saves}` };
  });
  const loadAsset = vi.fn(async () => {
    throw new Error("no assets in this test");
  });
  const loadNote = vi.fn(async () => {
    throw new Error("no notes in this test");
  });
  return { save, loadAsset, loadNote, ...overrides } as WorkflowStorage & {
    save: ReturnType<typeof vi.fn>;
    loadAsset: ReturnType<typeof vi.fn>;
    loadNote: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  mediaJsonMock.mockReset();
  mediaBinaryMock.mockReset();
  mediaRawMock.mockReset();
  assembleClipsMock.mockClear();
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

describe("named ports", () => {
  function mockVideoRender() {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/video/queue") return { id: "vid-1" };
      throw new Error(`Unexpected path: ${path}`);
    });
    mediaRawMock.mockImplementation(async () => ({
      status: 200,
      ok: true,
      json: { status: "completed", video_url: "https://example.test/clip.mp4" },
    }));
  }

  it("routes prompt, opening frame, end frame, and references to their request fields", async () => {
    mockVideoRender();
    const storage = fakeStorage({
      loadAsset: vi.fn(async (artifactId: string) => ({
        kind: "image" as const,
        src: `data:image/png;base64,REF-${artifactId}`,
        base64: `REF-${artifactId}`,
        mimeType: "image/png",
        artifactId,
      })),
    });

    await runWorkflow(
      workflow(
        [
          node("prompt", "textInput", { text: "she turns around" }),
          node("hero", "asset", { assetKind: "image", artifactId: "hero-1" }),
          node("clip", "video", { model: "m-i2v" }),
          node("out", "output"),
        ],
        [edge("prompt", "clip", "prompt"), edge("hero", "clip", "references"), edge("clip", "out")],
      ),
      { storage },
    );

    const queueBody = callsTo("/video/queue")[0]?.[1] as Record<string, unknown>;
    expect(queueBody.prompt).toBe("she turns around");
    expect(queueBody.image_url).toBeUndefined();
    expect(queueBody.reference_image_urls).toEqual(["data:image/png;base64,REF-hero-1"]);
  });

  it("keeps a portless image edge behaving as the start frame", async () => {
    mockVideoRender();
    const storage = fakeStorage({
      loadAsset: vi.fn(async () => ({
        kind: "image" as const,
        src: "data:image/jpeg;base64,U1RJTEw=",
        base64: "U1RJTEw=",
        mimeType: "image/jpeg",
        artifactId: "still-1",
      })),
    });

    await runWorkflow(
      workflow(
        [
          node("still", "asset", { assetKind: "image", artifactId: "still-1" }),
          node("clip", "video", { model: "m-i2v", prompt: "walk on" }),
          node("out", "output"),
        ],
        // No targetPort: an edge saved before ports existed.
        [edge("still", "clip"), edge("clip", "out")],
      ),
      { storage },
    );

    const queueBody = callsTo("/video/queue")[0]?.[1] as Record<string, unknown>;
    expect(queueBody.image_url).toBe("data:image/jpeg;base64,U1RJTEw=");
    // The image is not narrated into the prompt.
    expect(queueBody.prompt).toBe("walk on");
  });

  it("reads a note through the document node into a chat prompt", async () => {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/chat/completions") return { choices: [{ message: { content: "ok" } }] };
      throw new Error(`Unexpected path: ${path}`);
    });
    const storage = fakeStorage({
      loadNote: vi.fn(async () => ({ title: "Production bible", text: "Every shot at dusk." })),
    });

    await runWorkflow(
      workflow(
        [
          node("doc", "document", { noteId: "note-9" }),
          node("llm", "chat", { model: "m", prompt: "Summarize: {{input}}" }),
        ],
        [edge("doc", "llm", "prompt")],
      ),
      { storage },
    );

    expect(storage.loadNote).toHaveBeenCalledWith("note-9");
    const chatBody = callsTo("/chat/completions")[0]?.[1] as Record<string, unknown>;
    expect(chatBody.messages).toEqual([
      { role: "user", content: "Summarize: Production bible\n\nEvery shot at dusk." },
    ]);
  });
});

describe("frame-from-video node", () => {
  /** A finished video node feeding a lastFrame node. */
  function videoThenFrame(): Workflow {
    return workflow(
      [
        node("clip", "video", { model: "kling-2.5-turbo-pro-text-to-video", prompt: "a shot" }),
        node("frame", "lastFrame"),
        node("out", "output"),
      ],
      [edge("clip", "frame", "video"), edge("frame", "out")],
    );
  }

  function mockVideoRender() {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/video/queue") return { id: "vid-1" };
      throw new Error(`Unexpected path: ${path}`);
    });
    // The retrieve poll goes through mediaRaw, not mediaJson.
    mediaRawMock.mockImplementation(async () => ({
      status: 200,
      ok: true,
      json: { status: "completed", video_url: "https://example.test/clip.mp4" },
    }));
  }

  it("reads a still out of the saved clip and passes it on with its chain link", async () => {
    mockVideoRender();
    const storage = fakeStorage();
    vi.spyOn(await import("../lib/studio/frames"), "extractHandoffFrame").mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,AAAA",
      timeSeconds: 9.5,
      durationSeconds: 10,
      sharpness: 42,
      width: 1920,
      height: 1080,
    });

    const finished = await runWorkflow(videoThenFrame(), { storage });

    // The clip persisted at the node that produced it, with its provenance.
    expect(storage.save).toHaveBeenCalledWith({ url: "https://example.test/clip.mp4" }, "mp4", {
      kind: "video",
      model: "kling-2.5-turbo-pro-text-to-video",
      prompt: "a shot",
      parentId: undefined,
      parentHandoffSeconds: undefined,
    });
    const frame = finished.get("frame");
    expect(frame?.status).toBe("done");
    // The data URL prefix is stripped: node outputs carry raw base64. The
    // frame remembers which clip it came out of, and where.
    expect(frame?.output).toEqual({
      kind: "image",
      base64: "AAAA",
      mimeType: "image/jpeg",
      chainFrom: { artifactId: "art-1", handoffSeconds: 9.5 },
    });
    vi.restoreAllMocks();
  });

  it("records parent links on a shot rendered from a handoff frame", async () => {
    mockVideoRender();
    const storage = fakeStorage();
    vi.spyOn(await import("../lib/studio/frames"), "extractHandoffFrame").mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,AAAA",
      timeSeconds: 4.5,
      durationSeconds: 5,
      sharpness: 42,
      width: 1920,
      height: 1080,
    });

    const finished = await runWorkflow(
      workflow(
        [
          node("first", "video", { model: "m-t2v", prompt: "shot one" }),
          node("frame", "lastFrame"),
          node("second", "video", { model: "m-i2v", prompt: "shot two" }),
          node("out", "output"),
        ],
        [
          edge("first", "frame", "video"),
          edge("frame", "second", "openingFrame"),
          edge("second", "out"),
        ],
      ),
      { storage },
    );

    // Second save carries the chain: parent is the first clip's artifact.
    expect(storage.save).toHaveBeenCalledWith({ url: "https://example.test/clip.mp4" }, "mp4", {
      kind: "video",
      model: "m-i2v",
      prompt: "shot two",
      parentId: "art-1",
      parentHandoffSeconds: 4.5,
    });
    const second = finished.get("second")?.output;
    expect(second).toMatchObject({
      kind: "video",
      artifactId: "art-2",
      parentId: "art-1",
      parentHandoffSeconds: 4.5,
    });
    vi.restoreAllMocks();
  });

  it("stamps the pre-run figure onto what a node saves", async () => {
    mockVideoRender();
    const storage = fakeStorage();
    await runWorkflow(
      workflow(
        [node("clip", "video", { model: "m-t2v", prompt: "a shot" }), node("out", "output")],
        [edge("clip", "out")],
      ),
      { storage, nodeCosts: { clip: 42.5 } },
    );
    expect(storage.save).toHaveBeenCalledWith(
      { url: "https://example.test/clip.mp4" },
      "mp4",
      expect.objectContaining({ kind: "video", costCredits: 42.5 }),
    );
  });

  it("says so rather than failing silently when the runner cannot fetch clips", async () => {
    mockVideoRender();
    await expect(runWorkflow(videoThenFrame())).rejects.toThrow(WorkflowRunError);
  });

  it("refuses a frame node with nothing to read from", async () => {
    const orphan = workflow(
      [node("frame", "lastFrame"), node("out", "output")],
      [edge("frame", "out")],
    );
    await expect(runWorkflow(orphan, { storage: fakeStorage() })).rejects.toThrow(WorkflowRunError);
  });
});

describe("image edit node", () => {
  function imageAssetStorage() {
    return fakeStorage({
      loadAsset: vi.fn(async (artifactId: string) => ({
        kind: "image" as const,
        src: `data:image/png;base64,SRC-${artifactId}`,
        base64: `SRC-${artifactId}`,
        mimeType: "image/png",
        artifactId,
      })),
    });
  }

  it("edits a single image through /image/edit and saves the result", async () => {
    mediaRawMock.mockImplementation(async (path: string) => {
      if (path === "/image/edit") return { status: 200, ok: true, bodyBase64: "RURJVA==" };
      throw new Error(`Unexpected raw path: ${path}`);
    });
    const storage = imageAssetStorage();

    const results = await runWorkflow(
      workflow(
        [
          node("still", "asset", { assetKind: "image", artifactId: "hero-1" }),
          node("edit", "imageEdit", { model: "qwen-edit", prompt: "make it dusk" }),
          node("out", "output"),
        ],
        [edge("still", "edit", "images"), edge("edit", "out")],
      ),
      { storage },
    );

    const body = mediaRawMock.mock.calls.find((call) => call[0] === "/image/edit")?.[1] as Record<
      string,
      unknown
    >;
    expect(body.image).toBe("data:image/png;base64,SRC-hero-1");
    expect(body.prompt).toBe("make it dusk");
    expect(storage.save).toHaveBeenCalledWith(
      { base64: "RURJVA==" },
      "png",
      expect.objectContaining({ kind: "image", model: "qwen-edit" }),
    );
    expect(results.get("out")?.output).toMatchObject({ kind: "image", base64: "RURJVA==" });
  });

  it("composes several images through the multi-edit queue", async () => {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/image/multi-edit/queue") return { id: "edit-1" };
      throw new Error(`Unexpected path: ${path}`);
    });
    mediaRawMock.mockImplementation(async (path: string) => {
      if (path === "/image/multi-edit/retrieve") {
        return { status: 200, ok: true, bodyBase64: "Q09NUE9TRUQ=" };
      }
      throw new Error(`Unexpected raw path: ${path}`);
    });
    const storage = imageAssetStorage();

    const results = await runWorkflow(
      workflow(
        [
          node("a", "asset", { assetKind: "image", artifactId: "subject" }),
          node("b", "asset", { assetKind: "image", artifactId: "scene" }),
          node("edit", "imageEdit", { model: "nano-banana-pro", prompt: "place the subject" }),
          node("out", "output"),
        ],
        [edge("a", "edit", "images"), edge("b", "edit", "images"), edge("edit", "out")],
      ),
      { storage },
    );

    const queueBody = callsTo("/image/multi-edit/queue")[0]?.[1] as Record<string, unknown>;
    expect(queueBody.images).toEqual([
      "data:image/png;base64,SRC-subject",
      "data:image/png;base64,SRC-scene",
    ]);
    expect(results.get("out")?.output).toMatchObject({ kind: "image", base64: "Q09NUE9TRUQ=" });
  });
});

describe("approval gate", () => {
  it("holds the run: the gate reports awaiting, downstream stays pending", async () => {
    const results = await runWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "hello" }),
          node("g", "gate"),
          node("llm", "chat", { model: "m", prompt: "p" }),
        ],
        [edge("in", "g"), edge("g", "llm")],
      ),
    );

    expect(awaitingGateIds(results)).toEqual(["g"]);
    expect(results.get("g")?.status).toBe("awaiting");
    expect(results.get("llm")?.status).toBe("pending");
    expect(mediaJsonMock).not.toHaveBeenCalled();
  });

  it("passes the input through untouched once approved", async () => {
    mediaJsonMock.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const results = await runWorkflow(
      workflow(
        [
          node("in", "textInput", { text: "hello" }),
          node("g", "gate"),
          node("llm", "chat", { model: "m", prompt: "Say: {{input}}" }),
        ],
        [edge("in", "g"), edge("g", "llm")],
      ),
      { approvedGates: new Map([["g", undefined]]) },
    );

    expect(results.get("g")?.output).toEqual({ kind: "text", text: "hello" });
    const chatBody = callsTo("/chat/completions")[0]?.[1] as Record<string, unknown>;
    expect(chatBody.messages).toEqual([{ role: "user", content: "Say: hello" }]);
    expect(awaitingGateIds(results)).toEqual([]);
  });

  it("lets the approval pick which candidate continues", async () => {
    mediaJsonMock.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const results = await runWorkflow(
      workflow(
        [
          node("take1", "textInput", { text: "first take" }),
          node("take2", "textInput", { text: "second take" }),
          node("g", "gate"),
          node("llm", "chat", { model: "m", prompt: "{{input}}" }),
        ],
        [edge("take1", "g"), edge("take2", "g"), edge("g", "llm")],
      ),
      { approvedGates: new Map([["g", "take2"]]) },
    );

    expect(results.get("g")?.output).toEqual({ kind: "text", text: "second take" });
  });
});

describe("assemble node", () => {
  it("cuts connected clips in order, trims at handoffs, and lays the track under", async () => {
    const storage = fakeStorage({
      loadAsset: vi.fn(async (artifactId: string) => {
        if (artifactId === "clip-a") {
          return { kind: "video" as const, src: "blob:clip-a", artifactId };
        }
        if (artifactId === "clip-b") {
          return {
            kind: "video" as const,
            src: "blob:clip-b",
            artifactId,
            parentId: "clip-a",
            parentHandoffSeconds: 4.5,
          };
        }
        return { kind: "audio" as const, src: "blob:track", artifactId };
      }),
    });

    const finished = await runWorkflow(
      workflow(
        [
          node("a", "asset", { assetKind: "video", artifactId: "clip-a" }),
          node("b", "asset", { assetKind: "video", artifactId: "clip-b" }),
          node("track", "asset", { assetKind: "audio", artifactId: "track-1" }),
          node("film", "assemble", { audioVolume: 0.4 }),
          node("out", "output"),
        ],
        [
          edge("a", "film", "clips"),
          edge("b", "film", "clips"),
          edge("track", "film", "audio"),
          edge("film", "out"),
        ],
      ),
      { storage },
    );

    expect(assembleClipsMock).toHaveBeenCalledTimes(1);
    const options = assembleClipsMock.mock.calls[0][0];
    // The first clip is trimmed where its continuation took over.
    expect(options.clips).toEqual([
      { src: "blob:clip-a", inSeconds: 0, outSeconds: 4.5 },
      { src: "blob:clip-b", inSeconds: 0, outSeconds: undefined },
    ]);
    expect(options.audioSrc).toBe("blob:track");
    expect(options.audioVolume).toBe(0.4);

    // The film persisted as a video artifact and reached the output.
    expect(storage.save).toHaveBeenCalledWith({ base64: "RklMTQ==" }, "mp4", {
      kind: "video",
      model: "assemble",
      prompt: "film",
    });
    expect(finished.get("out")?.output).toMatchObject({ kind: "video", artifactId: "art-1" });
  });

  it("refuses to run without clips", async () => {
    const orphan = workflow(
      [node("film", "assemble"), node("out", "output")],
      [edge("film", "out")],
    );
    await expect(runWorkflow(orphan, { storage: fakeStorage() })).rejects.toThrow(WorkflowRunError);
  });
});
