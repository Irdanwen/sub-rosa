// "Save a copy with its workflow": the file carried out is the graph the run
// froze (or the workflow as it stands when that run is gone), compact, and
// the importer finds it again in a PNG chunk or anywhere in a file's bytes,
// before any ComfyUI graph the same file might carry.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  frozen: undefined as unknown,
  stored: [] as unknown[],
}));
vi.mock("../lib/studio/workflow-run", () => ({
  frozenWorkflow: vi.fn(async () => state.frozen),
}));
vi.mock("../lib/studio/workflow/store", () => ({
  loadWorkflowLibrary: vi.fn(async () => state.stored),
  listWorkflows: () => state.stored,
}));

import { readEmbeddedWorkflow } from "../lib/studio/workflow/comfy/embedded";
import { readWorkflowFile } from "../lib/studio/workflow/comfy/file";
import { workflowFileFor } from "../lib/studio/workflow/embed";
import type { Workflow } from "../lib/studio/workflow/schema";

const node = (id: string, text: string) => ({
  id,
  type: "textInput" as const,
  label: "",
  position: { x: 0, y: 0 },
  params: { text },
});
const stored: Workflow = {
  id: "w",
  name: "Album cover",
  nodes: [node("a", "now")],
  edges: [],
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  state.frozen = undefined;
  state.stored = [stored];
});

describe("the workflow a copy carries", () => {
  it("is the graph the run froze, under the workflow's name", async () => {
    state.frozen = { ...stored, name: "", nodes: [node("a", "when it ran")] };
    const text = await workflowFileFor({ surface: "workflow", workflowId: "w", runId: "r" });
    expect(text).toBeDefined();
    // Compact: it goes inside another file.
    expect(text).not.toContain("\n");
    const read = readWorkflowFile(text ?? "", { backend: "carpe-diem", models: [] });
    if (read.kind !== "subrosa") throw new Error("not a Sub Rosa file");
    expect(read.workflow.name).toBe("Album cover");
    expect(read.workflow.nodes[0].params.text).toBe("when it ran");
  });

  it("carries the blocks a run wrote, not the steps it ran them as", async () => {
    const block = {
      id: "b",
      name: "Shot",
      nodes: [node("a", "inside")],
      edges: [],
      inputs: [],
      outputs: [],
      promoted: [],
    };
    const instance = { ...node("i", ""), type: "block" as const, params: { blockId: "b" } };
    state.frozen = {
      ...stored,
      nodes: [node("i/a", "inside")],
      extra: { written: { nodes: [instance], edges: [], blocks: [block] } },
    };
    const text = await workflowFileFor({ surface: "workflow", workflowId: "w", runId: "r" });
    const read = readWorkflowFile(text ?? "", { backend: "carpe-diem", models: [] });
    if (read.kind !== "subrosa") throw new Error("not a Sub Rosa file");
    expect(read.workflow.nodes.map((entry) => entry.type)).toEqual(["block"]);
    expect(read.workflow.blocks?.[0].name).toBe("Shot");
    expect(read.workflow.extra).toBeUndefined();
  });

  it("is the workflow as it stands when its run is gone, and nothing when both are", async () => {
    const text = await workflowFileFor({ surface: "workflow", workflowId: "w", runId: "gone" });
    expect(text).toContain('"text":"now"');
    state.stored = [];
    expect(await workflowFileFor({ surface: "workflow", workflowId: "w" })).toBeUndefined();
  });
});

const encoder = new TextEncoder();
const FILE = JSON.stringify({
  format: "subrosa-workflow",
  version: 2,
  workflow: { name: "Café", nodes: [], edges: [] },
});
const COMFY = JSON.stringify({ last_node_id: 1, nodes: [{ id: 1, type: "SaveImage" }], links: [] });

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  return out;
}

function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("a copy read back by the importer", () => {
  it("gives Sub Rosa's own chunk from a PNG, before a ComfyUI one", async () => {
    // As workflow_embed.rs writes it: keyword, then flag, method, empty
    // language and translation, then the text.
    const own = chunk(
      "iTXt",
      join(
        encoder.encode("subrosa-workflow"),
        new Uint8Array([0, 0, 0, 0, 0]),
        encoder.encode(FILE),
      ),
    );
    const comfy = chunk(
      "tEXt",
      join(encoder.encode("workflow"), new Uint8Array([0]), encoder.encode(COMFY)),
    );
    const png = join(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      comfy,
      own,
      chunk("IEND", new Uint8Array()),
    );
    expect(await readEmbeddedWorkflow(new Blob([png]))).toBe(FILE);
  });

  it("finds it in a picture's comment or a video's last box, accents intact", async () => {
    const jpeg = join(
      new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0, 0]),
      encoder.encode(FILE),
      new Uint8Array([0xff, 0xd9]),
    );
    expect(await readEmbeddedWorkflow(new Blob([jpeg]))).toBe(FILE);
    const video = join(
      new Uint8Array([0, 0, 0, 8]),
      encoder.encode("ftyp"),
      new Uint8Array(4096),
      new Uint8Array([0, 0, 0, 0]),
      encoder.encode("uuidsubrosa-workflow"),
      encoder.encode(FILE),
    );
    expect(await readEmbeddedWorkflow(new Blob([video]))).toBe(FILE);
  });
});
