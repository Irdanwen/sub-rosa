/**
 * A document filed in the account's gallery from the browser, on the Studio
 * lane exactly as the app files one (ADR-0090 addendum, `account/files.rs`,
 * `account/studio.rs`): the bytes in 1 MiB chunks, each sealed with the vault
 * key under `subrosa:blob:v1:{account}:{blob}` and uploaded as an opaque blob
 * (`PUT /api/v1/blobs/{id}`); then the `account_studio_files` record (the
 * file, named `<uuid>.<ext>`) and the `account_file_manifests` record (its
 * chunks, each with its size and SHA-256), both ordinary synchronised
 * objects. The record goes first: a device holds a manifest back until it
 * knows its file. Another device puts the file back in its documents folder
 * by its extension alone.
 *
 * Two functions, `fileDocument` and `readDocument`, so the merge with the
 * gallery module of the pictures (WP20a, the same protocol) keeps one
 * implementation behind them.
 */
import { ApiError } from "../../lib/api";
import { decode, encode } from "../../lib/vault";
import { timestamp } from "../codec";
import type { SyncClient } from "../sync";

type Key = Uint8Array<ArrayBuffer>;

/** `files.rs::CHUNK_BYTES`. */
export const CHUNK_BYTES = 1024 * 1024;
/** What the app accepts for one envelope when it reads a blob. */
const MAX_ENVELOPE_BYTES = 2 * CHUNK_BYTES;
/** `files.rs::manifest_chunks`: at most this many chunks. */
const MAX_CHUNKS = 2048;
export const DOCUMENT_FORMATS = ["docx", "xlsx", "pptx"] as const;

export interface BlobTransport {
  put(id: string, sealed: string): Promise<void>;
  get(id: string): Promise<string>;
}

/** The account service's blob routes, with the page's session (the same
 * headers as `api()`: the account the tab writes to, and the CSRF token). */
export function serviceBlobTransport(accountId: string): BlobTransport {
  const headers = () => {
    const csrf = document.cookie
      .split("; ")
      .find((cookie) => cookie.startsWith("subrosa_csrf="))
      ?.slice("subrosa_csrf=".length);
    return {
      Accept: "application/json",
      "x-subrosa-account-id": accountId,
      ...(csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}),
    };
  };
  return {
    async put(id, sealed) {
      const response = await fetch(`/api/v1/blobs/${id}`, {
        method: "PUT",
        headers: { ...headers(), "Content-Type": "application/octet-stream" },
        body: new TextEncoder().encode(sealed),
        credentials: "same-origin",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new ApiError(
          response.status === 413 ? "file_too_large" : "sync_blob_request_failed",
          "The file could not be stored.",
          response.status,
        );
    },
    async get(id) {
      const response = await fetch(`/api/v1/blobs/${id}`, {
        headers: headers(),
        credentials: "same-origin",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new ApiError(
          response.status === 404 ? "sync_blob_missing" : "sync_blob_request_failed",
          "The file could not be read.",
          response.status,
        );
      if (Number(response.headers.get("content-length")) > MAX_ENVELOPE_BYTES)
        throw new ApiError("sync_blob_invalid", "The file could not be read.", 413);
      const text = await response.text();
      if (text.length > MAX_ENVELOPE_BYTES)
        throw new ApiError("sync_blob_invalid", "The file could not be read.", 413);
      return text;
    },
  };
}

const blobContext = (accountId: string, blobId: string) => `subrosa:blob:v1:${accountId}:${blobId}`;

const aesKey = (key: Key) =>
  crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);

/** `crypto::seal` over raw bytes: `{"v":1,"nonce","ciphertext"}`. */
export async function sealBytes(key: Key, bytes: Uint8Array, context: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(context),
      tagLength: 128,
    },
    await aesKey(key),
    bytes as Uint8Array<ArrayBuffer>,
  );
  return JSON.stringify({
    v: 1,
    nonce: encode(nonce),
    ciphertext: encode(new Uint8Array(ciphertext)),
  });
}

/** `crypto::open`. */
export async function openBytes(key: Key, sealed: string, context: string): Promise<Uint8Array> {
  const envelope = JSON.parse(sealed) as { v?: unknown; nonce?: unknown; ciphertext?: unknown };
  if (
    envelope.v !== 1 ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string"
  )
    throw new Error("Invalid encrypted envelope");
  const nonce = decode(envelope.nonce);
  if (nonce.length !== 12) throw new Error("Invalid nonce");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(context),
        tagLength: 128,
      },
      await aesKey(key),
      decode(envelope.ciphertext),
    ),
  );
}

/** base64url SHA-256, as `files.rs::digest`. */
async function digest(bytes: Uint8Array): Promise<string> {
  return encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
  );
}

export interface GalleryContext {
  sync: SyncClient;
  accountId: string;
  key: Key;
  transport?: BlobTransport;
}

/** Files `bytes` as the gallery document `name` (`<uuid>.<docx|xlsx|pptx>`).
 * Every chunk is stored before either record is written, so no device ever
 * reads a manifest whose blobs are missing. */
export async function fileDocument(
  context: GalleryContext,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const match = /^([0-9a-f-]{36})\.(docx|xlsx|pptx)$/.exec(name);
  if (!match) throw new Error("Not a document name.");
  if (!bytes.length) throw new Error("An empty file is not filed.");
  const [, fileId, format] = match;
  const transport = context.transport ?? serviceBlobTransport(context.accountId);
  const chunks: { id: string; bytes: number; sha256: string }[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    const clear = bytes.subarray(at, at + CHUNK_BYTES);
    const id = crypto.randomUUID();
    await transport.put(
      id,
      await sealBytes(context.key, clear, blobContext(context.accountId, id)),
    );
    chunks.push({ id, bytes: clear.byteLength, sha256: await digest(clear) });
  }
  const now = timestamp();
  await context.sync.write("account_studio_files", {
    id: fileId,
    file_name: name,
    format,
    bytes: bytes.length,
    created_at: now,
    model: null,
    prompt: null,
  });
  await context.sync.write("account_file_manifests", {
    id: crypto.randomUUID(),
    artifact_id: fileId,
    bytes: bytes.length,
    format,
    chunks_json: JSON.stringify(chunks),
    created_at: now,
    source_kind: "studio",
  });
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

export interface GalleryDocument {
  /** The file's id, the stem of its name. */
  id: string;
  name: string;
  format: (typeof DOCUMENT_FORMATS)[number];
  bytes: number;
  createdAt: string;
  /** Its manifest arrived: the bytes can be read. */
  readable: boolean;
}

/** The gallery's documents, newest first. */
export function listDocuments(sync: SyncClient): GalleryDocument[] {
  const manifests = new Set(
    sync
      .rows("account_file_manifests")
      .filter((row) => row.row.source_kind === "studio")
      .map((row) => text(row.row.artifact_id)),
  );
  return sync
    .rows("account_studio_files")
    .filter((row) => (DOCUMENT_FORMATS as readonly string[]).includes(text(row.row.format)))
    .map((row) => ({
      id: row.id,
      name: text(row.row.file_name) || `${row.id}.${text(row.row.format)}`,
      format: text(row.row.format) as GalleryDocument["format"],
      bytes: Number(row.row.bytes ?? 0),
      createdAt: text(row.row.created_at),
      readable: manifests.has(row.id),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A gallery document's bytes, every chunk checked against its manifest
 * (`files.rs::manifest_chunks` and `download_one`). */
export async function readDocument(context: GalleryContext, fileId: string): Promise<Uint8Array> {
  const manifest = context.sync
    .rows("account_file_manifests")
    .find((row) => row.row.artifact_id === fileId && row.row.source_kind === "studio");
  if (!manifest) throw new Error("This file has not arrived yet.");
  const total = Number(manifest.row.bytes ?? 0);
  let chunks: { id?: unknown; bytes?: unknown; sha256?: unknown }[];
  try {
    chunks = JSON.parse(text(manifest.row.chunks_json));
  } catch {
    throw new Error("This file's record is damaged.");
  }
  const ids = new Set<string>();
  let sum = 0;
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > MAX_CHUNKS || !(total > 0))
    throw new Error("This file's record is damaged.");
  for (const chunk of chunks) {
    if (
      typeof chunk.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(chunk.id) ||
      ids.has(chunk.id) ||
      typeof chunk.bytes !== "number" ||
      chunk.bytes <= 0 ||
      chunk.bytes > CHUNK_BYTES ||
      typeof chunk.sha256 !== "string" ||
      chunk.sha256.length !== 43
    )
      throw new Error("This file's record is damaged.");
    ids.add(chunk.id);
    sum += chunk.bytes;
  }
  if (sum !== total) throw new Error("This file's record is damaged.");
  const transport = context.transport ?? serviceBlobTransport(context.accountId);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks as { id: string; bytes: number; sha256: string }[]) {
    const clear = await openBytes(
      context.key,
      await transport.get(chunk.id),
      blobContext(context.accountId, chunk.id),
    );
    if (clear.byteLength !== chunk.bytes || (await digest(clear)) !== chunk.sha256)
      throw new Error("This file does not match its record.");
    out.set(clear, offset);
    offset += clear.byteLength;
  }
  return out;
}
