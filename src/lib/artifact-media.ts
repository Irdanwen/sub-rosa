import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isMobilePlatform } from "./mobile";
import { artifactSrc, listArtifacts, readArtifactBase64 } from "./studio/artifacts";
import { makeThumbnail, posterJpeg } from "./studio/downscale";
import { extractFrameAt, mediaDuration } from "./studio/frames";
import type { StudioArtifact } from "./studio/types";

/**
 * Media-URL loader for Studio artifacts on mobile. Playback streams from the
 * `subrosa-media:` scheme ({@link usePlayableMediaUrl}), which answers the byte
 * ranges WKWebView's media loader asks for. Bytes that have to become pixels
 * here (thumbnails, posters, edit references) are still read through IPC
 * (`readArtifactBase64`): images as data URLs, video and audio as `blob:`
 * object URLs, because a `data:` URL cannot answer a range request (the
 * <video>/<audio> element just stays blank). A small cache keeps gallery
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

/**
 * Paths whose full URL something is playing from right now.
 *
 * The full cache evicts by revoking, and a gallery keeps filling it while the
 * viewer is open. Revoking the `blob:` a `<video>` is reading from does not
 * stop it at once: it plays what it buffered, then its next range request
 * fails and the clip freezes a few seconds in. A pinned entry is skipped by
 * eviction until the last player lets go of it.
 */
const pinned = new Map<string, number>();

function remember(store: Map<string, string>, key: string, value: string, max: number) {
  if (store.size >= max) {
    let oldest: string | undefined;
    for (const candidate of store.keys()) {
      if (store !== cache || !pinned.has(candidate)) {
        oldest = candidate;
        break;
      }
    }
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

/** What a tile needs to know about an item to paint it. */
type TileSubject = Pick<StudioArtifact, "path" | "kind"> &
  Partial<Pick<StudioArtifact, "posterVersion" | "durationMs">>;

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

/** The still filed for an item, on the media scheme: painted straight from
 * disk, with nothing decoded in this process. */
export function artifactPosterUrl(
  artifact: Pick<StudioArtifact, "path" | "posterVersion">,
): string {
  const name = encodeURIComponent(fileNameOf(artifact.path));
  return `${mediaSchemeBase()}poster/${name}?v=${artifact.posterVersion ?? 1}`;
}

/**
 * Files a poster and what was measured making it, so the item is never
 * decoded for its tile again. Best-effort: a failure costs a decode on the
 * next launch, nothing more.
 */
function filePoster(
  artifact: Pick<StudioArtifact, "path">,
  poster: { dataUrl: string; width: number; height: number },
  durationMs?: number,
): void {
  const id = fileNameOf(artifact.path);
  void invoke("carpe_diem_media_save_poster", {
    request: { id, base64: poster.dataUrl.replace(/^data:[^,]+,/, "") },
  })
    .then(() =>
      invoke("studio_artifact_measure", {
        id,
        measures: {
          posterVersion: 1,
          width: poster.width,
          height: poster.height,
          ...(durationMs ? { durationMs } : {}),
        },
      }),
    )
    .catch(() => undefined);
}

/** A frame out of a clip: streamed first, which reads only the bytes that
 * frame needs, else from the whole file over IPC. */
async function clipFrame(artifact: Pick<StudioArtifact, "path">) {
  try {
    return await extractFrameAt(artifactStreamUrl(artifact), POSTER_TIME_SECONDS);
  } catch {
    const base64 = await readArtifactBase64(artifact);
    // A throwaway object URL, not the cached one: `cache` evicts by revoking,
    // and reading a poster has no business invalidating the URL the lightbox
    // may be playing from. Revoked as soon as the frame is out.
    const url = URL.createObjectURL(base64ToBlob(base64, mimeFor(artifact.path)));
    try {
      return await extractFrameAt(url, POSTER_TIME_SECONDS);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * A still decoded out of a clip, to stand in for it in the grid.
 *
 * iOS is why this exists at all. WKWebView never paints a `<video>`'s first
 * frame on its own - no `poster` attribute, no picture - so a clip tile stayed
 * an empty grey square however the element was coaxed (`preload="metadata"`, a
 * `#t=` media fragment: neither is honoured before playback). Decoding the
 * frame ourselves and handing over an `<img>` is the one thing that does not
 * depend on the media element's goodwill. Done once per clip: the still is
 * filed on disk with the clip's length and size.
 */
async function clipPoster(artifact: Pick<StudioArtifact, "path">): Promise<string> {
  // WebKit paints a clip's opening frame inside an <img> straight off the
  // stream, in a fraction of a second, where a detached <video> on iOS loads
  // its metadata and then never decodes a picture at all (measured: 0.2 s
  // against a 15 s timeout). Elsewhere the image fails fast and the frame is
  // read the long way.
  const stream = artifactStreamUrl(artifact);
  try {
    const poster = await posterJpeg(stream);
    const seconds = await mediaDuration(stream);
    if (seconds > 0) clipLengths.set(artifact.path, seconds);
    filePoster(artifact, poster, seconds > 0 ? Math.round(seconds * 1000) : undefined);
    return poster.dataUrl;
  } catch {
    // Not a WebKit shell, or a clip it cannot paint: decode a frame instead.
  }
  const frame = await clipFrame(artifact);
  if (frame.durationSeconds > 0) clipLengths.set(artifact.path, frame.durationSeconds);
  const poster = await posterJpeg(frame.dataUrl);
  filePoster(
    artifact,
    { ...poster, width: frame.width || poster.width, height: frame.height || poster.height },
    frame.durationSeconds > 0 ? Math.round(frame.durationSeconds * 1000) : undefined,
  );
  return poster.dataUrl;
}

function still(artifact: TileSubject, src: string): ArtifactThumbnail {
  const known = artifact.durationMs ? artifact.durationMs / 1000 : undefined;
  return { src, kind: "still", durationSeconds: known ?? clipLengths.get(artifact.path) };
}

/** The filed poster, when there is one: nothing to decode, nothing to wait for. */
function filedThumbnail(artifact: TileSubject): ArtifactThumbnail | null {
  if (!artifact.posterVersion || (artifact.kind !== "image" && artifact.kind !== "video")) {
    return null;
  }
  return still(artifact, artifactPosterUrl(artifact));
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
export function artifactThumbnail(artifact: TileSubject): Promise<ArtifactThumbnail> {
  const filed = filedThumbnail(artifact);
  if (filed) return Promise.resolve(filed);
  const cached = thumbCache.get(artifact.path);
  if (cached) return Promise.resolve(still(artifact, cached));
  const running = pendingThumbnails.get(artifact.path);
  if (running) return running;
  const read = loadThumbnail(artifact).finally(() => {
    pendingThumbnails.delete(artifact.path);
  });
  pendingThumbnails.set(artifact.path, read);
  return read;
}

async function loadThumbnail(artifact: TileSubject): Promise<ArtifactThumbnail> {
  if (artifact.kind === "video") {
    try {
      const poster = await inTurn(() => clipPoster(artifact));
      remember(thumbCache, artifact.path, poster, THUMB_CACHE_MAX);
      return still(artifact, poster);
    } catch {
      // A clip that will not decode still has to be reachable and deletable:
      // fall through to the media itself, which is all the tile ever had.
    }
  }
  // A clip that would not decode, or a track: the tile gets the file itself,
  // streamed, rather than a whole copy of it held in this process.
  if (artifact.kind !== "image") return { src: artifactStreamUrl(artifact), kind: "media" };
  // A picture's poster comes off the streamed file, so the full image never
  // crosses into this process as base64 just to be shrunk.
  try {
    const poster = await posterJpeg(artifactStreamUrl(artifact));
    filePoster(artifact, poster);
    remember(thumbCache, artifact.path, poster.dataUrl, THUMB_CACHE_MAX);
    return still(artifact, poster.dataUrl);
  } catch {
    // Outside the app's own scheme (an older shell, a test), shrink the copy.
  }
  const full = await artifactDataUrl(artifact);
  const thumb = await makeThumbnail(full);
  remember(thumbCache, artifact.path, thumb, THUMB_CACHE_MAX);
  return still(artifact, thumb);
}

/** The scheme `src-tauri/src/carpe_diem/media_protocol.rs` serves the gallery on. */
export const MEDIA_SCHEME = "subrosa-media";

/**
 * A URL a media element streams a gallery file from, by byte range, straight
 * off the disk: nothing read into the webview first, nothing to revoke.
 *
 * The scheme takes a file name, never a path, which is also why it survives
 * an iOS reinstall moving the app's container.
 */
export function artifactStreamUrl(artifact: Pick<StudioArtifact, "path">): string {
  return `${mediaSchemeBase()}${encodeURIComponent(fileNameOf(artifact.path))}`;
}

/**
 * `subrosa-media://localhost/`, or the `http://subrosa-media.localhost/` form
 * where the platform's webview needs it. Tauri knows which; outside a shell
 * (tests, the browser labs) the custom-scheme form stands in.
 */
function mediaSchemeBase(): string {
  const internals = (window as { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } })
    .__TAURI_INTERNALS__;
  return internals?.convertFileSrc
    ? convertFileSrc("", MEDIA_SCHEME)
    : `${MEDIA_SCHEME}://localhost/`;
}

/** Holds a full URL out of eviction for as long as a player needs it. */
function pin(path: string): () => void {
  pinned.set(path, (pinned.get(path) ?? 0) + 1);
  return () => {
    const left = (pinned.get(path) ?? 1) - 1;
    if (left > 0) pinned.set(path, left);
    else pinned.delete(path);
  };
}

/**
 * What a `<video>` or `<audio>` plays a gallery file from.
 *
 * On the desktop that is the asset protocol, as before. In the phone shells it
 * is the streamed scheme, and when an element reports that it could not load
 * it (`onError`), the bytes are read over IPC once into a pinned `blob:` that
 * no amount of gallery scrolling can revoke while it plays.
 */
export function usePlayableMediaUrl(artifact: Pick<StudioArtifact, "path"> | null): {
  src: string | null;
  onError: () => void;
} {
  const mobile = isMobilePlatform();
  const path = artifact?.path ?? null;
  // Keyed by path, so opening another file starts from the stream again
  // without an effect to reset anything.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [fallback, setFallback] = useState<{ path: string; url: string } | null>(null);
  const failed = path !== null && failedPath === path;
  useEffect(() => {
    if (!path || !failed) return;
    const release = pin(path);
    let cancelled = false;
    artifactDataUrl({ path })
      .then((url) => {
        if (!cancelled) setFallback({ path, url });
      })
      .catch(() => {
        // Nothing left to try: the element keeps showing its own error.
      });
    return () => {
      cancelled = true;
      release();
    };
  }, [path, failed]);
  const onError = useCallback(() => {
    if (mobile && path) setFailedPath(path);
  }, [mobile, path]);
  if (!artifact) return { src: null, onError };
  if (!mobile) return { src: artifactSrc(artifact), onError };
  if (failed) return { src: fallback?.path === path ? fallback.url : null, onError };
  return { src: artifactStreamUrl(artifact), onError };
}

/** How many bars a track's silhouette is measured in. */
const TRACK_BARS = 48;

export interface TrackShape {
  durationMs: number;
  peaks: number[];
}

const trackShapes = new Map<string, TrackShape>();
const pendingShapes = new Map<string, Promise<TrackShape>>();
let shapeTurn: Promise<unknown> = Promise.resolve();

/** Measures a track once (decoded natively, one at a time) and files the
 * answer with it, so the gallery draws its shape from then on for free. */
function measureTrack(artifact: Pick<StudioArtifact, "path">): Promise<TrackShape> {
  const known = trackShapes.get(artifact.path);
  if (known) return Promise.resolve(known);
  const running = pendingShapes.get(artifact.path);
  if (running) return running;
  const id = fileNameOf(artifact.path);
  const task = () =>
    invoke<TrackShape>("carpe_diem_media_track_shape", { request: { id, bins: TRACK_BARS } });
  const run = shapeTurn.then(task, task);
  shapeTurn = run.catch(() => undefined);
  const read = run
    .then((shape) => {
      trackShapes.set(artifact.path, shape);
      void invoke("studio_artifact_measure", { id, measures: shape }).catch(() => undefined);
      return shape;
    })
    .finally(() => pendingShapes.delete(artifact.path));
  pendingShapes.set(artifact.path, read);
  return read;
}

/**
 * A track's length and silhouette: from what was filed with it when there
 * is one, else measured once. Null while measuring, or when the file cannot
 * be decoded (the tile then keeps its seeded silhouette).
 */
export function useTrackShape(
  artifact:
    | (Pick<StudioArtifact, "path"> & Partial<Pick<StudioArtifact, "peaks" | "durationMs">>)
    | null,
): TrackShape | null {
  const filed =
    artifact?.peaks && artifact.peaks.length > 0
      ? { peaks: artifact.peaks, durationMs: artifact.durationMs ?? 0 }
      : null;
  const [measured, setMeasured] = useState<TrackShape | null>(() =>
    artifact ? (trackShapes.get(artifact.path) ?? null) : null,
  );
  const path = filed ? null : (artifact?.path ?? null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    measureTrack({ path })
      .then((shape) => {
        if (!cancelled) setMeasured(shape);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);
  return filed ?? measured;
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
function cachedThumbnail(artifact: TileSubject): ArtifactThumbnail | null {
  const filed = filedThumbnail(artifact);
  if (filed) return filed;
  const thumb = thumbCache.get(artifact.path);
  if (thumb) return still(artifact, thumb);
  // Only for images: for a clip the cached entry is the media itself, and the
  // poster this is about to resolve is the thing worth waiting a beat for.
  const full = artifact.kind === "image" ? cache.get(artifact.path) : undefined;
  return full ? { src: full, kind: "still" } : null;
}

/** Like {@link useArtifactDataUrl} but resolves to a grid tile: a downscaled
 * still for images, a decoded poster frame for clips; null while loading or on
 * failure. */
export function useArtifactThumbnail(artifact: TileSubject | null) {
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
  }, [artifact?.path, artifact?.kind, artifact?.posterVersion]);
  return thumbnail;
}
