// What each node type does when it runs, and the small readers it shares.

import { t } from "../../i18n";
import { assembleClips, blobToBase64, mixSounds, type AssembleClip } from "../assemble";
import { DEFAULT_TARGET_LUFS } from "../loudness";
import { DIALOGUE_GAP_SECONDS } from "../mix";
import { fileResultFrom, type MediaFileResult, pollUntilDone } from "../async-job";
import {
  fetchMediaCatalog,
  musicCapabilities,
  musicQueueBody,
  speechRail,
  supportsBackgroundRemoval,
} from "../catalog";
import {
  acceptedFormat,
  generateSpeech,
  queuedSpeechJob,
  type SpeechFormat,
  speechCapabilities,
} from "../speech";
import { mediaJson } from "../client";
import { composePacks, sheetable, sheetPrompt } from "../compose/packs";
import { composeImages, nativeQueuedImage, removeBackground, upscaleImage } from "../edit-image";
import { cropForSending, naturalSize, prepareSource, rasterizeZone } from "../retouch/canvas-io";
import { buildEditRequest, editCaps } from "../retouch/request";
import { strokesInCrop, type ZoneStroke, zoneBounds, zoneCrop } from "../retouch/zone";
import { zoneOf } from "./zone-param";
import { generateImages } from "../generate-image";
import { extractFrameAt, extractHandoffFrame, loadVideoElement } from "../frames";
import { musicPaths, retrieveBody } from "../paths";
import type { ReferenceRole } from "../kling";
import { requestSizeProblem } from "../seedance";
import type { MediaModel } from "../types";
import { videoRequestBody } from "../video-request";
import { audioBufferToWav } from "../wav";
import { nodeLabel, type WorkflowNode } from "./schema";
import type {
  NodeOutput,
  WorkflowStorage,
  DurableRenderRequest,
  RunWorkflowOptions,
} from "./run-types";

/** Where a prompt asks for its upstream text to be placed. Exported because
 * the editors offer to write it, and a marker spelled differently there would
 * simply not be one. */
export const INPUT_MARKER = "{{input}}";

/** {{input}} substitutes upstream text; without the marker the input is
 * appended after the prompt; an empty prompt passes the input through. */
export function resolvePrompt(template: string, input: string): string {
  if (!template) return input;
  // split/join instead of replace: input may contain "$" patterns.
  if (template.includes(INPUT_MARKER)) return template.split(INPUT_MARKER).join(input);
  return input ? `${template}\n\n${input}` : template;
}

export function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberParam(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanParam(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  return typeof value === "boolean" ? value : undefined;
}

/** Text stand-in for a media output when it feeds a text input. */
function textualize(output: NodeOutput): string {
  switch (output.kind) {
    case "text":
      return output.text;
    case "image":
      return "[generated image]";
    case "audio":
      return "[generated audio]";
    case "video":
      return "[generated video]";
  }
}

function joinAsText(outputs: NodeOutput[]): string {
  return outputs
    .map(textualize)
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

function textInputOf(ports: Map<string, NodeOutput[]>, portId: string): string {
  return joinAsText(ports.get(portId) ?? []);
}

function imagesOn(ports: Map<string, NodeOutput[]>, portId: string) {
  return (ports.get(portId) ?? []).filter(
    (output): output is Extract<NodeOutput, { kind: "image" }> => output.kind === "image",
  );
}

/**
 * What each reference image shows, from the video node's `referenceRoles`
 * param (keyed by gallery artifact, written by the film compiler). An image
 * the param does not know - a canvas edit, a generated frame - is undescribed.
 */
function referenceRolesOf(
  params: Record<string, unknown>,
  images: readonly Extract<NodeOutput, { kind: "image" }>[],
): (ReferenceRole | undefined)[] | undefined {
  const known = params.referenceRoles;
  if (!known || typeof known !== "object" || Array.isArray(known)) return undefined;
  const roles = known as Record<string, unknown>;
  return images.map((image) => {
    const role = image.artifactId ? roles[image.artifactId] : undefined;
    if (!role || typeof role !== "object") return undefined;
    const { subject, scene } = role as Record<string, unknown>;
    if (scene === true) return { scene: true };
    return typeof subject === "string" && subject.trim() ? { subject } : undefined;
  });
}

function imageDataUri(image: Extract<NodeOutput, { kind: "image" }>): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

function queueId(response: Record<string, unknown>): string {
  const id = response.queue_id ?? response.id;
  if (typeof id !== "string" || id === "") {
    throw new Error(t("The backend did not return a job id."));
  }
  return id;
}

/** Reasoning models may prefix their answer with a think block; drop it. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

const TTS_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
};

function audioExtension(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("flac")) return "flac";
  return "mp3";
}

/** How long to wait for a clip's metadata before giving up on measuring it. */
const DURATION_PROBE_TIMEOUT_MS = 4_000;

/**
 * A clip's length in seconds, or 0 when the webview cannot decode it.
 *
 * Bounded on purpose: a source the media loader never resolves (an unplayable
 * container, a revoked blob) would otherwise hang the whole render, and the
 * duration is only ever a nicety — it refines a quote, it does not gate the
 * request.
 */
async function videoDuration(src: string): Promise<number> {
  try {
    const video = await Promise.race([
      loadVideoElement(src),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), DURATION_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (!video) return 0;
    const seconds = Number.isFinite(video.duration) ? video.duration : 0;
    video.src = "";
    return seconds;
  } catch {
    return 0;
  }
}

/**
 * The catalog's own entry for a model id, so request building sees everything
 * the operator published about it (durations, ratios, resolutions). Falls back
 * to a bare stand-in when the catalog is unreachable or the id is unknown: the
 * probed table still answers by id, which is better than refusing to render.
 */
export async function catalogModel(modelId: string): Promise<MediaModel> {
  try {
    const catalog = await fetchMediaCatalog();
    const found = catalog.models.find((entry) => entry.id === modelId);
    if (found) return found;
  } catch {
    // Offline or early boot: fall through to the stand-in.
  }
  return { id: modelId, name: modelId, mediaType: "video", offline: false };
}

interface NodeContext {
  signal?: AbortSignal;
  storage?: WorkflowStorage;
  /** Per-node progress (0..1) for nodes that can report it. */
  onProgress?: (fraction: number) => void;
  /** What this node's render was priced at before the run, in credits. */
  costCredits?: number;
  /** Durable render runner (see {@link RunWorkflowOptions.durableMedia}). */
  durableMedia?: RunWorkflowOptions["durableMedia"];
}

function requireStorage(context: NodeContext, refusal: string): WorkflowStorage {
  if (!context.storage) {
    throw new Error(refusal);
  }
  return context.storage;
}

export async function executeNode(
  node: WorkflowNode,
  ports: Map<string, NodeOutput[]>,
  context: NodeContext,
): Promise<NodeOutput> {
  const params = node.params;
  const { signal, storage } = context;

  switch (node.type) {
    case "textInput":
      return { kind: "text", text: stringParam(params, "text") ?? "" };

    case "asset": {
      const artifactId = stringParam(params, "artifactId");
      if (!artifactId) throw new Error(t("Pick a gallery item."));
      const asset = await requireStorage(
        context,
        t("This runner cannot read the gallery."),
      ).loadAsset(artifactId);
      if (asset.kind === "image") {
        if (!asset.base64) throw new Error(t("Couldn't read that image from the gallery."));
        return {
          kind: "image",
          base64: asset.base64,
          mimeType: asset.mimeType ?? "image/png",
          artifactId: asset.artifactId,
        };
      }
      if (asset.kind === "video") {
        return {
          kind: "video",
          artifactId: asset.artifactId,
          src: asset.src,
          parentId: asset.parentId,
          parentHandoffSeconds: asset.parentHandoffSeconds,
        };
      }
      return {
        kind: "audio",
        mimeType: asset.mimeType ?? "audio/mpeg",
        artifactId: asset.artifactId,
        src: asset.src,
      };
    }

    case "document": {
      const noteId = stringParam(params, "noteId");
      if (!noteId) throw new Error(t("Pick a note."));
      const note = await requireStorage(context, t("This runner cannot read notes.")).loadNote(
        noteId,
      );
      const text = note.text.trim();
      return { kind: "text", text: note.title ? `${note.title}\n\n${text}` : text };
    }

    case "output": {
      // Pass through: the first media output when present, else the text.
      const inputs = ports.get("in") ?? [];
      const media = inputs.find((output) => output.kind !== "text");
      return media ?? { kind: "text", text: joinAsText(inputs) };
    }

    case "chat": {
      const prompt = resolvePrompt(
        stringParam(params, "prompt") ?? "",
        textInputOf(ports, "prompt"),
      );
      const response = await mediaJson<ChatResponse>(
        "/chat/completions",
        {
          model: stringParam(params, "model") ?? "",
          messages: [{ role: "user", content: prompt }],
          temperature: numberParam(params, "temperature") ?? 0.7,
          max_tokens: numberParam(params, "maxTokens") ?? 2048,
        },
        signal,
      );
      const content = response.choices?.[0]?.message?.content;
      return { kind: "text", text: typeof content === "string" ? stripThinking(content) : "" };
    }

    case "image": {
      const model = stringParam(params, "model") ?? "";
      const prompt = resolvePrompt(
        stringParam(params, "prompt") ?? "",
        textInputOf(ports, "prompt"),
      );
      const body: Record<string, unknown> = {
        model,
        prompt,
        hide_watermark: booleanParam(params, "hideWatermark") ?? true,
        format: "png",
        safe_mode: false,
      };
      const negativePrompt = stringParam(params, "negativePrompt");
      if (negativePrompt) body.negative_prompt = negativePrompt;
      const aspectRatio = stringParam(params, "aspectRatio");
      if (aspectRatio) body.aspect_ratio = aspectRatio;
      const stylePreset = stringParam(params, "stylePreset");
      if (stylePreset) body.style_preset = stylePreset;
      // Route through generateImages so heavy models land on the async queue
      // instead of bouncing off the sync path's 409/502.
      let queuedOutput: NodeOutput | undefined;
      const durableImage = context.durableMedia;
      const [first] = await generateImages(
        model,
        body,
        signal,
        durableImage && storage
          ? async (queueBody) => {
              const saved = await durableImage(
                node.id,
                {
                  kind: "image",
                  model,
                  prompt,
                  extension: "png",
                  queuePath: "/image/generate/queue",
                  queueBody,
                  retrievePath: "/image/generate/retrieve",
                  urlFields: ["image_url", "url"],
                  costCredits: context.costCredits,
                },
                signal,
              );
              if (!saved.artifactId)
                throw new Error(t("The generated image finished but its file is missing."));
              const asset = await storage.loadAsset(saved.artifactId);
              queuedOutput = {
                kind: "image",
                artifactId: saved.artifactId,
                base64: asset.base64 ?? "",
                mimeType: asset.mimeType ?? "image/png",
              };
              return asset.base64 ?? "";
            }
          : undefined,
      );
      if (queuedOutput) return queuedOutput;
      if (typeof first !== "string" || first === "") {
        throw new Error(t("The image backend returned no image."));
      }
      const saved = storage
        ? await storage.save({ base64: first }, "png", {
            kind: "image",
            model,
            prompt,
            costCredits: context.costCredits,
          })
        : undefined;
      return {
        kind: "image",
        base64: first,
        mimeType: saved?.mimeType ?? "image/png",
        artifactId: saved?.artifactId,
      };
    }

    case "imageEdit": {
      const model = stringParam(params, "model") ?? "";
      const prompt = resolvePrompt(
        stringParam(params, "prompt") ?? "",
        textInputOf(ports, "prompt"),
      );
      const sources = imagesOn(ports, "images").map(imageDataUri);
      if (sources.length > 3) throw new Error(t("Choose at most three reference images."));
      if (sources.length === 0) throw new Error(t("Connect at least one image to edit."));
      // A format goes through multi-edit even for one image: see composeImages.
      const aspectRatio = stringParam(params, "aspectRatio") || undefined;
      const multi = sources.length > 1 || aspectRatio !== undefined;
      if (context.durableMedia && storage) {
        const base = multi ? "/image/multi-edit" : "/image/edit";
        const saved = await context.durableMedia(
          node.id,
          {
            kind: "image",
            model,
            prompt,
            extension: "png",
            queuePath: `${base}/queue`,
            retrievePath: `${base}/retrieve`,
            urlFields: ["url", "image_url"],
            queueBody: {
              model,
              prompt,
              safe_mode: false,
              ...(multi ? { images: sources } : { image: sources[0] }),
              ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
            },
            costCredits: context.costCredits,
          },
          signal,
        );
        if (!saved.artifactId) throw new Error(t("The edit finished but its file is missing."));
        const asset = await storage.loadAsset(saved.artifactId);
        return {
          kind: "image",
          base64: asset.base64 ?? "",
          mimeType: asset.mimeType ?? "image/png",
          artifactId: saved.artifactId,
        };
      }
      // One image edits, several compose; heavy models queue on their own.
      const edited = await composeImages(model, prompt, sources, { aspectRatio });
      const saved = storage
        ? await storage.save({ base64: edited }, "png", {
            kind: "image",
            model,
            prompt,
            costCredits: context.costCredits,
          })
        : undefined;
      return {
        kind: "image",
        base64: edited,
        mimeType: saved?.mimeType ?? "image/png",
        artifactId: saved?.artifactId,
      };
    }

    case "tts": {
      const model = stringParam(params, "model") ?? "tts-kokoro";
      const input = textInputOf(ports, "text").trim() || (stringParam(params, "text") ?? "").trim();
      if (!input || input.length > 50_000)
        throw new Error(t("Speech requires between 1 and 50,000 characters."));
      // The rail is the model's (ADR-0076): a speaking model of the music
      // queue is a durable render, never an `/audio/speech` call it would 404.
      const catalog = await fetchMediaCatalog();
      const entry = catalog.models.find((candidate) => candidate.id === model);
      if (entry && speechRail(entry) === "queue") {
        const caps = speechCapabilities(entry);
        if (input.length > caps.inputLimit)
          throw new Error(
            t("{model} reads at most {count} characters at a time.", {
              model: entry.name,
              count: caps.inputLimit,
            }),
          );
        const spec = queuedSpeechJob(catalog, caps, {
          model: entry,
          text: input,
          voice: stringParam(params, "voice"),
          speed: numberParam(params, "speed"),
        });
        const request: DurableRenderRequest = {
          kind: "speech",
          model,
          prompt: input,
          extension: spec.extension,
          queuePath: spec.queuePath,
          queueBody: spec.queueBody,
          retrievePath: musicPaths(catalog.backend).retrieve,
          urlFields: spec.urlFields,
          costCredits: context.costCredits,
        };
        if (!context.durableMedia) {
          throw new Error(t("This runner cannot wait for a queued voice-over."));
        }
        const saved = await context.durableMedia(node.id, request, signal);
        return {
          kind: "audio",
          mimeType: saved.mimeType ?? "audio/mpeg",
          source: "speech",
          artifactId: saved.artifactId,
          src: saved.src,
          atSeconds: secondsParam(params, "startAt"),
        };
      }
      // A format the engine answers in (Chatterbox HD takes only wav).
      const format = entry
        ? acceptedFormat(speechCapabilities(entry), stringParam(params, "responseFormat") as never)
        : (stringParam(params, "responseFormat") ?? "mp3");
      // Through the one speech client, so a cloned voice (`cloned:<id>`,
      // ADR-0077) is resolved to its handle at the moment of speaking.
      const { base64, contentType } = await generateSpeech({
        model,
        input,
        voice: stringParam(params, "voice") || undefined,
        speed: numberParam(params, "speed") ?? 1,
        format: format as SpeechFormat,
        signal,
      });
      const mimeType = contentType ?? TTS_MIME[format] ?? "audio/mpeg";
      const saved = storage
        ? await storage.save({ base64 }, audioExtension(mimeType), {
            kind: "speech",
            model,
            prompt: input,
            costCredits: context.costCredits,
          })
        : undefined;
      return {
        kind: "audio",
        base64,
        mimeType: saved?.mimeType ?? mimeType,
        source: "speech",
        artifactId: saved?.artifactId,
        src: saved?.src,
        // Only the node that rendered the line was told which shot it belongs
        // to. Stamping it here is what lets the cut place it.
        atSeconds: secondsParam(params, "startAt"),
      };
    }

    case "music": {
      const model = stringParam(params, "model") ?? "";
      const prompt =
        textInputOf(ports, "prompt").trim() || (stringParam(params, "prompt") ?? "").trim();
      if (!prompt) throw new Error(t("Add a music prompt before generating the score."));
      // Read the catalog first: the model's published limits decide which keys
      // go out (ADR-0076), and the backend decides the paths below.
      const catalog = await fetchMediaCatalog();
      const caps = musicCapabilities(catalog.models.find((entry) => entry.id === model) ?? model);
      const body = musicQueueBody(caps, {
        model,
        prompt,
        lyrics: stringParam(params, "lyrics"),
        instrumental: booleanParam(params, "instrumental") === true,
        writeLyrics: booleanParam(params, "writeLyrics") === true,
        durationSeconds: numberParam(params, "durationSeconds"),
        loop: booleanParam(params, "loop") === true,
      });
      // Music lives under /audio/music/* on Carpe Diem but /audio/* on
      // Venice; the (cached) catalog knows which backend the key targets.
      const paths = musicPaths(catalog.backend);
      if (context.durableMedia) {
        const saved = await context.durableMedia(
          node.id,
          {
            kind: "music",
            model,
            prompt,
            extension: "mp3",
            queuePath: paths.queue,
            queueBody: body,
            retrievePath: paths.retrieve,
            urlFields: ["audio_url", "url"],
            costCredits: context.costCredits,
          },
          signal,
        );
        return {
          kind: "audio",
          mimeType: saved.mimeType ?? "audio/mpeg",
          source: "music",
          artifactId: saved.artifactId,
          src: saved.src,
        };
      }
      const queued = await mediaJson<Record<string, unknown>>(paths.queue, body, signal);
      // Carpe Diem streams the finished track as the retrieve body (one
      // shot); Venice answers JSON with an `audio_url`.
      const result = await pollUntilDone<MediaFileResult>({
        retrievePath: paths.retrieve,
        retrieveBody: retrieveBody(queueId(queued), model),
        getResult: fileResultFrom("audio_url", "url"),
        signal,
      });
      const saved = storage
        ? await storage.save(result, "mp3", {
            kind: "music",
            model,
            prompt,
            costCredits: context.costCredits,
          })
        : undefined;
      return {
        kind: "audio",
        ...result,
        mimeType: saved?.mimeType ?? "audio/mpeg",
        source: "music",
        artifactId: saved?.artifactId,
        src: saved?.src,
      };
    }

    case "video": {
      const model = stringParam(params, "model") ?? "";
      const prompt = resolvePrompt(
        stringParam(params, "prompt") ?? "",
        textInputOf(ports, "prompt"),
      );
      const opening = imagesOn(ports, "openingFrame")[0];
      const end = imagesOn(ports, "endFrame")[0];
      const references = imagesOn(ports, "references");

      // Reference clips travel inline, so they are read out of the gallery
      // here rather than passed around as URLs no backend could fetch.
      const clipInputs = (ports.get("referenceClips") ?? []).filter(
        (output): output is Extract<NodeOutput, { kind: "video" }> => output.kind === "video",
      );
      const referenceVideos: string[] = [];
      const referenceVideoSeconds: number[] = [];
      if (clipInputs.length > 0) {
        const clipStorage = requireStorage(context, t("This runner cannot read reference clips."));
        for (const clip of clipInputs) {
          if (!clip.artifactId) {
            throw new Error(t("A reference clip must come from the gallery."));
          }
          referenceVideos.push(await clipStorage.readMedia(clip.artifactId));
          // The quote only matches the queue charge when it knows the
          // combined length; an unreadable duration simply goes unreported.
          if (clip.src) referenceVideoSeconds.push(await videoDuration(clip.src));
        }
        const oversize = requestSizeProblem(referenceVideos);
        if (oversize) throw new Error(oversize);
      }

      // A voice to follow travels inline too, read out of the gallery.
      const referenceAudio: string[] = [];
      for (const voice of (ports.get("referenceAudio") ?? []).filter(
        (output): output is Extract<NodeOutput, { kind: "audio" }> => output.kind === "audio",
      )) {
        if (!voice.artifactId) throw new Error(t("A reference voice must come from the gallery."));
        referenceAudio.push(
          await requireStorage(context, t("This runner cannot read reference audio.")).readMedia(
            voice.artifactId,
          ),
        );
      }

      // The body comes from the one place that knows each variant's contract
      // (which fields exist, which enums are valid, that image-to-video
      // rejects aspect_ratio, when the seedance attestation rides along).
      // Building it here by hand is how the canvas and the studios drift.
      //
      // The catalog entry matters as much as the id: half of what a variant
      // accepts is published there rather than probed, and a stand-in model
      // object would quietly drop those constraints.
      const target = await catalogModel(model);
      const body = videoRequestBody({
        target,
        prompt,
        openingFrame: opening ? imageDataUri(opening) : undefined,
        endFrame: end ? imageDataUri(end) : undefined,
        // Capped by the request builder, which knows each family's layout:
        // kling groups a character's angles, so a flat count would cut short.
        references: references.map(imageDataUri),
        referenceRoles: referenceRolesOf(params, references),
        referenceVideos,
        referenceVideoSeconds,
        referenceAudio,
        duration: stringParam(params, "duration"),
        aspectRatio: stringParam(params, "aspectRatio"),
        resolution: stringParam(params, "resolution"),
        // A workflow runs unattended: the attestation rides on any seedance
        // render built from a photo, exactly as the studios send it.
        consent: true,
        // Written by the film compiler when the shot's line is dubbed.
        silent: params.silent === true,
      });
      if (!body) {
        throw new Error(
          "This video node has nothing to render from. Give it a prompt, and a frame or references if its model needs them.",
        );
      }

      // A shot rendered from a handoff frame continues that clip: record the
      // parent links so the gallery sees a real chain (ADR-0019).
      const openingChain = opening?.chainFrom;
      if (context.durableMedia) {
        const saved = await context.durableMedia(
          node.id,
          {
            kind: "video",
            model,
            prompt,
            extension: "mp4",
            queuePath: "/video/queue",
            queueBody: body,
            retrievePath: "/video/retrieve",
            urlFields: ["video_url", "url"],
            parentArtifactId: openingChain?.artifactId,
            parentHandoffSeconds: openingChain?.handoffSeconds,
            costCredits: context.costCredits,
          },
          signal,
        );
        return {
          kind: "video",
          artifactId: saved.artifactId,
          src: saved.src,
          parentId: openingChain?.artifactId,
          parentHandoffSeconds: openingChain?.handoffSeconds,
        };
      }

      const queued = await mediaJson<Record<string, unknown>>("/video/queue", body, signal);
      // A finished render comes back either as a URL in the JSON or as the
      // mp4 bytes themselves (the retrieve switches content type once done),
      // so accept both rather than polling forever past a binary delivery.
      const result = await pollUntilDone<MediaFileResult>({
        retrievePath: "/video/retrieve",
        // The video retrieve endpoint requires the model alongside the id.
        retrieveBody: retrieveBody(queueId(queued), model),
        getResult: fileResultFrom("video_url", "url"),
        signal,
      });
      const saved = storage
        ? await storage.save(result, "mp4", {
            kind: "video",
            model,
            prompt,
            parentId: openingChain?.artifactId,
            parentHandoffSeconds: openingChain?.handoffSeconds,
            costCredits: context.costCredits,
          })
        : undefined;
      return {
        kind: "video",
        url: "url" in result ? result.url : undefined,
        artifactId: saved?.artifactId,
        src: saved?.src,
        parentId: openingChain?.artifactId,
        parentHandoffSeconds: openingChain?.handoffSeconds,
      };
    }

    case "lastFrame": {
      const source = (ports.get("video") ?? []).find(
        (output): output is Extract<NodeOutput, { kind: "video" }> => output.kind === "video",
      );
      if (!source) throw new Error(t("Connect a video to take a frame from."));
      if (!source.src) {
        throw new Error(t("This runner cannot read frames out of a video."));
      }
      const position = stringParam(params, "position") ?? "handoff";
      const frame =
        position === "handoff"
          ? await extractHandoffFrame(source.src)
          : await extractFrameAt(source.src, position === "start" ? 0 : Number.MAX_SAFE_INTEGER);
      const comma = frame.dataUrl.indexOf(",");
      // A start frame is a capture, not a continuation point: a shot rendered
      // from it would replay the clip, not continue it, so no chain link.
      const chainFrom =
        position !== "start" && source.artifactId
          ? { artifactId: source.artifactId, handoffSeconds: frame.timeSeconds }
          : undefined;
      return {
        kind: "image",
        base64: comma >= 0 ? frame.dataUrl.slice(comma + 1) : frame.dataUrl,
        mimeType: "image/jpeg",
        chainFrom,
      };
    }

    case "assemble": {
      const storageForFilm = requireStorage(context, t("This runner cannot assemble clips."));
      const clips = (ports.get("clips") ?? []).filter(
        (output): output is Extract<NodeOutput, { kind: "video" }> => output.kind === "video",
      );
      if (clips.length === 0) throw new Error(t("Connect at least one clip."));
      const sources: AssembleClip[] = clips.map((clip, index) => {
        if (!clip.src) throw new Error(t("This runner cannot assemble clips."));
        // A successor that continues this clip trims it at its handoff, so
        // the half second the next shot re-renders is not played twice.
        const next = clips[index + 1];
        const linked =
          next?.parentId !== undefined &&
          next.parentId === clip.artifactId &&
          typeof next.parentHandoffSeconds === "number" &&
          next.parentHandoffSeconds > 0;
        return {
          src: clip.src,
          inSeconds: 0,
          outSeconds: linked ? next.parentHandoffSeconds : undefined,
        };
      });
      // Everything audible, by lane. A track on the node's original single
      // input reads as music, which is what it always was.
      const soundsOn = (portId: string): Array<Extract<NodeOutput, { kind: "audio" }>> =>
        (ports.get(portId) ?? []).filter(
          (output): output is Extract<NodeOutput, { kind: "audio" }> => output.kind === "audio",
        );
      const dialogue = soundsOn("dialogue");
      const sfx = soundsOn("sfx");
      const music = [...soundsOn("music"), ...soundsOn("audio")];
      for (const sound of [...dialogue, ...sfx, ...music]) {
        if (!sound.src) {
          // Never drop a connected sound silently: with storage present every
          // audio-producing node saves and carries a src, so this is a bug net.
          throw new Error(t("This runner cannot read one of the connected sounds."));
        }
      }

      const musicLevel = numberParam(params, "audioVolume") ?? 0.6;
      // Lines with no stated position are laid end to end rather than stacked
      // at zero: two voices talking over each other is never what was meant.
      const placedDialogue = placeLines(dialogue);
      const lanes = {
        dialogue: placedDialogue,
        sfx: sfx.map((sound) => ({ src: sound.src as string, atSeconds: sound.atSeconds ?? 0 })),
        music: music.map((sound) => ({
          src: sound.src as string,
          atSeconds: sound.atSeconds ?? 0,
          gain: musicLevel,
        })),
      };
      const hasSound = dialogue.length + sfx.length + music.length > 0;

      const { blob, extension } = await assembleClips({
        clips: sources,
        lanes: hasSound ? lanes : undefined,
        // Asking for a loudness target is what puts the export on the offline
        // mix: deterministic levels, and music that gets out of the way.
        normalizeToLufs:
          booleanParam(params, "normalize") === false ? undefined : DEFAULT_TARGET_LUFS,
        signal,
        onProgress: context.onProgress,
      });
      const saved = await storageForFilm.save({ base64: await blobToBase64(blob) }, extension, {
        kind: "video",
        model: "assemble",
        prompt: nodeLabel(node),
      });
      return { kind: "video", artifactId: saved.artifactId, src: saved.src };
    }

    case "upscale":
    case "cutout": {
      const source = imagesOn(ports, "image")[0];
      if (!source) throw new Error(t("Connect a picture."));
      let made: string;
      if (node.type === "cutout") {
        // A dedicated endpoint the Carpe Diem operator does not mirror yet.
        if (!supportsBackgroundRemoval(await fetchMediaCatalog()))
          throw new Error(t("Cutting out is not available with this provider yet."));
        made = await removeBackground(source.base64);
      } else {
        made = await upscaleImage(source.base64, stringParam(params, "scale") === "4" ? 4 : 2);
      }
      const saved = storage
        ? await storage.save({ base64: made }, "png", {
            kind: "image",
            model: node.type,
            prompt: nodeLabel(node),
            costCredits: context.costCredits,
          })
        : undefined;
      return {
        kind: "image",
        base64: made,
        mimeType: saved?.mimeType ?? "image/png",
        artifactId: saved?.artifactId,
      };
    }

    case "soundMix": {
      const sounds = (portId: string) =>
        (ports.get(portId) ?? []).filter(
          (output): output is Extract<NodeOutput, { kind: "audio" }> => output.kind === "audio",
        );
      const dialogue = sounds("dialogue");
      const sfx = sounds("sfx");
      const music = sounds("music");
      for (const sound of [...dialogue, ...sfx, ...music]) {
        if (!sound.src) throw new Error(t("This runner cannot read one of the connected sounds."));
      }
      const musicLevel = numberParam(params, "audioVolume") ?? 0.6;
      const mixed = await mixSounds({
        lanes: {
          // Lines one after the other, as in a film's mix (placeLines).
          dialogue: placeLines(dialogue),
          sfx: sfx.map((sound) => ({ src: sound.src as string, atSeconds: sound.atSeconds ?? 0 })),
          music: music.map((sound) => ({
            src: sound.src as string,
            atSeconds: sound.atSeconds ?? 0,
            gain: musicLevel,
          })),
        },
        normalizeToLufs: booleanParam(params, "level") === false ? undefined : DEFAULT_TARGET_LUFS,
      });
      const wav = audioBufferToWav(mixed);
      const base64 = await blobToBase64(wav);
      const saved = storage
        ? await storage.save({ base64 }, "wav", {
            // A mix is music in the gallery's terms: a track to play under things.
            kind: "music",
            model: "mix",
            prompt: nodeLabel(node),
          })
        : undefined;
      return {
        kind: "audio",
        base64,
        mimeType: "audio/wav",
        ...(saved ? { artifactId: saved.artifactId, src: saved.src } : {}),
      };
    }

    case "zoneEdit": {
      const source = imagesOn(ports, "image")[0];
      if (!source) throw new Error(t("Connect a picture."));
      // The result is merged back into the source by Rust, which reads the
      // source from the gallery (carpe_diem/zone.rs).
      const asset =
        source.artifactId && storage ? await storage.loadAsset(source.artifactId) : undefined;
      if (!asset?.fileName || !context.durableMedia || !storage)
        throw new Error(t("The picture to retouch has to be in the gallery first."));
      const model = stringParam(params, "model") ?? "";
      const prompt = resolvePrompt(
        stringParam(params, "prompt") ?? "",
        textInputOf(ports, "prompt"),
      );
      const caps = editCaps(await catalogModel(model));
      const size = await naturalSize(asset.src);
      const zone = zoneOf(params.zone);
      const left = zone.x * size.width;
      const top = zone.y * size.height;
      const right = (zone.x + zone.width) * size.width;
      const bottom = (zone.y + zone.height) * size.height;
      const lasso: ZoneStroke = {
        kind: "lasso",
        points: [
          [left, top],
          [right, top],
          [right, bottom],
          [left, bottom],
        ],
      };
      const bounds = zoneBounds([lasso], size);
      const crop = bounds && zoneCrop(bounds, size, { ratios: caps.aspectRatios });
      if (!crop)
        throw new Error(t("This model cannot retouch a zone. Pick one that takes a format."));
      const request = buildEditRequest(caps, {
        model,
        prompt,
        images: [await cropForSending(asset.src, crop)],
        aspectRatio: crop.ratio,
      });
      const saved = await context.durableMedia(
        node.id,
        {
          kind: "image",
          model,
          prompt,
          extension: "png",
          queuePath: `${request.base}/queue`,
          queueBody: request.body,
          retrievePath: `${request.base}/retrieve`,
          urlFields: ["image_url", "url"],
          costCredits: context.costCredits,
          composite: {
            parentFileName: asset.fileName,
            crop: [crop.x, crop.y, crop.width, crop.height],
            maskPngBase64: rasterizeZone(strokesInCrop([lasso], crop), crop),
          },
        },
        signal,
      );
      if (!saved.artifactId) throw new Error(t("The edit finished but its file is missing."));
      const merged = await storage.loadAsset(saved.artifactId);
      return {
        kind: "image",
        base64: merged.base64 ?? "",
        mimeType: merged.mimeType ?? "image/png",
        artifactId: saved.artifactId,
      };
    }

    case "sheet": {
      const source = imagesOn(ports, "image")[0];
      if (!source) throw new Error(t("Connect a picture."));
      const pack = composePacks().find((entry) => entry.id === stringParam(params, "pack"));
      if (!pack || !sheetable(pack)) throw new Error(t("Pick variations that fit in nine panels."));
      const model = stringParam(params, "model") ?? "";
      const caps = editCaps(await catalogModel(model));
      const prompt = sheetPrompt(pack);
      // A sheet is square whatever the source: each panel is a ninth of it.
      const request = buildEditRequest(caps, {
        model,
        prompt,
        images: [await prepareSource(imageDataUri(source))],
        aspectRatio: caps.aspectRatios.includes("1:1") ? "1:1" : undefined,
      });
      if (context.durableMedia && storage) {
        const saved = await context.durableMedia(
          node.id,
          {
            kind: "image",
            model,
            prompt,
            extension: "png",
            queuePath: `${request.base}/queue`,
            queueBody: request.body,
            retrievePath: `${request.base}/retrieve`,
            urlFields: ["image_url", "url"],
            costCredits: context.costCredits,
          },
          signal,
        );
        if (!saved.artifactId) throw new Error(t("The edit finished but its file is missing."));
        const drawn = await storage.loadAsset(saved.artifactId);
        return {
          kind: "image",
          base64: drawn.base64 ?? "",
          mimeType: drawn.mimeType ?? "image/png",
          artifactId: saved.artifactId,
        };
      }
      const drawn = await nativeQueuedImage(request.base, request.body, "workflow");
      return { kind: "image", base64: drawn, mimeType: "image/png" };
    }

    case "compare":
      // Canvas runs leave comparisons out (modes.ts): it shows its inputs.
      return { kind: "text", text: "" };

    case "block":
      // Flattened before anything runs (flatten.ts); reaching here is a bug.
      throw new Error(t("A block reached the run without its steps."));

    case "note":
      // Canvas runs leave notes out (modes.ts); nothing to make anywhere.
      return { kind: "text", text: "" };

    case "relay": {
      // Canvas runs resolve relays away (modes.ts); a graph built elsewhere
      // still gets what reached it.
      const first = ports.get("in")?.[0];
      if (!first) throw new Error(t("Connect something to pass on."));
      return first;
    }

    default:
      throw new Error(t("Unknown node type: {type}.", { type: String(node.type) }));
  }
}

/**
 * Where each line of dialogue is heard.
 *
 * A line that says where it belongs is left there. One that does not is
 * appended after the ones before it, which is the no-overlap scheduler's whole
 * job - and the only moment a generated line's length is known is now, so the
 * cut is where this has to happen rather than the compiler.
 */
export function placeLines(
  lines: ReadonlyArray<Extract<NodeOutput, { kind: "audio" }>>,
): Array<{ src: string; atSeconds: number }> {
  let cursor = 0;
  return lines.map((line) => {
    const at = line.atSeconds ?? cursor;
    // Without a measured duration the next line can only be pushed past this
    // one's stated start, which is still better than stacking them.
    cursor = Math.max(cursor, at) + DIALOGUE_GAP_SECONDS;
    return { src: line.src as string, atSeconds: at };
  });
}

/** A seconds value typed into a string field. Empty or nonsense is "unset",
 * never zero: zero is a decision, and an empty field is not one. */
function secondsParam(params: Record<string, unknown>, name: string): number | undefined {
  const raw = stringParam(params, name);
  if (!raw) return undefined;
  const value = Number.parseFloat(raw.replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
