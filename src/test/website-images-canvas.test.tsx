// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCanvas, canvasRewriteBody, rewriteCanvas } from "../../website/src/client/canvas";
import type { Operator } from "../../website/src/client/carpe-diem";
import { AGENT_LITE } from "../../website/src/client/codec";
import {
  type BlobTransport,
  listGalleryPictures,
  loadPicture,
  saveToGallery,
} from "../../website/src/client/gallery";
import {
  editImage,
  generateImage,
  imageModels,
  tryOn,
  tryOnModel,
} from "../../website/src/client/images";
import { createNote, listNotes } from "../../website/src/client/library";
import { LocalState } from "../../website/src/client/local";
import { ImagesView } from "../../website/src/client/ui/ImagesView";
import { parseCritique, refine, refineEditPrompt } from "../../website/src/client/refine";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { MessageBody } from "../../website/src/lib/chat-blocks";
import { FakeJournal, text } from "./website-client-fakes";

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
const key = () => new Uint8Array(32).fill(6);
const PNG = "data:image/png;base64,iVBORw0KGgo=";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function operator(routes: Record<string, (body: Record<string, unknown>) => Response>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const value: Operator = {
    root: "https://operator.test",
    fetch: async (input, init) => {
      const path = String(input).slice("https://operator.test".length);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });
      const route = routes[path];
      return route ? route(body) : new Response("{}", { status: 404 });
    },
  };
  return { operator: value, calls };
}

describe("pictures through Carpe Diem", () => {
  it("generates on the quick route with the app's body", async () => {
    const { operator: op, calls } = operator({
      "/v1/image/generate": () => json({ images: ["iVBORw0KGgo="] }),
    });
    const picture = await generateImage(
      { operator: op, key: "cdm_k" },
      { model: "flux-2", prompt: "A fox", aspectRatio: "1:1" },
    );
    expect(picture.dataUrl).toBe(PNG);
    expect(calls[0].body).toEqual({
      model: "flux-2",
      prompt: "A fox",
      variants: 1,
      format: "png",
      hide_watermark: true,
      safe_mode: false,
      aspect_ratio: "1:1",
    });
  });

  it("queues a heavy model, keeps its job for a reload, and fetches the result", async () => {
    let polls = 0;
    const { operator: op } = operator({
      "/v1/image/generate/queue": () => json({ queue_id: "q1" }),
      "/v1/image/generate/retrieve": () =>
        ++polls < 2
          ? json({ status: "PROCESSING" })
          : new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }),
    });
    const kept: string[] = [];
    const done: string[] = [];
    const picture = await generateImage(
      {
        operator: op,
        key: "k",
        pollMs: 0,
        keeper: { keep: (job) => void kept.push(job.queueId), done: (id) => void done.push(id) },
      },
      { model: "gpt-image-2", prompt: "A fox" },
    );
    expect(picture.dataUrl).toBe("data:image/png;base64,AQI=");
    expect(kept).toEqual(["q1"]);
    expect(done).toEqual(["q1"]);
  });

  it("falls back to the queue when the quick route says so", async () => {
    const { operator: op, calls } = operator({
      "/v1/image/edit": () => json({ code: "MODEL_REQUIRES_ASYNC", error: "use the queue" }, 409),
      "/v1/image/edit/queue": () => json({ id: "q2" }),
      "/v1/image/edit/retrieve": () => json({ images: [{ b64_json: "iVBORw0KGgo=" }] }),
    });
    const picture = await editImage(
      { operator: op, key: "k", pollMs: 0 },
      { model: "seedream-v4-edit", prompt: "Red", image: PNG },
    );
    expect(picture.dataUrl).toBe(PNG);
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/image/edit",
      "/v1/image/edit/queue",
      "/v1/image/edit/retrieve",
    ]);
  });

  it("dresses the person in the garment with the app's tuned prompt", async () => {
    const editors = imageModels("imageEdit");
    expect(tryOnModel(editors)?.id).toBe("nano-banana-2-edit");
    const { operator: op, calls } = operator({
      "/v1/image/multi-edit/queue": () => json({ queue_id: "q3" }),
      "/v1/image/multi-edit/retrieve": () => json({ images: ["iVBORw0KGgo="] }),
    });
    await tryOn(
      { operator: op, key: "k", pollMs: 0 },
      { model: "nano-banana-2-edit", person: PNG, garment: PNG, garmentLabel: "red coat" },
    );
    const prompt = String(calls[0].body.prompt);
    expect(prompt.startsWith("Virtual try-on. Image 1 is the person.")).toBe(true);
    expect(prompt).toContain("garment from image 2 (red coat).");
    expect(calls[0].body.images).toEqual([PNG, PNG]);
  });

  it("checks a picture and fixes it once, then stops when nothing is wrong", async () => {
    const verdicts = [
      '{"satisfied": false, "issues": ["two foxes"], "instruction": "Keep one fox"}',
      'Sure: {"satisfied": true, "issues": []}',
    ];
    let index = 0;
    const { operator: op, calls } = operator({
      "/v1/chat/completions": () => {
        const frames = text(verdicts[index++])
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join("");
        return new Response(`${frames}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      "/v1/image/edit": () => json({ images: ["iVBORw0KGgo="] }),
    });
    const steps: number[] = [];
    await refine(
      { operator: op, key: "k" },
      {
        visionModel: "vision",
        editModel: "qwen-image-2-edit",
        picture: { dataUrl: PNG, model: "m", prompt: "One fox" },
        onStep: (step) => steps.push(step.pass),
      },
    );
    expect(steps).toEqual([1, 2]);
    const edit = calls.find((call) => call.path === "/v1/image/edit");
    expect(edit?.body.prompt).toBe(`Keep one fox.${AGENT_LITE.editing.refine.editSuffix}`);
    expect((calls[0].body.messages as { role: string }[])[0]).toEqual({
      role: "system",
      content: AGENT_LITE.editing.refine.critiqueSystem,
    });
    expect(parseCritique('{"satisfied": false}')).toEqual({
      satisfied: true,
      issues: [],
      instruction: undefined,
    });
    expect(refineEditPrompt("Fix it!")).toBe(`Fix it!${AGENT_LITE.editing.refine.editSuffix}`);
  });
});

describe("a picture queued before a reload", () => {
  it("is fetched when the view opens again, filed, and forgotten as pending", async () => {
    const journal = new FakeJournal();
    const store = memoryClientStore();
    const sync = new SyncClient(ACCOUNT, key(), store, journal.transport());
    const local = new LocalState(ACCOUNT, key(), store);
    await local.setPendingImages([
      { queueId: "q9", base: "/v1/image/generate", model: "gpt-image-2", prompt: "A fox" },
    ]);
    const { operator: op, calls } = operator({
      "/v1/image/generate/retrieve": () => json({ images: ["iVBORw0KGgo="] }),
    });
    const blobs: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        blobs.push(String(init?.method));
        return new Response("{}", { status: 200 });
      }),
    );
    render(
      <ImagesView
        ctx={{
          account: { id: ACCOUNT, email: "", created_at: "" },
          vaultKey: key(),
          sync,
          local,
          operator: op,
          openKey: async () => "cdm_k",
          models: [],
          live: [],
          model: "",
          flush: () => undefined,
          openChat: () => undefined,
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("In your gallery")).toBeInTheDocument(), {
      timeout: 6000,
    });
    expect(calls.filter((call) => call.path.endsWith("/retrieve"))).toHaveLength(1);
    expect(await local.pendingImages()).toEqual([]);
    expect(listGalleryPictures(sync)).toMatchObject([{ prompt: "A fox", model: "gpt-image-2" }]);
    expect(blobs).toEqual(["PUT"]);
  }, 10_000);
});

describe("the gallery from the browser", () => {
  it("files a picture as the app's file and manifest records, and reads it back", async () => {
    const journal = new FakeJournal();
    const sync = new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport());
    const blobs = new Map<string, string>();
    const transport: BlobTransport = {
      put: async (id, sealed) => void blobs.set(id, sealed),
      get: async (id) => blobs.get(id) as string,
    };
    const id = await saveToGallery(
      { sync, accountId: ACCOUNT, key: key(), transport: transport },
      { dataUrl: PNG, model: "flux-2", prompt: "A fox" },
    );
    await sync.flush();
    expect(journal.pushes.map((push) => push.kind)).toEqual(["artifact", "artifact"]);
    expect(journal.pushes[0].object_id).toBe(id);
    const [picture] = listGalleryPictures(sync);
    expect(picture).toMatchObject({
      id,
      format: "png",
      model: "flux-2",
      prompt: "A fox",
      bytes: 8,
    });
    expect(await loadPicture({ sync, accountId: ACCOUNT, key: key(), transport }, id)).toBe(PNG);
    const [blob] = [...blobs.values()];
    expect(blob).not.toContain("iVBOR");
  });
});

describe("the canvas (ADR-0087)", () => {
  it("asks for a whole-document version with Rust's prompt, and writes only on accept", async () => {
    const body = canvasRewriteBody("model", "# Draft", "Make it shorter");
    expect(body.messages[0].content).toBe(AGENT_LITE.editing.canvas.system);
    expect(body.messages[1].content).toContain("<instruction>\nMake it shorter\n</instruction>");
    expect(body.messages[1].content).toContain("<selection>\n# Draft\n</selection>");
    expect(() => canvasRewriteBody("model", "x".repeat(24_001), "Shorter")).toThrow();

    const journal = new FakeJournal();
    const sync = new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport());
    const note = await createNote(sync, "Draft", "# Draft");
    const { operator: op } = operator({
      "/v1/chat/completions": () => {
        const frames = text("# Short")
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join("");
        return new Response(`${frames}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const seen: string[] = [];
    const proposed = await rewriteCanvas(op, "k", "model", "# Draft", "Shorter", (sofar) =>
      seen.push(sofar),
    );
    expect(proposed).toBe("# Short");
    expect(listNotes(sync)[0].body).toBe("# Draft");
    await applyCanvas(sync, note.id, proposed);
    expect(listNotes(sync)[0].body).toBe("# Short");
  });
});

describe("chart and table cards on the website", () => {
  const chart = [
    "Here:",
    "```subrosa:chart",
    JSON.stringify({
      v: 1,
      type: "bar",
      title: "Revenue",
      categories: ["Q1", "Q2"],
      series: [{ name: "2025", values: [120, 135] }],
      y: { unit: "€" },
    }),
    "```",
  ].join("\n");
  const table = [
    "```subrosa:table",
    JSON.stringify({
      v: 1,
      title: "Regions",
      columns: ["Region", { label: "Revenue", unit: "€" }],
      rows: [
        ["North", 1200],
        ["South", 900],
        ["East", null],
      ],
    }),
    "```",
  ].join("\n");

  it("draws a chart with its data view and a CSV", async () => {
    const user = userEvent.setup();
    render(<MessageBody content={chart} />);
    expect(
      screen.getByRole("img", { name: "Revenue" }).querySelectorAll("path.data-mark"),
    ).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Show data" }));
    expect(screen.getByRole("columnheader", { name: "2025 (€)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download CSV" }).getAttribute("href")).toMatch(
      /^data:text\/csv/,
    );
    for (const element of document.querySelectorAll("*"))
      expect(element.getAttribute("style")).toBeNull();
  });

  it("sorts a table by a column, empty cells last", async () => {
    const user = userEvent.setup();
    render(<MessageBody content={table} />);
    await user.click(screen.getByRole("button", { name: "Revenue (€)" }));
    const cells = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent);
    expect(cells).toEqual(["South900", "North1,200", "East"]);
  });
});
