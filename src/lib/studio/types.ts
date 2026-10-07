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
  /** Edit models: whether several images can be sent at once, and how many.
   * The operator may cap lower than this (see `MULTI_EDIT_OPERATOR_CAP`). */
  combineImages?: boolean;
  maxInputImages?: number;
  singleImageAspectRatio?: boolean;
  qualities?: string[];
  defaultQuality?: string;
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

/** What an audio model on the queue accepts, as the catalogs publish it
 * (snake_case, verbatim). Venice states these as flat `model_spec` fields;
 * the operator and the Rust merge gather them into `constraints`. */
export interface AudioConstraints {
  supports_lyrics?: boolean;
  lyrics_required?: boolean;
  supports_force_instrumental?: boolean;
  supports_lyrics_optimizer?: boolean;
  supports_loop?: boolean;
  duration_options?: number[];
  min_duration?: number;
  max_duration?: number;
  default_duration?: number;
  prompt_character_limit?: number;
  lyrics_character_limit?: number;
  min_prompt_length?: number;
  supported_formats?: string[];
  default_format?: string;
  voices?: string[];
  default_voice?: string;
  supports_custom_voice_id?: boolean;
  supports_speed?: boolean;
  min_speed?: number;
  max_speed?: number;
  default_speed?: number;
  /** Voice cloning from a short sample (tts-chatterbox-hd). */
  voice_cloning?: {
    mode?: string;
    accepted_formats?: string[];
    min_sample_seconds?: number;
    retention_days?: number;
  };
}

export interface MediaModel {
  id: string;
  mediaType: MediaType;
  name: string;
  tier?: string;
  privacy?: string;
  offline: boolean;
  voices?: string[];
  constraints?: ImageConstraints & VideoConstraints & AudioConstraints;
  modelSets?: string[];
  traits?: string[];
  /** Whether the model declares image (vision) input support. */
  supportsVision?: boolean;
  /** Whether the model honours `reasoning_effort` (text models). */
  supportsReasoningEffort?: boolean;
  /** How many tokens of conversation the model reads (text models). */
  contextTokens?: number;
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
  title?: string;
  projectIds?: string[];
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
  /** Frame capture: the clip this still was read out of, and where in it.
   *
   * Deliberately not `parentId`/`parentHandoffSeconds`, which mean "this shot
   * continues that one" and are what `chain.ts` walks to rebuild a chain and
   * count its branches. A capture is an image, not a shot, and must never join
   * a chain - reusing those fields would work only for as long as every caller
   * kept filtering the list down to videos first, an invariant `chain.ts`
   * cannot see or enforce. */
  sourceArtifactId?: string;
  sourceTimeSeconds?: number;
  /** What this render was quoted at, in credits. An estimate the backend
   * priced before rendering, not a receipt. */
  costCredits?: number;
  /** Retouch lineage: this image is a version of another one. Its own field,
   * never `parentId` (which `chain.ts` walks for video shots). */
  edit?: RetouchLineage;
  /** Measures learned by looking at the file once, then kept with it
   * (`studio_artifact_measure`): a clip's or track's length, a picture's or
   * clip's size, a track's silhouette (0..1 bars), and whether a poster
   * still was filed for it (`/poster/<file>` on the media scheme). */
  durationMs?: number;
  width?: number;
  height?: number;
  peaks?: number[];
  posterVersion?: number;
}

/** How a retouch version was made. */
export type RetouchOperation = "prompt" | "zone" | "variant" | "upscale" | "extend";

/** The lineage a retouch version carries, stored with its generation metadata
 * so the version tree survives a restart without a table of its own. */
export interface RetouchLineage {
  /** The version this one was made from. */
  of: string;
  /** The original image of the session. Keeps a branch attached when a
   * version in the middle is deleted. */
  root: string;
  op: RetouchOperation;
  /** Version number in the session; the original is 0. */
  n: number;
  /** The durable job that produced it, so recovery never files it twice. */
  jobId?: string;
  /** How long the edit took, measured from submission to delivery. */
  elapsedMs?: number;
  /** Gallery ids of the extra images sent with the prompt. */
  refs?: string[];
  settings?: { resolution?: string; quality?: string; aspectRatio?: string; scale?: number };
  /** Zone edits: the rectangle that was sent, in the parent's pixels. */
  region?: { crop: [number, number, number, number] };
  /** Variants: which try of a batch this is. */
  variant?: { group: string; index: number; of: number };
  /** A zone result that could not be merged back (its source was gone), so
   * the version is the edited crop alone. */
  unmerged?: boolean;
}
