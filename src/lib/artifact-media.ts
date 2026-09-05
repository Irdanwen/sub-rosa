import { useCallback, useEffect, useMemo, useState } from "react";
import { isMobilePlatform } from "./mobile";
import { artifactSrc, listArtifacts, readArtifactBase64 } from "./studio/artifacts";
import { makeThumbnail } from "./studio/downscale";
import { extractFrameAt } from "./studio/frames";
import type { StudioArtifact } from "./studio/types";

/**
 * Media-URL loader for Studio artifacts on mobile. The asset custom protocol
 * (`convertFileSrc`) does not resolve inside the iOS webview, so bytes are read
 * through the existing IPC (`readArtifactBase64`). Images render as data URLs;
 * video and audio must be `blob:` object URLs instead, because WKWebView's
 * media loader byte-range-requests the source and `data:` URLs can't answer one
 * (the <video>/<audio> element just stays blank). A small cache keeps gallery
 * scrolling from re-reading files; the blob URLs in it are revoked when evicted.
 *
 * Grid tiles never hold a media element for a clip: WKWebView paints no first
 * frame without a `poster`, so a clip's tile is a still decoded here (see
 * `clipPoster`) and rendered as an `<img>`.
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
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "ogg":
    case "opus":
      return "audio/ogg";
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

/**
 * The artifact's bytes as a `data:` URI, on every platform.
 *
 * Deliberately not `artifactDataUrl`: that one hands back a blob: object URL
 * for video and audio, because that is what an iOS media element can seek. An
 * object URL is a handle into this process, so it is exactly the wrong thing to
 * put in a request body - this is the one to reach for when the bytes have to
 * travel. Uncached: the caller is about to send them, not to render them.
 */
export async function artifactDataUri(artifact: Pick<StudioArtifact, "path">): Promise<string> {
  const base64 = await readArtifactBase64(artifact);
  return `data:${mimeFor(artifact.path)};base64,${base64}`;
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
 * What a gallery tile paints, and what it has to paint it with.
 *
 * The distinction is not cosmetic: a `still` belongs in an `<img>`, and that is
 * the only thing that shows a clip on iOS. A `media` source is the file itself,
 * which the tile can only render with a `<video>` - the fallback for a clip
 * whose picture could not be read.
 */
export interface ArtifactThumbnail {
  src: string;
  kind: "still" | "media";
  /** The clip's length, learned while its poster was decoded. */
  durationSeconds?: number;
}

/**
 * Where a clip's poster frame is taken from, in seconds.
 *
 * Not zero: a generated clip often opens on a fade or a held frame, and a
 * decoder handed a fresh element is least likely to have a picture at the very
 * first position. A fifth of a second in is past both and is still the opening
 * shot the user asked for.
 */
const POSTER_TIME_SECONDS = 0.2;

/** Clip lengths learned while decoding a poster, so a tile can label a video
 * without a media element having to load the whole thing again. */
const clipLengths = new Map<string, number>();

/**
 * One clip decoded at a time.
 *
 * A grid mounts every tile at once, and a video poster costs the clip's whole
 * bytes over IPC plus a decoder to hold them. Ten of those in parallel is how a
 * phone runs out of memory mid-scroll; in series it is a few hundred
 * milliseconds each, once, and the answer is cached from then on.
 */
let posterTurn: Promise<unknown> = Promise.resolve();
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = posterTurn.then(task, task);
  posterTurn = run.catch(() => undefined);
  return run;
}

/**
 * A still decoded out of a clip, to stand in for it in the grid.
 *
 * iOS is why this exists at all. WKWebView never paints a `<video>`'s first
 * frame on its own - no `poster` attribute, no picture - so a clip tile stayed
 * an empty grey square however the element was coaxed (`preload="metadata"`, a
 * `#t=` media fragment: neither is honoured before playback). Decoding the
 * frame ourselves and handing over an `<img>` is the one thing that does not
 * depend on the media element's goodwill.
 */
async function clipPoster(artifact: Pick<StudioArtifact, "path">): Promise<string> {
  const base64 = await readArtifactBase64(artifact);
  // A throwaway object URL, not the cached one: `cache` evicts by revoking, and
  // reading a poster has no business invalidating the URL the lightbox may be
  // playing from. Revoked as soon as the frame is out.
  const url = URL.createObjectURL(base64ToBlob(base64, mimeFor(artifact.path)));
  try {
    const frame = await extractFrameAt(url, POSTER_TIME_SECONDS);
    if (frame.durationSeconds > 0) clipLengths.set(artifact.path, frame.durationSeconds);
    return makeThumbnail(frame.dataUrl);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function still(path: string, src: string): ArtifactThumbnail {
  return { src, kind: "still", durationSeconds: clipLengths.get(path) };
}

/** In-flight reads, so two tiles for the same file decode it once. Cheap for an
 * image, the difference between one clip read and two for a video. */
const pendingThumbnails = new Map<string, Promise<ArtifactThumbnail>>();

/**
 * A small thumbnail for a gallery grid tile. Full-resolution base64 images make
 * the iOS webview downsample them under memory pressure (blurry tiles), so grid
 * cells render this instead and keep the full image for the lightbox. Videos
 * resolve to a poster frame; audio, which has no picture, to the file itself.
 */
export function artifactThumbnail(
  artifact: Pick<StudioArtifact, "path" | "kind">,
): Promise<ArtifactThumbnail> {
  const cached = thumbCache.get(artifact.path);
  if (cached) return Promise.resolve(still(artifact.path, cached));
  const running = pendingThumbnails.get(artifact.path);
  if (running) return running;
  const read = loadThumbnail(artifact).finally(() => {
    pendingThumbnails.delete(artifact.path);
  });
  pendingThumbnails.set(artifact.path, read);
  return read;
}

async function loadThumbnail(
  artifact: Pick<StudioArtifact, "path" | "kind">,
): Promise<ArtifactThumbnail> {
  if (artifact.kind === "video") {
    try {
      const poster = await inTurn(() => clipPoster(artifact));
      remember(thumbCache, artifact.path, poster, THUMB_CACHE_MAX);
      return still(artifact.path, poster);
    } catch {
      // A clip that will not decode still has to be reachable and deletable:
      // fall through to the media itself, which is all the tile ever had.
    }
  }
  const full = await artifactDataUrl(artifact);
  if (artifact.kind !== "image") return { src: full, kind: "media" };
  const thumb = await makeThumbnail(full);
  remember(thumbCache, artifact.path, thumb, THUMB_CACHE_MAX);
  return still(artifact.path, thumb);
}

export function evictArtifactDataUrl(path: string) {
  releaseUrl(cache.get(path));
  cache.delete(path);
  releaseUrl(thumbCache.get(path));
  thumbCache.delete(path);
  clipLengths.delete(path);
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

/**
 * Every gallery item by id.
 *
 * The surfaces that only store an `artifactId` - a workflow's asset nodes, and
 * the connection lists that describe them - need the item behind it to show
 * anything at all. One listing serves the whole editor: a call per node would
 * be a gallery scan per node, and the answer is the same for all of them.
 *
 * `loaded` is what separates "not back yet" from "gone", which is the
 * difference between a quiet placeholder and telling the user their asset has
 * been deleted. `remember` files an item the user has just picked, so the
 * preview appears without waiting on a re-listing.
 */
export function useArtifactIndex(): {
  byId: Map<string, StudioArtifact>;
  loaded: boolean;
  remember: (artifact: StudioArtifact) => void;
} {
  const [byId, setById] = useState<Map<string, StudioArtifact>>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    listArtifacts()
      .then((entries) => {
        if (cancelled) return;
        // Merged rather than replaced: an item just picked must not vanish
        // because the listing that was already in flight predates it.
        setById((current) => {
          const next = new Map(entries.map((entry) => [entry.id, entry]));
          for (const [id, entry] of current) if (!next.has(id)) next.set(id, entry);
          return next;
        });
        setLoaded(true);
      })
      .catch(() => {
        // A gallery that cannot be listed leaves every asset unresolved, which
        // shows as no preview - never as "your asset is gone".
        if (!cancelled) setLoaded(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Not named `remember`: that is the cache's own evicting writer above, and
  // shadowing it inside a hook that also touches caches invites the wrong one.
  const rememberArtifact = useCallback((artifact: StudioArtifact) => {
    setById((current) => new Map(current).set(artifact.id, artifact));
  }, []);
  // One identity per actual change. A fresh object every render would be a
  // fresh dependency every render, and a caller that rebuilds its nodes when
  // the index changes would rebuild them forever.
  return useMemo(
    () => ({ byId, loaded, remember: rememberArtifact }),
    [byId, loaded, rememberArtifact],
  );
}

/**
 * A URL this shell can show a preview from, or null when there is none worth
 * paying for.
 *
 * The two platforms answer differently and must: on the desktop the asset
 * protocol streams the file, so an image or a clip previews for nothing. The
 * iOS webview has no asset protocol and reads bytes over IPC, so only images
 * are previewed (downscaled, and cached) - decoding a whole clip to preview it
 * in a form is exactly what the thumbnail cache exists to avoid.
 */
export function useArtifactPreview(
  artifact: Pick<StudioArtifact, "path" | "kind"> | null | undefined,
): string | null {
  const mobile = isMobilePlatform();
  const thumbnail = useArtifactThumbnail(mobile && artifact?.kind === "image" ? artifact : null);
  if (!artifact) return null;
  if (!mobile) return artifactSrc(artifact);
  return artifact.kind === "image" ? (thumbnail?.src ?? null) : null;
}

/** What already sits in the caches for this artifact, so a tile that has been
 * seen before paints on its first render instead of after a round trip. */
function cachedThumbnail(
  artifact: Pick<StudioArtifact, "path" | "kind">,
): ArtifactThumbnail | null {
  const thumb = thumbCache.get(artifact.path);
  if (thumb) return still(artifact.path, thumb);
  // Only for images: for a clip the cached entry is the media itself, and the
  // poster this is about to resolve is the thing worth waiting a beat for.
  const full = artifact.kind === "image" ? cache.get(artifact.path) : undefined;
  return full ? { src: full, kind: "still" } : null;
}

/** Like {@link useArtifactDataUrl} but resolves to a grid tile: a downscaled
 * still for images, a decoded poster frame for clips; null while loading or on
 * failure. */
export function useArtifactThumbnail(artifact: Pick<StudioArtifact, "path" | "kind"> | null) {
  const [thumbnail, setThumbnail] = useState<ArtifactThumbnail | null>(() =>
    artifact ? cachedThumbnail(artifact) : null,
  );
  useEffect(() => {
    if (!artifact) {
      setThumbnail(null);
      return;
    }
    let cancelled = false;
    artifactThumbnail(artifact)
      .then((value) => {
        if (!cancelled) setThumbnail(value);
      })
      .catch(() => {
        if (!cancelled) setThumbnail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact?.path, artifact?.kind]);
  return thumbnail;
}
