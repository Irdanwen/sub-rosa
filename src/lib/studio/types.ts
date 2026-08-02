// Shared types for the Studio (image, video, music, workflows) — the
// frontend mirror of the media proxy DTOs in src-tauri/src/carpe_diem/media.rs.

/** Carpe Diem's model-type vocabulary, shared by both backends. */
export type MediaType =
  | "image"
  | "imageEdit"
  | "video"
  | "imageToVideo"
  /** Reference-to-video: photos steer style/subject rather than being the
   * opening frame. Carpe Diem split these out of `imageToVideo` into their own
   * type; a handful of families (grok) are still published as `imageToVideo`
   * and are told apart by their id (see `isReferenceToVideo`). */
  | "referenceToVideo"
  | "music"
  | "tts"
  | "upscale"
  | "text"
  | "asr"
  | "embedding"
  | "other";

/** Venice image-model constraints (verbatim from the public catalog). */
export interface ImageConstraints {
  promptCharacterLimit?: number;
  aspectRatios?: string[];
  defaultAspectRatio?: string;
  resolutions?: string[];
  defaultResolution?: string;
  steps?: { default: number; max: number };
  widthHeightDivisor?: number;
}

/** Venice video-model constraints (verbatim from the public catalog). */
export interface VideoConstraints {
  model_type?: "text-to-video" | "image-to-video";
  aspect_ratios?: string[];
  resolutions?: string[];
  /** Durations are strings on the wire ("5s", "10s") — keep them opaque. */
  durations?: string[];
  audio?: boolean;
  audio_configurable?: boolean;
  audio_input?: boolean;
  video_input?: boolean;
}

export interface MediaModel {
  id: string;
  mediaType: MediaType;
  name: string;
  tier?: string;
  privacy?: string;
  offline: boolean;
  voices?: string[];
  constraints?: ImageConstraints & VideoConstraints;
  modelSets?: string[];
  traits?: string[];
  /** Whether the model declares image (vision) input support. */
  supportsVision?: boolean;
  /** Venice `model_spec.pricing`, verbatim (music duration brackets, etc). */
  pricing?: Record<string, unknown>;
  /** Flat per-generation price in credits, when the backend publishes one. */
  costCredits?: number;
}

export interface MediaCatalog {
  backend: "carpe-diem" | "venice";
  priceMultiplier?: number;
  models: MediaModel[];
}

/** Raw response from the generic media proxy command. */
export interface MediaProxyResponse {
  status: number;
  ok: boolean;
  json?: unknown;
  bodyBase64?: string;
  contentType?: string;
  retryAfterMs?: number;
}

export interface ArtifactFile {
  path: string;
  fileName: string;
  bytes: number;
}

export type ArtifactKind = "image" | "video" | "music" | "speech" | "sfx";

/** A gallery entry: the on-disk file plus the generation that produced it. */
export interface StudioArtifact {
  id: string;
  kind: ArtifactKind;
  path: string;
  fileName: string;
  bytes: number;
  model: string;
  prompt: string;
  createdAt: number;
  /** Shot continuity: the clip this one continues, when it was rendered from a
   * handoff frame. Absent on a first shot and on everything older than the
   * feature. */
  parentId?: string;
  /** Where in the parent the handoff frame was taken, in seconds. Assembly
   * trims the parent's tail to this point so the seam is not replayed. */
  parentHandoffSeconds?: number;
  /** What this render was quoted at, in credits. An estimate the backend
   * priced before rendering, not a receipt. */
  costCredits?: number;
}
