// The phone's camera in a voice conversation: a live preview, and one
// frame taken when the person stops speaking (or taps "Look"), sent with
// that turn as an image for a vision model. The preview needs the webview's
// camera (getUserMedia); where it has none, "Look" falls back to the
// system camera, one photo at a time.

import type { AgentLiteAttachment } from "../tauri";

export type CameraFacing = "user" | "environment";

/** The long edge of a frame sent to the model: enough to read a label. */
export const FRAME_MAX_EDGE = 1280;

export function cameraPreviewSupported(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export async function openCamera(facing: CameraFacing): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
}

export function closeCamera(stream: MediaStream | null) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** The size a frame is drawn at: the source, shrunk to the long edge. */
export function frameSize(width: number, height: number, maxEdge = FRAME_MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The preview's current picture as a JPEG data URL, or null before the
 * camera has shown anything. */
export function frameFromVideo(video: HTMLVideoElement | null): string | null {
  if (!video?.videoWidth || !video.videoHeight) return null;
  const { width, height } = frameSize(video.videoWidth, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

/** A frame as the phone chat attaches an image. */
export function frameAttachment(dataUrl: string): AgentLiteAttachment {
  return { kind: "image", name: "camera.jpg", data: dataUrl };
}

/** A photo from the system camera as a frame: read, shrunk, re-encoded.
 * Through a data URL, not a blob URL: the app's CSP allows `data:` images. */
export async function frameFromPhoto(file: Blob): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("read failed"));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("decode failed"));
    element.src = original;
  });
  const { width, height } = frameSize(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.8);
}
