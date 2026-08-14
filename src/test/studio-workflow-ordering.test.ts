// Connection order on multi ports: the order of a port's inputs is the order
// of its edges in the array. These tests lock that contract twice — once on
// the helpers the UI reorders with, once on the request bodies the engine
// actually sends (the part a refactor could silently break).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
  mediaBinary: vi.fn(),
  mediaGet: vi.fn(),
  mediaRaw: vi.fn(),
}));
vi.mock("../lib/studio/catalog", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/studio/catalog")>();
  return {
    ...original,
    fetchMediaCatalog: vi.fn(async () => ({ backend: "carpe-diem", models: [] })),
  };
});
vi.mock("../lib/studio/assemble", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/assemble")>()),
  assembleClips: vi.fn(async () => ({ blob: new Blob(["film"]), extension: "mp4" })),
  blobToBase64: vi.fn(async () => "RklMTQ=="),
}));

import { assembleClips } from "../lib/studio/assemble";
import { mediaJson, mediaRaw } from "../lib/studio/client";
import { runWorkflow, type WorkflowStorage } from "../lib/studio/workflow/engine";
import {
  applyPortOrder,
  chainOrderSuggestion,
  edgesOnPort,
  reorderPortEdge,
  textSourceLabels,
} from "../lib/studio/workflow/ordering";
import {
  defaultParams,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../lib/studio/workflow/schema";

const mediaJsonMock = vi.mocked(mediaJson);
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

function imageStorage(): WorkflowStorage {
  let saves = 0;
  return {
    save: vi.fn(async () => {
      saves += 1;
      return { artifactId: `art-${saves}`, src: `blob:art-${saves}` };
    }),
    loadAsset: vi.fn(async (artifactId: string) => ({
      kind: "image" as const,
      src: `data:image/png;base64,${artifactId}`,
      base64: artifactId,
      mimeType: "image/png",
      artifactId,
    })),
    loadNote: vi.fn(async () => ({ title: "", text: "" })),
    readMedia: vi.fn(async (artifactId: string) => `data:video/mp4;base64,${artifactId}`),
  };
}

beforeEach(() => {
  mediaJsonMock.mockReset();
  mediaRawMock.mockReset();
  assembleClipsMock.mockClear();
});

describe("edgesOnPort", () => {
  const clipGraph = (model: string) =>
    workflow(
      [
        node("a", "asset", { assetKind: "image", artifactId: "a" }),
        node("b", "asset", { assetKind: "image", artifactId: "b" }),
        node("still", "asset", { assetKind: "image", artifactId: "s" }),
        node("clip", "video", { model, prompt: "p" }),
      ],
      [
        edge("a", "clip", "references"),
        // Portless: resolved by kind affinity, which port it lands on depends
        // on which ports the node's model leaves open.
        edge("still", "clip"),
        edge("b", "clip", "references"),
      ],
    );

  it("buckets explicit and affinity edges the way the engine does", () => {
    // No model yet, so every port is open and affinity picks the opening frame
    // ahead of the references, exactly as it always has.
    const graph = clipGraph("");
    expect(edgesOnPort(graph, "clip", "openingFrame").map((entry) => entry.source)).toEqual([
      "still",
    ]);
    expect(edgesOnPort(graph, "clip", "references").map((entry) => entry.source)).toEqual([
      "a",
      "b",
    ]);
  });

  it("re-homes a portless edge when the model closed the port it used to take", () => {
    // A reference-to-video model has no opening frame: the portless image
    // joins the references rather than resolving to nothing, and it does so in
    // its own edge-array position (a, still, b), which is its render order.
    const graph = clipGraph("seedance-2-0-reference-to-video-basic");
    expect(edgesOnPort(graph, "clip", "openingFrame")).toEqual([]);
    expect(edgesOnPort(graph, "clip", "references").map((entry) => entry.source)).toEqual([
      "a",
      "still",
      "b",
    ]);
  });
});

describe("textSourceLabels", () => {
  // What decides whether an editor offers to write "{{input}}": the marker is
  // meaningless on a node nothing upstream is talking to, and naming the
  // source is what turns the token into a sentence the user can check.
  it("names the nodes feeding a node's text input", () => {
    const graph = workflow(
      [
        node("brief", "textInput", { text: "a brief" }),
        node("notes", "textInput", { text: "more" }),
        node("still", "asset", { assetKind: "image", artifactId: "a" }),
        node("shot", "video", { model: "kling-2.5-turbo-pro-image-to-video", prompt: "p" }),
      ],
      [
        edge("brief", "shot", "prompt"),
        edge("still", "shot", "openingFrame"),
        edge("notes", "shot", "prompt"),
      ],
    );
    // Named, in connection order, and the image is not one of them.
    expect(textSourceLabels(graph, "shot")).toEqual(["brief", "notes"]);
  });

  it("is empty when nothing feeds the text input, or there is none", () => {
    const graph = workflow(
      [
        node("brief", "textInput", { text: "a brief" }),
        node("shot", "video", { model: "kling-2.5-turbo-pro-text-to-video", prompt: "p" }),
        node("out", "output"),
      ],
      [edge("shot", "out")],
    );
    expect(textSourceLabels(graph, "shot")).toEqual([]);
    // An asset node has no inputs at all.
    expect(textSourceLabels(graph, "brief")).toEqual([]);
  });
});

describe("reorderPortEdge", () => {
  it("moves a connection within its port and leaves other ports untouched", () => {
    const graph = workflow(
      [
        node("a", "asset", { assetKind: "image", artifactId: "a" }),
        node("b", "asset", { assetKind: "image", artifactId: "b" }),
        node("still", "asset", { assetKind: "image", artifactId: "s" }),
        node("clip", "video", { model: "seedance-2-0-reference-to-video-basic", prompt: "p" }),
      ],
      [
        edge("a", "clip", "references"),
        edge("still", "clip", "openingFrame"),
        edge("b", "clip", "references"),
      ],
    );

    const reordered = reorderPortEdge(graph, "b-clip-references", -1);
    expect(reordered.map((entry) => entry.id)).toEqual([
      "b-clip-references",
      "still-clip-openingFrame",
      "a-clip-references",
    ]);
    // The opening frame edge kept its array slot; only the two reference
    // edges swapped around it.
    expect(
      edgesOnPort({ ...graph, edges: reordered }, "clip", "references").map(
        (entry) => entry.source,
      ),
    ).toEqual(["b", "a"]);
  });

  it("returns the same array when the move is impossible", () => {
    const graph = workflow(
      [
        node("a", "asset", { assetKind: "image", artifactId: "a" }),
        node("clip", "video", { model: "seedance-2-0-reference-to-video-basic", prompt: "p" }),
      ],
      [edge("a", "clip", "references")],
    );
    expect(reorderPortEdge(graph, "a-clip-references", -1)).toBe(graph.edges);
    expect(reorderPortEdge(graph, "ghost", 1)).toBe(graph.edges);
  });
});

describe("applyPortOrder", () => {
  it("rewrites the port's connections in place, other edges untouched", () => {
    const edges = [
      edge("x", "film", "clips"),
      edge("track", "film", "audio"),
      edge("y", "film", "clips"),
    ];
    const applied = applyPortOrder(edges, ["y-film-clips", "x-film-clips"]);
    expect(applied.map((entry) => entry.id)).toEqual([
      "y-film-clips",
      "track-film-audio",
      "x-film-clips",
    ]);
  });
});

describe("chainOrderSuggestion", () => {
  function chainGraph(clipEdges: WorkflowEdge[]): Workflow {
    return workflow(
      [
        node("first", "video", { model: "seedance-2-0-text-to-video-basic", prompt: "one" }),
        node("frame", "lastFrame"),
        node("second", "video", { model: "seedance-2-0-image-to-video-basic", prompt: "two" }),
        node("film", "assemble"),
      ],
      [edge("first", "frame", "video"), edge("frame", "second", "openingFrame"), ...clipEdges],
    );
  }

  it("suggests the graph's chain order when the connections disagree", () => {
    const graph = chainGraph([edge("second", "film", "clips"), edge("first", "film", "clips")]);
    expect(chainOrderSuggestion(graph, "film")).toEqual(["first-film-clips", "second-film-clips"]);
  });

  it("stays quiet when the order already matches or nothing links the clips", () => {
    const ordered = chainGraph([edge("first", "film", "clips"), edge("second", "film", "clips")]);
    expect(chainOrderSuggestion(ordered, "film")).toBeUndefined();

    const unlinked = workflow(
      [
        node("a", "video", { model: "seedance-2-0-text-to-video-basic", prompt: "a" }),
        node("b", "video", { model: "seedance-2-0-text-to-video-basic", prompt: "b" }),
        node("film", "assemble"),
      ],
      [edge("a", "film", "clips"), edge("b", "film", "clips")],
    );
    expect(chainOrderSuggestion(unlinked, "film")).toBeUndefined();
  });
});

describe("the engine honors connection order (the wire contract)", () => {
  it("sends reference_image_urls in connection order, and follows a reorder", async () => {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/video/queue") return { id: "vid-1" };
      throw new Error(`Unexpected path: ${path}`);
    });
    mediaRawMock.mockImplementation(async () => ({
      status: 200,
      ok: true,
      json: { status: "completed", video_url: "https://example.test/clip.mp4" },
    }));

    const graph = workflow(
      [
        node("a", "asset", { assetKind: "image", artifactId: "AAA" }),
        node("b", "asset", { assetKind: "image", artifactId: "BBB" }),
        node("clip", "video", { model: "seedance-2-0-reference-to-video-basic", prompt: "p" }),
      ],
      [edge("a", "clip", "references"), edge("b", "clip", "references")],
    );

    await runWorkflow(graph, { storage: imageStorage() });
    let body = mediaJsonMock.mock.calls.find((call) => call[0] === "/video/queue")?.[1] as Record<
      string,
      unknown
    >;
    expect(body.reference_image_urls).toEqual([
      "data:image/png;base64,AAA",
      "data:image/png;base64,BBB",
    ]);

    mediaJsonMock.mockClear();
    await runWorkflow(
      { ...graph, edges: reorderPortEdge(graph, "b-clip-references", -1) },
      { storage: imageStorage() },
    );
    body = mediaJsonMock.mock.calls.find((call) => call[0] === "/video/queue")?.[1] as Record<
      string,
      unknown
    >;
    expect(body.reference_image_urls).toEqual([
      "data:image/png;base64,BBB",
      "data:image/png;base64,AAA",
    ]);
  });

  it("composes image edit sources in connection order", async () => {
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/image/multi-edit/queue") return { id: "edit-1" };
      throw new Error(`Unexpected path: ${path}`);
    });
    mediaRawMock.mockImplementation(async () => ({
      status: 200,
      ok: true,
      bodyBase64: "RURJVA==",
    }));

    await runWorkflow(
      workflow(
        [
          node("subject", "asset", { assetKind: "image", artifactId: "SUBJ" }),
          node("scene", "asset", { assetKind: "image", artifactId: "SCEN" }),
          node("edit", "imageEdit", { model: "nano-banana-pro", prompt: "compose" }),
        ],
        [edge("scene", "edit", "images"), edge("subject", "edit", "images")],
      ),
      { storage: imageStorage() },
    );

    const body = mediaJsonMock.mock.calls.find(
      (call) => call[0] === "/image/multi-edit/queue",
    )?.[1] as Record<string, unknown>;
    // "image 1" is the scene, "image 2" the subject — exactly the connection
    // order, which is what the visible numbering promises.
    expect(body.images).toEqual(["data:image/png;base64,SCEN", "data:image/png;base64,SUBJ"]);
  });

  it("cuts assemble clips in connection order", async () => {
    const storage: WorkflowStorage = {
      save: vi.fn(async () => ({ artifactId: "film", src: "blob:film" })),
      loadAsset: vi.fn(async (artifactId: string) => ({
        kind: "video" as const,
        src: `blob:${artifactId}`,
        artifactId,
      })),
      loadNote: vi.fn(async () => ({ title: "", text: "" })),
      readMedia: vi.fn(async (artifactId: string) => `data:video/mp4;base64,${artifactId}`),
    };
    const graph = workflow(
      [
        node("a", "asset", { assetKind: "video", artifactId: "clip-a" }),
        node("b", "asset", { assetKind: "video", artifactId: "clip-b" }),
        node("film", "assemble"),
      ],
      [edge("b", "film", "clips"), edge("a", "film", "clips")],
    );

    await runWorkflow(graph, { storage });
    const options = assembleClipsMock.mock.calls[0][0];
    expect(options.clips.map((clip) => clip.src)).toEqual(["blob:clip-b", "blob:clip-a"]);
  });
});
