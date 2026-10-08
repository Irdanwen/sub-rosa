/**
 * Pictures for a voice turn: one frame of the camera's preview when the
 * person stops speaking (or on "Look"), or one frame of a shared screen, as
 * a JPEG data URL the turn carries for a model that can see (ADR-0093
 * decision 8). The long edge and quality are the app's screen frame's. The
 * site's CSP allows `data:` images, so no media URL is needed.
 */
import { VOICE } from "./constants";

/** The size a frame is drawn at: the source, shrunk to the long edge. */
export function frameSize(width: number, height: number, longest = VOICE.frame.longestSide) {
  const scale = Math.min(1, longest / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The video's current picture, or null before it has shown anything. */
export function frameFromVideo(
  video: HTMLVideoElement | null,
  canvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
): string | null {
  if (!video?.videoWidth || !video.videoHeight) return null;
  const { width, height } = frameSize(video.videoWidth, video.videoHeight);
  const target = canvas();
  target.width = width;
  target.height = height;
  const context = target.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  return target.toDataURL("image/jpeg", VOICE.frame.jpegQuality / 100);
}

export function stopStream(stream: MediaStream | null) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
  });
}

/** The screen, shared while the person keeps it shared; the browser shows
 * its own sharing indicator. Only one frame per turn is ever taken. */
export function openScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
}

export const canShareScreen = () =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
export const canUseCamera = () =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
