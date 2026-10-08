/**
 * The account's gallery, from the browser: a picture made here is filed the
 * way the app files one (ADR-0088, "a picture made in a chat is a gallery
 * file"), and the gallery's pictures can be read back for the Library.
 *
 * The file protocol is the app's (`account/files.rs`): the bytes in 1 MiB
 * chunks, each sealed with the vault key under
 * `subrosa:blob:v1:{account}:{blob}` and uploaded as an opaque blob; then an
 * `account_studio_files` record (the file) and an `account_file_manifests`
 * record (its chunks, each with its size and SHA-256), both ordinary
 * synchronised objects. The file record goes first: a device holds a manifest
 * back until it knows the file.
 */
import { ApiError } from "../lib/api";
import { decode, encode } from "../lib/vault";
import { timestamp } from "./codec";
import type { SyncClient } from "./sync";

type Key = Uint8Array<ArrayBuffer>;

export const CHUNK_BYTES = 1024 * 1024;
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const PICTURE_FORMATS = ["png", "jpg", "jpeg", "webp", "gif"];

export interface BlobTransport {
  put(id: string, sealed: string): Promise<void>;
  get(id: string): Promise<string>;
}

export function serviceBlobTransport(accountId: string): BlobTransport {
  const csrf = () =>
    document.cookie
      .split("; ")
      .find((cookie) => cookie.startsWith("subrosa_csrf="))
      ?.slice("subrosa_csrf=".length);
  return {
    async put(id, sealed) {
      const token = csrf();
      const response = await fetch(`/api/v1/blobs/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-subrosa-account-id": accountId,
          ...(token ? { "x-csrf-token": decodeURIComponent(token) } : {}),
        },
        body: new TextEncoder().encode(sealed),
        credentials: "same-origin",
        redirect: "error",
      });
      if (!response.ok)
        throw new ApiError(
          response.status === 413 ? "file_too_large" : "unavailable",
          "The file could not be stored.",
          response.status,
        );
    },
    async get(id) {
      const response = await fetch(`/api/v1/blobs/${id}`, {
        headers: { "x-subrosa-account-id": accountId },
        credentials: "same-origin",
        redirect: "error",
      });
      if (!response.ok)
        throw new ApiError("unavailable", "The file could not be read.", response.status);
      if (Number(response.headers.get("content-length")) > MAX_ENVELOPE_BYTES)
        throw new ApiError("response_too_large", "The file could not be read.", 413);
      const text = await response.text();
      if (text.length > MAX_ENVELOPE_BYTES)
        throw new ApiError("response_too_large", "The file could not be read.", 413);
      return text;
    },
  };
}

const blobContext = (accountId: string, blobId: string) => `subrosa:blob:v1:${accountId}:${blobId}`;

async function aesKey(key: Key) {
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `crypto::seal` over raw bytes: the envelope the app writes. */
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

export async function openBytes(key: Key, sealed: string, context: string): Promise<Uint8Array> {
  const envelope = JSON.parse(sealed) as { v?: number; nonce?: string; ciphertext?: string };
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

async function digest(bytes: Uint8Array): Promise<string> {
  return encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
  );
}

/** A data URL's bytes and the gallery format they are filed under. */
export function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; format: string } {
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error("Not a picture.");
  const format = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { bytes, format };
}

export interface GalleryPicture {
  id: string;
  format: string;
  bytes: number;
  model: string | null;
  prompt: string | null;
  createdAt: string;
}

/** Files a picture in the account's gallery and returns its id. */
export async function saveToGallery(
  sync: SyncClient,
  accountId: string,
  key: Key,
  picture: { dataUrl: string; model?: string | null; prompt?: string | null },
  transport: BlobTransport = serviceBlobTransport(accountId),
): Promise<string> {
  const { bytes, format } = dataUrlBytes(picture.dataUrl);
  const chunks: { id: string; bytes: number; sha256: string }[] = [];
  for (let at = 0; at < bytes.length || at === 0; at += CHUNK_BYTES) {
    const clear = bytes.subarray(at, at + CHUNK_BYTES);
    const id = crypto.randomUUID();
    await transport.put(id, await sealBytes(key, clear, blobContext(accountId, id)));
    chunks.push({ id, bytes: clear.byteLength, sha256: await digest(clear) });
    if (bytes.length === 0) break;
  }
  const fileId = crypto.randomUUID();
  const now = timestamp();
  await sync.write("account_studio_files", {
    id: fileId,
    file_name: `${fileId}.${format}`,
    format,
    bytes: bytes.length,
    created_at: now,
    model: picture.model ?? null,
    prompt: picture.prompt ? Array.from(picture.prompt).slice(0, 4000).join("") : null,
  });
  await sync.write("account_file_manifests", {
    id: crypto.randomUUID(),
    artifact_id: fileId,
    bytes: bytes.length,
    format,
    chunks_json: JSON.stringify(chunks),
    created_at: now,
    source_kind: "studio",
  });
  return fileId;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The gallery's pictures whose bytes this browser can fetch, newest first. */
export function listGalleryPictures(sync: SyncClient): GalleryPicture[] {
  const manifests = new Set(
    sync.rows("account_file_manifests").map((row) => text(row.row.artifact_id)),
  );
  return sync
    .rows("account_studio_files")
    .filter((row) => PICTURE_FORMATS.includes(text(row.row.format)) && manifests.has(row.id))
    .map((row) => ({
      id: row.id,
      format: text(row.row.format),
      bytes: Number(row.row.bytes ?? 0),
      model: text(row.row.model) || null,
      prompt: text(row.row.prompt) || null,
      createdAt: text(row.row.created_at),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A gallery picture's bytes, checked chunk by chunk, as a data URL. */
export async function loadPicture(
  sync: SyncClient,
  accountId: string,
  key: Key,
  fileId: string,
  transport: BlobTransport = serviceBlobTransport(accountId),
): Promise<string> {
  const manifest = sync
    .rows("account_file_manifests")
    .find((row) => row.row.artifact_id === fileId);
  if (!manifest) throw new Error("This picture has not arrived yet.");
  const chunks = JSON.parse(text(manifest.row.chunks_json)) as {
    id: string;
    bytes: number;
    sha256: string;
  }[];
  const total = Number(manifest.row.bytes ?? 0);
  if (!Array.isArray(chunks) || chunks.length > 64 || total > 64 * CHUNK_BYTES)
    throw new Error("This picture is too large to show here.");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const clear = await openBytes(
      key,
      await transport.get(chunk.id),
      blobContext(accountId, chunk.id),
    );
    if (clear.byteLength !== chunk.bytes || (await digest(clear)) !== chunk.sha256)
      throw new Error("This picture does not match its record.");
    if (offset + clear.byteLength > total)
      throw new Error("This picture does not match its record.");
    out.set(clear, offset);
    offset += clear.byteLength;
  }
  const format = text(manifest.row.format);
  const type = format === "jpg" || format === "jpeg" ? "image/jpeg" : `image/${format}`;
  let binary = "";
  for (let at = 0; at < out.length; at += 0x8000)
    binary += String.fromCharCode(...out.subarray(at, at + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}
