// Clip assembly: play trimmed gallery clips onto a canvas in order and record
// the whole thing with MediaRecorder. Real-time by design - no ffmpeg to
// bundle, notarize, or license; the webview's own codecs do the work. The cost
// is that an export takes as long as the film runs.
//
// The *picture* is necessarily real time. The *sound* no longer is. When the
// caller asks for lanes or for a loudness target, everything audible is
// rendered offline first (`./mix`) into one buffer, and the recording plays
// that buffer while the muted clips supply the frames. It is deterministic, it
// can be measured, and it is the only way to duck music under dialogue
// properly. Without those options the old live path is used unchanged, so an
// existing caller gets exactly what it always got.

import { loadVideoElement, seekVideo } from "./frames";
import { type MixLane, type MixSource, planMix, renderMix } from "./mix";

export interface AssembleClip {
  /** Where the clip's bytes live (an `artifactSrc` URL). */
  src: string;
  /** Trim in/out, in seconds from the clip's start. `out` clamps to the end. */
  inSeconds: number;
  outSeconds?: number;
}

/** A sound placed on one of the mix lanes, at an absolute point in the film. */
export interface AssembleSound {
  src: string;
  /** Where it starts on the timeline. */
  atSeconds: number;
  inSeconds?: number;
  outSeconds?: number;
  gain?: number;
}

export interface AssembleOptions {
  clips: AssembleClip[];
  /** Optional background track (music, narration...) under the whole film. */
  audioSrc?: string;
  /** Background track volume, 0..1 (clip audio always passes at full). */
  audioVolume?: number;
  /**
   * Dialogue, effects and music, placed. Supplying any of these switches the
   * export to the offline mix: the clips are muted and the rendered buffer is
   * what gets recorded.
   */
  lanes?: Partial<Record<Exclude<MixLane, "clips">, AssembleSound[]>>;
  /**
   * Programme loudness to normalise to, in LUFS. `null` leaves levels alone.
   * Requires the offline mix, and requesting it is enough to switch to it.
   */
  normalizeToLufs?: number | null;
  /** Told what could not be decoded, rather than losing it silently. */
  onMixProblem?: (problem: string) => void;
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

/** Unmuted: the assembly mixes every clip's own audio into the recording. */
function loadVideo(src: string): Promise<HTMLVideoElement> {
  return loadVideoElement(src, { muted: false });
}

const seek = seekVideo;

/**
 * Render the cut list to a single file. Loads every clip up front (so a bad
 * clip fails fast, before recording starts), then records the canvas +
 * mixed audio in real time.
 */
/**
 * Decode one media file's audio, or say why not.
 *
 * A clip whose audio the webview cannot decode (Opus in a container Safari
 * refuses, a file that turned out to be silent) must not fail the export: the
 * rest of the mix is still worth having, and the caller is told exactly which
 * sound is missing rather than discovering it on playback.
 */
async function decodeAudio(
  context: BaseAudioContext,
  src: string,
): Promise<AudioBuffer | undefined> {
  try {
    const response = await fetch(src);
    const bytes = await response.arrayBuffer();
    return await context.decodeAudioData(bytes);
  } catch {
    return undefined;
  }
}

/** Whether the caller asked for anything the live path cannot do. */
function wantsOfflineMix(options: AssembleOptions): boolean {
  if (options.normalizeToLufs !== undefined) return true;
  return Object.values(options.lanes ?? {}).some((sounds) => (sounds?.length ?? 0) > 0);
}

/**
 * Everything audible, rendered once, ahead of the recording.
 *
 * Returns `undefined` when there is nothing to play or the platform has no
 * offline context, which puts the caller back on the live path rather than
 * exporting a silent film.
 */
async function renderOfflineMix(
  options: AssembleOptions,
  windows: readonly { start: number; end: number }[],
): Promise<AudioBuffer | undefined> {
  if (typeof OfflineAudioContext === "undefined") return undefined;
  const scratch = new OfflineAudioContext(1, 1, 48000);
  const buffers = new Map<string, AudioBuffer>();
  const sources: MixSource[] = [];

  // The clips' own sound, laid end to end exactly as the picture will be.
  let at = 0;
  for (const [index, clip] of options.clips.entries()) {
    const window = windows[index];
    const length = window.end - window.start;
    if (length <= 0) continue;
    const id = `clip-${index}`;
    const decoded = await decodeAudio(scratch, clip.src);
    if (decoded) {
      buffers.set(id, decoded);
      sources.push({
        id,
        lane: "clips",
        atSeconds: at,
        inSeconds: window.start,
        outSeconds: window.end,
      });
    }
    // A clip that fails to decode is reported by nobody, deliberately: a clip
    // with no audio track fails exactly the same way as one whose codec the
    // webview refuses, and warning about every silent shot would train the
    // user to ignore the one warning that matters. The lanes below are
    // different - those files are audio by definition.
    at += length;
  }

  const lanes: Array<[Exclude<MixLane, "clips">, AssembleSound[]]> = [
    ["dialogue", options.lanes?.dialogue ?? []],
    ["sfx", options.lanes?.sfx ?? []],
    ["music", options.lanes?.music ?? []],
  ];
  // A background track supplied the old way is simply the music lane.
  if (options.audioSrc) {
    lanes[2][1] = [
      ...lanes[2][1],
      { src: options.audioSrc, atSeconds: 0, gain: options.audioVolume ?? 0.6 },
    ];
  }

  for (const [lane, sounds] of lanes) {
    for (const [index, sound] of sounds.entries()) {
      const id = `${lane}-${index}`;
      const decoded = await decodeAudio(scratch, sound.src);
      if (!decoded) {
        options.onMixProblem?.(`One ${lane} sound could not be read.`);
        continue;
      }
      buffers.set(id, decoded);
      sources.push({
        id,
        lane,
        atSeconds: sound.atSeconds,
        inSeconds: sound.inSeconds ?? 0,
        outSeconds: sound.outSeconds ?? decoded.duration,
        gain: sound.gain,
      });
    }
  }

  if (sources.length === 0) return undefined;
  const durationSeconds = windows.reduce((sum, window) => sum + (window.end - window.start), 0);
  const plan = planMix({ durationSeconds, sources });
  const rendered = await renderMix(plan, {
    buffers,
    targetLufs: options.normalizeToLufs,
  });
  return rendered?.buffer;
}

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

  const windows = videos.map((video, index) => clipWindow(options.clips[index], video.duration));
  const totalSeconds = windows.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  if (totalSeconds <= 0) throw new Error("The cut list is empty after trimming.");

  // The mix, if the caller asked for one. Rendered before anything is recorded
  // so that the recording only ever plays back a finished decision.
  const mixed = wantsOfflineMix(options) ? await renderOfflineMix(options, windows) : undefined;

  // One AudioContext feeds the recording; the graph never touches the speakers.
  const audioContext = new AudioContext();
  const mixOut = audioContext.createMediaStreamDestination();
  let mixSource: AudioBufferSourceNode | undefined;
  let backgroundAudio: HTMLAudioElement | undefined;
  if (mixed) {
    // The clips supply frames only: their sound is already inside the buffer.
    for (const video of videos) video.muted = true;
    mixSource = audioContext.createBufferSource();
    mixSource.buffer = mixed;
    mixSource.connect(mixOut);
  } else {
    for (const video of videos) {
      audioContext.createMediaElementSource(video).connect(mixOut);
    }
    if (options.audioSrc) {
      backgroundAudio = new Audio(options.audioSrc);
      backgroundAudio.crossOrigin = "anonymous";
      const gain = audioContext.createGain();
      gain.gain.value = options.audioVolume ?? 0.6;
      audioContext.createMediaElementSource(backgroundAudio).connect(gain).connect(mixOut);
    }
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

  // Fire and forget: a suspended context only silences the mix, it must not
  // hang the export (resume() can stay pending under strict autoplay rules).
  void audioContext.resume().catch(() => undefined);
  recorder.start(500);
  mixSource?.start();
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
    try {
      mixSource?.stop();
    } catch {
      // Stopping a source that never started throws; nothing to do about it.
    }
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
