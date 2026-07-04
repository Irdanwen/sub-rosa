// Shared types for the Studio (image, video, music, workflows) — the
// frontend mirror of the media proxy DTOs in src-tauri/src/carpe_diem/media.rs.

/** Carpe Diem's model-type vocabulary, shared by both backends. */
export type MediaType =
  | "image"
  | "imageEdit"
  | "video"
  | "imageToVideo"
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

export type ArtifactKind = "image" | "video" | "music" | "speech";

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
}
