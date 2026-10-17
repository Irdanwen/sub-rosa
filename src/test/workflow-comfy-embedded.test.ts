/**
 * The ComfyUI graph a picture or a video carries: in a PNG's text chunks
 * (plain or compressed), or as JSON somewhere in a file's metadata. The
 * editor's file is preferred over the executable one.
 */

import { describe, expect, it } from "vitest";
import {
  findComfyJson,
  pngTextChunks,
  readEmbeddedWorkflow,
} from "../lib/studio/workflow/comfy/embedded";

const UI_GRAPH = JSON.stringify({
  last_node_id: 2,
  nodes: [{ id: 1, type: "SaveImage", mode: 0, inputs: [] }],
  links: [],
});
const API_GRAPH = JSON.stringify({ "1": { class_type: "SaveImage", inputs: {} } });

const encoder = new TextEncoder();

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  // The CRC is not checked by the reader.
  return out;
}

function png(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunks,
    chunk("IEND", new Uint8Array()),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const text = (keyword: string, value: string) =>
  chunk("tEXt", new Uint8Array([...encoder.encode(keyword), 0, ...encoder.encode(value)]));

async function deflate(value: string): Promise<Uint8Array> {
  const body = new Response(encoder.encode(value)).body;
  if (!body) throw new Error("no stream");
  const stream = body.pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("a ComfyUI picture", () => {
  it("gives its editor's graph from a text chunk, before the executable one", async () => {
    const file = new Blob([png(text("prompt", API_GRAPH), text("workflow", UI_GRAPH))]);
    expect(await readEmbeddedWorkflow(file)).toBe(UI_GRAPH);
  });

  it("falls back to the executable graph", async () => {
    const file = new Blob([png(text("prompt", API_GRAPH))]);
    expect(await readEmbeddedWorkflow(file)).toBe(API_GRAPH);
  });

  it("reads a compressed international text chunk", async () => {
    const body = await deflate(UI_GRAPH);
    const data = new Uint8Array([...encoder.encode("workflow"), 0, 1, 0, 0, 0, ...body]);
    const chunks = await pngTextChunks(png(chunk("iTXt", data)));
    expect(chunks.get("workflow")).toBe(UI_GRAPH);
  });
});

describe("a file with the graph in its metadata", () => {
  it("finds the JSON among other bytes, accents intact", async () => {
    const graph = JSON.stringify({
      last_node_id: 1,
      nodes: [{ id: 1, type: "Note", widgets_values: ["Caméra à l'épaule"] }],
      links: [],
    });
    const bytes = new Uint8Array([
      ...encoder.encode("ftypisom....moov..udta..©cmt"),
      ...encoder.encode(JSON.stringify({ prompt: "x", workflow: JSON.parse(graph) })),
      ...encoder.encode("mdat garbage {not json"),
    ]);
    const found = await readEmbeddedWorkflow(new Blob([bytes]));
    expect(found && JSON.parse(found).nodes[0].widgets_values[0]).toBe("Caméra à l'épaule");
  });

  it("says nothing when there is no graph", async () => {
    expect(
      await readEmbeddedWorkflow(new Blob([encoder.encode("just a picture")])),
    ).toBeUndefined();
    expect(findComfyJson('{"nodes": "not a graph"}')).toBeUndefined();
  });
});
