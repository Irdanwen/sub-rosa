/**
 * What the documents feature does, apart from drawing it: run the tool, keep
 * what this browser made, file it in the gallery, and read a file back.
 *
 * A document made here is kept in this browser (sealed under the vault key,
 * `FeatureStore`) and filed in the account's gallery, where the app's
 * Library lists it and every device can open it. A temporary chat files
 * nothing (ADR-0083): its document stays in this browser.
 */
import { decode, encode } from "../../lib/vault";
import type { FeatureHost, FeatureStore, TurnInfo } from "../feature";
import {
  type BlobTransport,
  fileDocument,
  type GalleryContext,
  readGalleryDocument,
} from "../gallery";
import {
  build,
  type DocumentKind,
  DocumentInvalid,
  type MadeDocument,
  MIME,
  notMade,
  packageParts,
  parseRequest,
  toolReply,
} from "./make";
import { readZip } from "./unzip";

type Key = Uint8Array<ArrayBuffer>;

export interface LocalDocument {
  file: string;
  title: string;
  kind: DocumentKind;
  bytes: number;
  detail: string;
  createdAt: string;
  /** In the account's gallery, not only in this browser. */
  filed: boolean;
  /** The file, base64url. */
  data: string;
}

/** The vault key the page hands its features (null only in a test host). */
export function vaultKeyOf(host: FeatureHost): Key | null {
  return host.vaultKey ?? null;
}

export function galleryOf(host: FeatureHost, transport?: BlobTransport): GalleryContext | null {
  const key = vaultKeyOf(host);
  return key ? { sync: host.sync, accountId: host.account.id, key, transport } : null;
}

export const FEATURE = "documents";
export const storeOf = (host: FeatureHost): FeatureStore => host.storeFor(FEATURE);

/** `make_document`: the file, kept here, filed when it can be, and the
 * reply the model copies the card from. A failure is a sentence. */
export async function makeDocument(
  host: FeatureHost,
  args: Record<string, unknown>,
  turn: Pick<TurnInfo, "temporary" | "onStatus">,
  transport?: BlobTransport,
): Promise<string> {
  turn.onStatus?.("making-document");
  try {
    const request = parseRequest(args);
    const built = build(request);
    const bytes = await packageParts(built.parts);
    const file = `${crypto.randomUUID()}.${request.kind}`;
    const made: MadeDocument = {
      file,
      title: request.title,
      kind: request.kind,
      bytes: bytes.length,
      detail: built.detail,
      warnings: built.warnings,
    };
    const local: LocalDocument = {
      file,
      title: made.title,
      kind: made.kind,
      bytes: made.bytes,
      detail: made.detail,
      createdAt: new Date().toISOString(),
      filed: false,
      data: encode(bytes),
    };
    const gallery = turn.temporary ? null : galleryOf(host, transport);
    if (gallery) {
      try {
        await fileDocument(gallery, file, bytes);
        local.filed = true;
      } catch {
        // Kept here; the card says the file is in this browser only.
      }
    }
    await storeOf(host).put(file, local);
    return toolReply(made);
  } catch (error) {
    if (error instanceof DocumentInvalid) return notMade(error.message);
    return notMade(error instanceof Error ? error.message : "unknown error");
  }
}

/** The file's bytes: this browser's copy, else the gallery's. */
export async function documentBytes(
  host: FeatureHost,
  file: string,
  transport?: BlobTransport,
): Promise<Uint8Array> {
  const local = await storeOf(host).get<LocalDocument>(file);
  if (local) return decode(local.data);
  const gallery = galleryOf(host, transport);
  if (!gallery) throw new Error("unavailable");
  return readGalleryDocument(gallery, file.replace(/\.[a-z]+$/, ""));
}

/** The title a file carries in `docProps/core.xml`, the way the app's Library
 * reads it, so a document from another device is titled too. */
export async function documentTitle(bytes: Uint8Array): Promise<string | null> {
  try {
    const core = (await readZip(bytes)).find((entry) => entry.name === "docProps/core.xml");
    if (!core) return null;
    const match = /<dc:title>([^<]*)<\/dc:title>/.exec(new TextDecoder().decode(core.bytes));
    if (!match) return null;
    return (
      match[1]
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&")
        .trim() || null
    );
  } catch {
    return null;
  }
}

/** A file name to suggest: the title, without what file systems refuse. */
export function suggestedFileName(title: string, kind: DocumentKind): string {
  const stem =
    title
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Document";
  return `${stem.slice(0, 80)}.${kind}`;
}

/** Hands the file to the browser's own download. */
export function saveFile(name: string, kind: DocumentKind, bytes: Uint8Array) {
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[kind] }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const FILE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(docx|xlsx|pptx)$/;

export interface FilePayload {
  file: string;
  title: string;
  kind: DocumentKind;
  detail?: string;
}

/** `src/lib/file-block.ts::parseFilePayload`: the file named by its gallery
 * name only, and a kind that agrees with it. */
export function parseFilePayload(payload: Record<string, unknown>): FilePayload | null {
  const file = typeof payload.file === "string" ? payload.file.trim() : "";
  const match = FILE_NAME.exec(file);
  if (!match) return null;
  const kind = match[1] as DocumentKind;
  if (payload.kind !== undefined && payload.kind !== kind) return null;
  const capped = (value: unknown, max: number) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (!trimmed) return undefined;
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  };
  const detail = capped(payload.detail, 60);
  return { file, title: capped(payload.title, 120) ?? file, kind, ...(detail ? { detail } : {}) };
}
