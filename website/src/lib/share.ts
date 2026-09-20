import { ApiError, boundedJson } from "./api";
import { decode, decrypt } from "./vault";

/**
 * Reading a share. There is no session here, and there cannot be one: the link
 * is the whole credential, and the key that opens the bytes lives in the URL
 * fragment, which a browser never sends. The service answers with ciphertext it
 * cannot read, to anybody who asks for it by identifier.
 *
 * `credentials: "omit"` is not a detail. The owner of a share may well be
 * signed in on this origin, and a share read must behave identically whether
 * they are or not — otherwise "open it in a private window" would stop being a
 * way to check what a recipient actually sees.
 */
export interface SharePreview {
  v: number;
  blobs: number;
  bytes: number;
  expires_at: string;
}
export interface SharedDocument {
  v: number;
  kind: string;
  title: string;
  body: string;
  shared_at: string;
}

const MAX_PIECE_BYTES = 8 * 1024 * 1024;

/** The identifier in the path and the key in the fragment, or nothing. */
export function readShareLink(pathname: string, hash: string) {
  const id = /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    pathname,
  )?.[1];
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("k") ?? "";
  if (!id || !raw) return null;
  let key: Uint8Array<ArrayBuffer>;
  try {
    key = decode(raw);
  } catch {
    return null;
  }
  if (key.byteLength !== 32) {
    key.fill(0);
    return null;
  }
  return { id: id.toLowerCase(), key };
}

async function publicFetch(path: string, signal?: AbortSignal) {
  const response = await fetch(path, {
    credentials: "omit",
    redirect: "error",
    headers: { Accept: "*/*" },
    signal: signal ?? AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new ApiError(
      response.status === 404 ? "not_found" : "unavailable",
      "This link is no longer available.",
      response.status,
    );
  return response;
}

export async function sharePreview(id: string, signal?: AbortSignal): Promise<SharePreview> {
  const response = await publicFetch(`/api/v1/shares/${id}/preview`, signal);
  const value = (await boundedJson(response)) as { data?: SharePreview } | null;
  const data = value?.data;
  if (
    data?.v !== 1 ||
    !Number.isSafeInteger(data.blobs) ||
    data.blobs < 1 ||
    data.blobs > 2049 ||
    typeof data.expires_at !== "string"
  )
    throw new ApiError("invalid_response", "This link could not be read.", 502);
  return data;
}

/** One sealed piece, authenticated against the share and the position it was
 * asked for: a service that served piece 3 in answer to a request for piece 1
 * would fail to decrypt rather than quietly reorder a file. */
export async function sharePiece(
  id: string,
  position: number,
  key: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await publicFetch(`/api/v1/shares/${id}/blobs/${position}`, signal);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PIECE_BYTES)
    throw new ApiError("response_too_large", "This link could not be read.", 413);
  return decrypt(key, new TextDecoder().decode(bytes), `subrosa:share:v1:${id}:${position}`);
}

export async function readShare(
  id: string,
  key: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<{ preview: SharePreview; document: SharedDocument }> {
  const preview = await sharePreview(id, signal);
  const document = (await sharePiece(id, 0, key, signal)) as SharedDocument;
  if (
    document?.v !== 1 ||
    typeof document.title !== "string" ||
    typeof document.body !== "string" ||
    document.kind !== "note"
  )
    throw new ApiError("invalid_response", "This link could not be read.", 502);
  return { preview, document };
}
