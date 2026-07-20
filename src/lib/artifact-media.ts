import { useEffect, useState } from "react";
import { readArtifactBase64 } from "./studio/artifacts";
import { makeThumbnail } from "./studio/downscale";
import type { StudioArtifact } from "./studio/types";

/**
 * Media-URL loader for Studio artifacts on mobile. The asset custom protocol
 * (`convertFileSrc`) does not resolve inside the iOS webview, so bytes are read
 * through the existing IPC (`readArtifactBase64`). Images render as data URLs;
 * video and audio must be `blob:` object URLs instead, because WKWebView's
 * media loader byte-range-requests the source and `data:` URLs can't answer one
 * (the <video>/<audio> element just stays blank). A small cache keeps gallery
 * scrolling from re-reading files; the blob URLs in it are revoked when evicted.
 */
const cache = new Map<string, string>();
const thumbCache = new Map<string, string>();
// Thumbnails are small (downsized JPEGs), so keep enough to cover a whole
// gallery (the on-disk index caps at 200) and avoid re-decoding on scroll.
// Full-resolution data URLs (opened images, whole videos/tracks) are heavy, so
// hold only a handful.
const THUMB_CACHE_MAX = 200;
const FULL_CACHE_MAX = 24;

/** A dropped `blob:` URL leaks its bytes for the document's lifetime unless
 * revoked; `data:` URLs need no cleanup, so guard on the scheme. */
function releaseUrl(url: string | undefined) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

function remember(store: Map<string, string>, key: string, value: string, max: number) {
  if (store.size >= max) {
    const oldest = store.keys().next().value;
    if (oldest) {
      releaseUrl(store.get(oldest));
      store.delete(oldest);
    }
  }
  const prev = store.get(key);
  if (prev && prev !== value) releaseUrl(prev);
  store.set(key, value);
}

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}

/** iOS WKWebView can't load <video>/<audio> from a data: URL — its media
 * loader issues byte-range requests that a data: URL can't answer, so the
 * element stays blank. Those bytes need a blob: object URL, which does support
 * ranges. Images have no such requirement and stay data URLs (they also feed
 * the canvas thumbnail + edit-reference paths, which expect a data URL). */
function needsBlobUrl(mime: string): boolean {
  return mime.startsWith("video/") || mime.startsWith("audio/");
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function artifactDataUrl(artifact: Pick<StudioArtifact, "path">): Promise<string> {
  const cached = cache.get(artifact.path);
  if (cached) return cached;
  const base64 = await readArtifactBase64(artifact);
  const mime = mimeFor(artifact.path);
  const url = needsBlobUrl(mime)
    ? URL.createObjectURL(base64ToBlob(base64, mime))
    : `data:${mime};base64,${base64}`;
  remember(cache, artifact.path, url, FULL_CACHE_MAX);
  return url;
}

/**
 * A small thumbnail data URL for gallery grid tiles. Full-resolution base64
 * images make the iOS webview downsample them under memory pressure (blurry
 * tiles), so grid cells render this instead and keep the full image for the
 * lightbox. Non-image artifacts fall back to the full data URL.
 */
export async function artifactThumbnail(
  artifact: Pick<StudioArtifact, "path" | "kind">,
): Promise<string> {
  const cached = thumbCache.get(artifact.path);
  if (cached) return cached;
  const full = await artifactDataUrl(artifact);
  if (artifact.kind !== "image") return full;
  const thumb = await makeThumbnail(full);
  remember(thumbCache, artifact.path, thumb, THUMB_CACHE_MAX);
  return thumb;
}

export function evictArtifactDataUrl(path: string) {
  releaseUrl(cache.get(path));
  cache.delete(path);
  releaseUrl(thumbCache.get(path));
  thumbCache.delete(path);
}

/** Resolve an artifact to a data URL; null while loading or on failure. */
export function useArtifactDataUrl(artifact: Pick<StudioArtifact, "path"> | null) {
  const [url, setUrl] = useState<string | null>(() =>
    artifact ? (cache.get(artifact.path) ?? null) : null,
  );
  useEffect(() => {
    if (!artifact) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    artifactDataUrl(artifact)
      .then((value) => {
        if (!cancelled) setUrl(value);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact?.path]);
  return url;
}

/** Like {@link useArtifactDataUrl} but resolves to a downscaled thumbnail for
 * images (grid tiles); null while loading or on failure. */
export function useArtifactThumbnail(artifact: Pick<StudioArtifact, "path" | "kind"> | null) {
  const [url, setUrl] = useState<string | null>(() =>
    artifact ? (thumbCache.get(artifact.path) ?? cache.get(artifact.path) ?? null) : null,
  );
  useEffect(() => {
    if (!artifact) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    artifactThumbnail(artifact)
      .then((value) => {
        if (!cancelled) setUrl(value);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact?.path, artifact?.kind]);
  return url;
}
