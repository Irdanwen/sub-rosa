import { useEffect, useState } from "react";
import { readArtifactBase64 } from "./studio/artifacts";
import { makeThumbnail } from "./studio/downscale";
import type { StudioArtifact } from "./studio/types";

/**
 * Data-URL loader for Studio artifacts on mobile. The asset custom protocol
 * (`convertFileSrc`) does not resolve inside the iOS webview, so media is
 * read through the existing IPC (`readArtifactBase64`) and rendered as data
 * URLs. A small cache keeps gallery scrolling from re-reading files.
 */
const cache = new Map<string, string>();
const thumbCache = new Map<string, string>();
const CACHE_MAX_ENTRIES = 60;

function remember(store: Map<string, string>, key: string, value: string) {
  if (store.size >= CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
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

export async function artifactDataUrl(artifact: Pick<StudioArtifact, "path">): Promise<string> {
  const cached = cache.get(artifact.path);
  if (cached) return cached;
  const base64 = await readArtifactBase64(artifact);
  const url = `data:${mimeFor(artifact.path)};base64,${base64}`;
  remember(cache, artifact.path, url);
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
  remember(thumbCache, artifact.path, thumb);
  return thumb;
}

export function evictArtifactDataUrl(path: string) {
  cache.delete(path);
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
