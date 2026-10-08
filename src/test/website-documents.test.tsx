// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentsFeature } from "../../website/src/client/documents";
import {
  documentBytes,
  documentTitle,
  type LocalDocument,
  makeDocument,
  parseFilePayload,
  storeOf,
} from "../../website/src/client/documents/documents";
import {
  type BlobTransport,
  CHUNK_BYTES,
  fileDocument,
  listDocuments,
  readDocument,
} from "../../website/src/client/documents/gallery-file";
import { FileCard, FilesPanel } from "../../website/src/client/documents/ui";
import { readZip } from "../../website/src/client/documents/writers/zip";
import { type FeatureHost, featureStore } from "../../website/src/client/feature";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { decryptObject } from "../../website/src/lib/vault";
import { FakeJournal } from "./website-client-fakes";

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
const KEY = () => new Uint8Array(32).fill(9);

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function blobs() {
  const stored = new Map<string, string>();
  const transport: BlobTransport = {
    put: async (id, sealed) => {
      stored.set(id, sealed);
    },
    get: async (id) => {
      const sealed = stored.get(id);
      if (!sealed) throw new Error("missing");
      return sealed;
    },
  };
  return { stored, transport };
}

function host(withKey = true) {
  const journal = new FakeJournal();
  const store = memoryClientStore();
  const sync = new SyncClient(ACCOUNT, KEY(), store, journal.transport());
  const value = {
    account: { id: ACCOUNT, email: "a@example.test", created_at: "" },
    sync,
    storeFor: (feature: string) => featureStore(ACCOUNT, KEY(), store, feature),
    ...(withKey ? { vaultKey: KEY() } : {}),
  } as unknown as FeatureHost;
  return { host: value, journal, sync };
}

const request = {
  kind: "xlsx",
  title: "Budget",
  content: {
    sheets: [
      {
        name: "Q4",
        rows: [
          ["Item", "Cost"],
          ["Rent", 1200],
        ],
      },
    ],
  },
};

describe("documents in the web client", () => {
  it("makes the file, files it on the Studio lane and answers with the card", async () => {
    const { host: page, journal, sync } = host();
    const { stored, transport } = blobs();
    const reply = await makeDocument(page, request, { temporary: false }, transport);
    expect(reply).toContain('Made the Excel workbook "Budget" (1 sheet, 2 rows)');
    const block = /```subrosa:file\n(.+)\n```/.exec(reply)?.[1] ?? "";
    const payload = parseFilePayload(JSON.parse(block));
    expect(payload?.kind).toBe("xlsx");
    const id = payload?.file.slice(0, 36) ?? "";

    // The record first, then its manifest, both ordinary artifact objects.
    await sync.flush();
    const tables = await Promise.all(
      journal.changes.map(async (change) => ({
        kind: change.kind,
        value: await decryptObject(KEY(), ACCOUNT, change),
      })),
    );
    expect(tables.map((item) => item.value.table)).toEqual([
      "account_studio_files",
      "account_file_manifests",
    ]);
    expect(tables.every((item) => item.kind === "artifact")).toBe(true);
    expect(tables[0].value.row).toMatchObject({ id, file_name: payload?.file, format: "xlsx" });
    const manifest = tables[1].value.row as Record<string, string | number>;
    expect(manifest).toMatchObject({ artifact_id: id, source_kind: "studio", format: "xlsx" });
    const chunks = JSON.parse(String(manifest.chunks_json));
    expect(Object.keys(chunks[0])).toEqual(["id", "bytes", "sha256"]);
    expect(chunks[0].sha256).toHaveLength(43);
    // Only ciphertext left the browser.
    expect([...stored.values()][0]).toMatch(/^\{"v":1,"nonce":"[\w-]+","ciphertext":"[\w-]+"\}$/);

    // Another browser reads it back from the gallery, checked chunk by chunk.
    expect(listDocuments(sync)).toMatchObject([{ id, format: "xlsx", readable: true }]);
    const bytes = await readDocument({ sync, accountId: ACCOUNT, key: KEY(), transport }, id);
    expect(await documentTitle(bytes)).toBe("Budget");
    expect((await readZip(bytes)).map((entry) => entry.name)).toContain("xl/worksheets/sheet1.xml");
  });

  it("splits a large file in 1 MiB chunks and refuses a chunk that was changed", async () => {
    const { sync } = host();
    const { stored, transport } = blobs();
    const id = "0b7c1d2e-1111-4222-8333-444455556666";
    const bytes = new Uint8Array(CHUNK_BYTES + 10).map((_, index) => index % 251);
    const context = { sync, accountId: ACCOUNT, key: KEY(), transport };
    await fileDocument(context, `${id}.docx`, bytes);
    expect(stored.size).toBe(2);
    const back = await readDocument(context, id);
    expect(back.length).toBe(bytes.length);
    expect(back.every((byte, index) => byte === bytes[index])).toBe(true);
    const [first, second] = [...stored.keys()];
    stored.set(first, stored.get(second) ?? "");
    await expect(readDocument(context, id)).rejects.toThrow();
    await expect(fileDocument(context, "../x.docx", bytes)).rejects.toThrow();
  }, 30_000);

  it("keeps a temporary chat's file in this browser and files nothing", async () => {
    const { host: page, journal } = host();
    const { stored, transport } = blobs();
    const reply = await makeDocument(page, request, { temporary: true }, transport);
    const file = JSON.parse(/```subrosa:file\n(.+)\n```/.exec(reply)?.[1] ?? "{}").file;
    expect(stored.size).toBe(0);
    expect(journal.changes).toHaveLength(0);
    const local = await storeOf(page).get<LocalDocument>(file);
    expect(local?.filed).toBe(false);
    expect((await documentBytes(page, file)).length).toBe(local?.bytes);
  });

  it("answers the model in words when the request is wrong", async () => {
    const { host: page } = host();
    expect(await makeDocument(page, { kind: "pdf", content: {} }, { temporary: false })).toBe(
      "The document was not made: kind must be docx, xlsx or pptx.",
    );
  });

  it("offers make_document and draws the file card with its download", async () => {
    const { host: page } = host(false);
    const addition = await documentsFeature.turn?.(page, {
      chatId: "c",
      temporary: false,
      question: "",
    });
    expect(addition?.tools[0].function.name).toBe("make_document");
    const reply = await makeDocument(page, request, { temporary: false });
    const payload = JSON.parse(/```subrosa:file\n(.+)\n```/.exec(reply)?.[1] ?? "{}");
    const created = vi.fn(() => "blob:file");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(<FileCard payload={payload} host={page} messageId="m" />);
    expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
    // No vault key handed over: the file stayed in this browser.
    expect(await screen.findByText("Kept in this browser only")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(created).toHaveBeenCalled();
  });

  it("lists this browser's files and the gallery's in the Files panel", async () => {
    const { host: page, sync } = host();
    const { transport } = blobs();
    await makeDocument(page, request, { temporary: false }, transport);
    await fileDocument(
      { sync, accountId: ACCOUNT, key: KEY(), transport },
      "0b7c1d2e-1111-4222-8333-444455556667.pptx",
      new Uint8Array([1, 2, 3]),
    );
    render(<FilesPanel host={page} />);
    expect(await screen.findByText("Budget")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(2);
    expect(screen.getByText("PowerPoint deck")).toBeInTheDocument();
  });

  it("refuses a file card that names a path or disagrees with its file", () => {
    expect(parseFilePayload({ file: "../../etc/passwd.docx" })).toBeNull();
    expect(
      parseFilePayload({ file: "0b7c1d2e-1111-4222-8333-444455556666.docx", kind: "xlsx" }),
    ).toBeNull();
  });
});
