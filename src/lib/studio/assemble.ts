// Clip assembly: play trimmed gallery clips onto a canvas in order, mix their
// audio (plus an optional background track) through one AudioContext, and
// record the whole thing with MediaRecorder. Real-time by design - no ffmpeg
// to bundle, notarize, or license; the webview's own codecs do the work. The
// cost is that an export takes as long as the film runs.

export interface AssembleClip {
  /** Where the clip's bytes live (an `artifactSrc` URL). */
  src: string;
  /** Trim in/out, in seconds from the clip's start. `out` clamps to the end. */
  inSeconds: number;
  outSeconds?: number;
}

export interface AssembleOptions {
  clips: AssembleClip[];
  /** Optional background track (music, narration...) under the whole film. */
  audioSrc?: string;
  /** Background track volume, 0..1 (clip audio always passes at full). */
  audioVolume?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  /** 0..1, called as the export advances through the timeline. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface AssembleResult {
  blob: Blob;
  /** File extension matching the recorder's container ("mp4" or "webm"). */
  extension: string;
}

/** The recorder container the current webview supports, most portable first.
 * Safari (and the WKWebView shells) records mp4; Chromium records webm. */
export function pickRecorderMime(
  isSupported: (mime: string) => boolean = (mime) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime),
): { mimeType: string; extension: string } | undefined {
  const candidates: Array<{ mimeType: string; extension: string }> = [
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
  ];
  return candidates.find((candidate) => isSupported(candidate.mimeType));
}

/** Effective play window of a clip once trims and duration are known. */
export function clipWindow(
  clip: Pick<AssembleClip, "inSeconds" | "outSeconds">,
  durationSeconds: number,
): { start: number; end: number } {
  const start = Math.max(0, Math.min(clip.inSeconds, durationSeconds));
  const rawEnd = clip.outSeconds ?? durationSeconds;
  const end = Math.max(start, Math.min(rawEnd, durationSeconds));
  return { start, end };
}

/** Total run time of a cut list (known durations only). */
export function timelineSeconds(
  clips: Array<Pick<AssembleClip, "inSeconds" | "outSeconds"> & { durationSeconds: number }>,
): number {
  return clips.reduce((sum, clip) => {
    const { start, end } = clipWindow(clip, clip.durationSeconds);
    return sum + (end - start);
  }, 0);
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = false;
    video.playsInline = true;
    video.src = src;
    video.addEventListener("loadedmetadata", () => resolve(video), { once: true });
    video.addEventListener("error", () => reject(new Error("A clip failed to load.")), {
      once: true,
    });
  });
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.01) {
      resolve();
      return;
    }
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = time;
  });
}

/**
 * Render the cut list to a single file. Loads every clip up front (so a bad
 * clip fails fast, before recording starts), then records the canvas +
 * mixed audio in real time.
 */
export async function assembleClips(options: AssembleOptions): Promise<AssembleResult> {
  if (options.clips.length === 0) throw new Error("Add at least one clip.");
  const mime = pickRecorderMime();
  if (!mime) throw new Error("This system cannot record video.");

  const videos = await Promise.all(options.clips.map((clip) => loadVideo(clip.src)));
  const width = options.width ?? Math.max(videos[0].videoWidth, 2);
  const height = options.height ?? Math.max(videos[0].videoHeight, 2);
  const frameRate = options.frameRate ?? 30;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This system cannot compose video frames.");

  // One AudioContext mixes every clip's sound plus the background track into
  // the recording; the graph never touches the speakers.
  const audioContext = new AudioContext();
  const mixOut = audioContext.createMediaStreamDestination();
  for (const video of videos) {
    audioContext.createMediaElementSource(video).connect(mixOut);
  }
  let backgroundAudio: HTMLAudioElement | undefined;
  if (options.audioSrc) {
    backgroundAudio = new Audio(options.audioSrc);
    backgroundAudio.crossOrigin = "anonymous";
    const gain = audioContext.createGain();
    gain.gain.value = options.audioVolume ?? 0.6;
    audioContext.createMediaElementSource(backgroundAudio).connect(gain).connect(mixOut);
  }

  const stream = canvas.captureStream(frameRate);
  for (const track of mixOut.stream.getAudioTracks()) stream.addTrack(track);

  const recorder = new MediaRecorder(stream, { mimeType: mime.mimeType });
  const chunks: BlobPart[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const recorded = new Promise<Blob>((resolve) => {
    recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: mime.mimeType })), {
      once: true,
    });
  });

  const windows = videos.map((video, index) => clipWindow(options.clips[index], video.duration));
  const totalSeconds = windows.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  if (totalSeconds <= 0) throw new Error("The cut list is empty after trimming.");

  // Fire and forget: a suspended context only silences the mix, it must not
  // hang the export (resume() can stay pending under strict autoplay rules).
  void audioContext.resume().catch(() => undefined);
  recorder.start(500);
  void backgroundAudio?.play().catch(() => undefined);

  try {
    let playedSeconds = 0;
    for (let index = 0; index < videos.length; index += 1) {
      if (options.signal?.aborted) {
        throw new DOMException("The export was cancelled.", "AbortError");
      }
      const video = videos[index];
      const cut = windows[index];
      if (cut.end - cut.start <= 0) continue;
      await seek(video, cut.start);
      await video.play();
      await new Promise<void>((resolve, reject) => {
        let raf = 0;
        const onAbort = () => {
          cancelAnimationFrame(raf);
          video.pause();
          reject(new DOMException("The export was cancelled.", "AbortError"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const draw = () => {
          context.drawImage(video, 0, 0, width, height);
          const clipPlayed = Math.max(0, video.currentTime - cut.start);
          options.onProgress?.(Math.min(1, (playedSeconds + clipPlayed) / totalSeconds));
          if (video.ended || video.currentTime >= cut.end) {
            video.pause();
            options.signal?.removeEventListener("abort", onAbort);
            resolve();
            return;
          }
          raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);
      });
      playedSeconds += cut.end - cut.start;
    }
  } finally {
    recorder.stop();
    backgroundAudio?.pause();
    for (const video of videos) video.pause();
    void audioContext.close().catch(() => undefined);
  }

  const blob = await recorded;
  options.onProgress?.(1);
  return { blob, extension: mime.extension };
}

/** Blob → base64 payload for the artifact save command. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}
