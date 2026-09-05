// Workflow execution: nodes run level by level (Kahn topological order),
// each level in parallel. Node outputs are typed, never string-tagged, and
// edges land on named ports — a video node's prompt, opening frame, end frame
// and references are four different inputs, not one merged stream.
//
// Media persists at the node that produced it (through the injected storage),
// carrying real provenance: the resolved prompt, the model, and — when a shot
// continues another through a lastFrame node — the parent links of ADR-0019.
// A workflow-produced chain is therefore a real chain: visible in the gallery,
// continuable by hand, and trimmed at its handoffs by the assemble node.

import { assembleClips, blobToBase64, type AssembleClip } from "../assemble";
import { DEFAULT_TARGET_LUFS } from "../loudness";
import { DIALOGUE_GAP_SECONDS } from "../mix";
import { MediaError } from "../client";
import { judge, type JudgeVerdict, verdictLine } from "../judge";
import { fileResultFrom, type MediaFileResult, pollUntilDone } from "../async-job";
import { fetchMediaCatalog } from "../catalog";
import { mediaBinary, mediaJson } from "../client";
import { composeImages } from "../edit-image";
import { generateImages } from "../generate-image";
import { extractFrameAt, extractHandoffFrame, loadVideoElement } from "../frames";
import { musicPaths, retrieveBody } from "../paths";
import { maxVideoReferences, requestSizeProblem } from "../seedance";
import type { ArtifactKind, MediaModel } from "../types";
import { videoRequestBody } from "../video-request";
import {
  maybeNodeSchema,
  nodeLabel,
  outputKindOf,
  resolveInputPort,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";
import { validateWorkflow } from "./validator";

/** A shot's link to the clip it continues (ADR-0019 parent links). */
export interface ChainRef {
  artifactId: string;
  handoffSeconds: number;
}

export type NodeOutput =
  | { kind: "text"; text: string }
  | {
      kind: "image";
      base64: string;
      mimeType: string;
      artifactId?: string;
      /** Set when the image is a handoff frame: the clip it was read from and
       * where — the video generated from it records these as parent links. */
      chainFrom?: ChainRef;
    }
  // `source` tells savers which gallery bucket the audio belongs to — with
  // base64 delivery, music and speech are otherwise indistinguishable.
  | {
      kind: "audio";
      url?: string;
      base64?: string;
      mimeType: string;
      source?: "music" | "speech";
      artifactId?: string;
      /** A URL this webview can decode (the saved gallery copy). */
      src?: string;
      /**
       * Where on the film this sound is heard, in seconds.
       *
       * Stamped by the node that knows: a line of dialogue belongs to a shot,
       * and only the node that rendered it was told which. Absent means "the
       * cut decides" - music starts at the top, dialogue is scheduled after
       * whatever came before it.
       */
      atSeconds?: number;
    }
  | {
      kind: "video";
      /** The backend delivery URL. Absent on gallery assets. */
      url?: string;
      artifactId?: string;
      /** A URL this webview can decode (the saved gallery copy). */
      src?: string;
      parentId?: string;
      parentHandoffSeconds?: number;
    };

export interface NodeRunResult {
  nodeId: string;
  /** "awaiting" is a gate holding the production for the user's approval —
   * a pause, not a failure: siblings finish, downstream stays pending. */
  status: "pending" | "running" | "done" | "error" | "awaiting";
  output?: NodeOutput;
  error?: string;
  /** 0..1, for nodes that can report it (the assemble export is real-time). */
  progress?: number;
  /** A judged gate's verdict, shown next to the hold it caused. */
  note?: string;
}

/** The gate nodes currently holding a finished-for-now run. */
export function awaitingGateIds(results: Map<string, NodeRunResult>): string[] {
  return [...results.values()]
    .filter((result) => result.status === "awaiting")
    .map((result) => result.nodeId);
}

/** Internal control flow: a gate that has no approval yet. */
class GateHold extends Error {
  /** What a judge said before the gate held, when one ran. */
  readonly note?: string;
  constructor(note?: string) {
    super("Waiting for your approval.");
    this.name = "GateHold";
    this.note = note;
  }
}

export interface SavedMedia {
  artifactId: string;
  /** A URL this webview can decode (asset protocol on desktop, blob on iOS). */
  src: string;
  /** Format recognized when the native gallery saved the returned bytes. */
  mimeType?: string;
}

export interface SaveMediaMeta {
  kind: ArtifactKind;
  model: string;
  prompt: string;
  parentId?: string;
  parentHandoffSeconds?: number;
  /** What the render was quoted or estimated at, in credits. An estimate the
   * caller priced before running, not a receipt. */
  costCredits?: number;
}

export interface LoadedAsset {
  kind: "image" | "video" | "audio";
  src: string;
  /** Image assets only: the bytes, so they can feed generation inputs. */
  base64?: string;
  mimeType?: string;
  artifactId: string;
  parentId?: string;
  parentHandoffSeconds?: number;
}

/**
 * Where produced media lands and where referenced media comes from.
 *
 * Injected rather than imported: the engine stays storage-agnostic, and only
 * the caller knows where files should land (the gallery on both shells) and
 * which URL scheme this platform's webview can actually decode. Without it,
 * nodes that need bytes (lastFrame, assemble, asset, document) fail with a
 * clear message instead of silently doing nothing.
 */
export interface WorkflowStorage {
  save(
    payload: { base64?: string; url?: string },
    extension: string,
    meta: SaveMediaMeta,
  ): Promise<SavedMedia>;
  loadAsset(artifactId: string): Promise<LoadedAsset>;
  loadNote(noteId: string): Promise<{ title: string; text: string }>;
  /**
   * A gallery item as a data URI, for the requests that must carry the bytes
   * inline (reference clips: there is nowhere to host them). Separate from
   * `loadAsset` because reading a whole clip is expensive and almost never
   * what a node needs.
   */
  readMedia(artifactId: string): Promise<string>;
}

/** What a durable render needs queued: everything Rust's job runner asks for,
 * minus the queue id it will get back. */
export interface DurableRenderRequest {
  kind: "video" | "music";
  model: string;
  prompt: string;
  extension: string;
  queuePath: string;
  queueBody: Record<string, unknown>;
  retrievePath: string;
  urlFields: string[];
  parentArtifactId?: string;
  parentHandoffSeconds?: number;
  costCredits?: number;
}

export interface RunWorkflowOptions {
  signal?: AbortSignal;
  onUpdate?: (result: NodeRunResult) => void;
  storage?: WorkflowStorage;
  /**
   * How long a node may wait out a payment rail or a capacity outage before
   * giving up. Defaults to `TRANSIENT_WAIT_BUDGET_MS`; zero disables the wait,
   * which is what a test wants.
   */
  transientWaitMs?: number;
  /** Per-node cost figures (estimates or run-time quotes), in credits, keyed
   * by node id. Stamped onto what each node saves, so a workflow-produced
   * artifact prices its chain the way a hand-run render does. */
  nodeCosts?: Record<string, number>;
  /**
   * Runs a long render as a durable media job instead of an in-webview poll:
   * queue upstream, hand the id to Rust, wait for delivery, file the artifact.
   * Injected by the durable runner (ADR-0021); without it, video and music
   * nodes poll in the webview and the run is foreground-bound.
   */
  durableMedia?: (
    nodeId: string,
    request: DurableRenderRequest,
    signal?: AbortSignal,
  ) => Promise<SavedMedia>;
  /**
   * Nodes a previous session already finished, keyed by node id. They are
   * marked done with their cached output instead of executing — what makes a
   * resumed run pick up exactly where it stopped without re-spending.
   */
  completed?: Map<string, NodeOutput>;
  /**
   * Gate approvals for THIS run, keyed by gate node id. The value picks which
   * upstream candidate passes through (a source node id), or `undefined` for
   * "the first one". A gate with no entry holds the run: its node reports
   * "awaiting", downstream stays pending, and the run returns.
   */
  approvedGates?: Map<string, string | undefined>;
}

/** Carries the per-node status map so callers keep the results of branches
 * that finished before the failure. */
export class WorkflowRunError extends Error {
  nodeId?: string;
  results: Map<string, NodeRunResult>;

  constructor(message: string, results: Map<string, NodeRunResult>, nodeId?: string) {
    super(message);
    this.name = "WorkflowRunError";
    this.results = results;
    this.nodeId = nodeId;
  }
}

/** Groups node ids into topological levels: nodes within a level share no
 * dependency and can run in parallel. Throws on cycles. */
export function topoLevels(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (!inDegree.has(edge.source) || !inDegree.has(edge.target)) continue;
    adjacency.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const levels: string[][] = [];
  let frontier = nodes.filter((node) => inDegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (frontier.length > 0) {
    levels.push(frontier);
    visited += frontier.length;
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of adjacency.get(id) ?? []) {
        const degree = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, degree);
        if (degree === 0) next.push(child);
      }
    }
    frontier = next;
  }
  if (visited !== nodes.length) {
    throw new Error("The workflow contains a cycle.");
  }
  return levels;
}

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

function stringParam(params: Record<string, unknown>, name: string): string | undefined {
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

/**
 * Upstream outputs grouped by the port each edge lands on, in edge order.
 * Edges whose port cannot be resolved were already flagged by validation;
 * here they are simply skipped.
 */
function portInputs(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  results: Map<string, NodeRunResult>,
  nodeById: Map<string, WorkflowNode>,
): Map<string, NodeOutput[]> {
  const schema = maybeNodeSchema(node.type);
  const ports = new Map<string, NodeOutput[]>();
  if (!schema) return ports;
  for (const edge of edges) {
    if (edge.target !== node.id) continue;
    const parent = nodeById.get(edge.source);
    const output = results.get(edge.source)?.output;
    if (!parent || !output) continue;
    // Resolved against the node itself, so an input its model does not carry
    // (a frame on a reference-to-video model) is dropped here rather than
    // reaching the request builder, which would send a field the model
    // ignores while still billing the render.
    const port = resolveInputPort(node, edge, outputKindOf(parent, { nodeById, edges }));
    if (!port) continue;
    const bucket = ports.get(port.id);
    if (bucket) bucket.push(output);
    else ports.set(port.id, [output]);
  }
  return ports;
}

function textInputOf(ports: Map<string, NodeOutput[]>, portId: string): string {
  return joinAsText(ports.get(portId) ?? []);
}

function imagesOn(ports: Map<string, NodeOutput[]>, portId: string) {
  return (ports.get(portId) ?? []).filter(
    (output): output is Extract<NodeOutput, { kind: "image" }> => output.kind === "image",
  );
}

function imageDataUri(image: Extract<NodeOutput, { kind: "image" }>): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

function queueId(response: Record<string, unknown>): string {
  const id = response.queue_id ?? response.id;
  if (typeof id !== "string" || id === "") {
    throw new Error("The backend did not return a job id.");
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
async function catalogModel(modelId: string): Promise<MediaModel> {
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

function requireStorage(context: NodeContext, what: string): WorkflowStorage {
  if (!context.storage) {
    throw new Error(`This runner cannot ${what}.`);
  }
  return context.storage;
}

async function executeNode(
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
      if (!artifactId) throw new Error("Pick a gallery item.");
      const asset = await requireStorage(context, "read the gallery").loadAsset(artifactId);
      if (asset.kind === "image") {
        if (!asset.base64) throw new Error("Couldn't read that image from the gallery.");
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
      if (!noteId) throw new Error("Pick a note.");
      const note = await requireStorage(context, "read notes").loadNote(noteId);
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
      const [first] = await generateImages(model, body, signal);
      if (typeof first !== "string" || first === "") {
        throw new Error("The image backend returned no image.");
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
      const sources = imagesOn(ports, "images").slice(0, 3).map(imageDataUri);
      if (sources.length === 0) throw new Error("Connect at least one image to edit.");
      // One image edits, several compose; heavy models queue on their own.
      const edited = await composeImages(model, prompt, sources);
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
      const input = textInputOf(ports, "text");
      const format = stringParam(params, "responseFormat") ?? "mp3";
      const body: Record<string, unknown> = {
        model,
        input,
        speed: numberParam(params, "speed") ?? 1,
        response_format: format,
      };
      const voice = stringParam(params, "voice");
      if (voice) body.voice = voice;
      const { base64, contentType } = await mediaBinary("/audio/speech", body, signal);
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
      const prompt = textInputOf(ports, "prompt");
      const body: Record<string, unknown> = {
        model,
        prompt,
      };
      const lyrics = stringParam(params, "lyrics");
      if (lyrics) body.lyrics_prompt = lyrics;
      const durationSeconds = numberParam(params, "durationSeconds");
      if (durationSeconds !== undefined) body.duration_seconds = durationSeconds;
      const instrumental = booleanParam(params, "instrumental");
      if (instrumental !== undefined) body.force_instrumental = instrumental;
      // Music lives under /audio/music/* on Carpe Diem but /audio/* on
      // Venice; the (cached) catalog knows which backend the key targets.
      const { backend } = await fetchMediaCatalog();
      const paths = musicPaths(backend);
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
        const clipStorage = requireStorage(context, "read reference clips");
        for (const clip of clipInputs) {
          if (!clip.artifactId) {
            throw new Error("A reference clip must come from the gallery.");
          }
          referenceVideos.push(await clipStorage.readMedia(clip.artifactId));
          // The quote only matches the queue charge when it knows the
          // combined length; an unreadable duration simply goes unreported.
          if (clip.src) referenceVideoSeconds.push(await videoDuration(clip.src));
        }
        const oversize = requestSizeProblem(referenceVideos);
        if (oversize) throw new Error(oversize);
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
        references: references.slice(0, maxVideoReferences({ id: model })).map(imageDataUri),
        referenceVideos,
        referenceVideoSeconds,
        duration: stringParam(params, "duration"),
        aspectRatio: stringParam(params, "aspectRatio"),
        resolution: stringParam(params, "resolution"),
        // A workflow runs unattended: the attestation rides on any seedance
        // render built from a photo, exactly as the studios send it.
        consent: true,
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
      if (!source) throw new Error("Connect a video to take a frame from.");
      if (!source.src) {
        throw new Error("This runner cannot read frames out of a video.");
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
      const storageForFilm = requireStorage(context, "assemble clips");
      const clips = (ports.get("clips") ?? []).filter(
        (output): output is Extract<NodeOutput, { kind: "video" }> => output.kind === "video",
      );
      if (clips.length === 0) throw new Error("Connect at least one clip.");
      const sources: AssembleClip[] = clips.map((clip, index) => {
        if (!clip.src) throw new Error("This runner cannot assemble clips.");
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
          throw new Error("This runner cannot read one of the connected sounds.");
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

    default:
      throw new Error(`Unknown node type: ${String(node.type)}.`);
  }
}

/** Runs the workflow and resolves with every node's final result. Rejects
 * with WorkflowRunError (carrying the partial results) when validation or a
 * node fails, and with an AbortError DOMException on cancellation. */
export async function runWorkflow(
  workflow: Workflow,
  options: RunWorkflowOptions = {},
): Promise<Map<string, NodeRunResult>> {
  const results = new Map<string, NodeRunResult>();
  for (const node of workflow.nodes) {
    results.set(node.id, { nodeId: node.id, status: "pending" });
  }

  const validation = validateWorkflow(workflow);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new WorkflowRunError(
      first ? first.message : "The workflow is invalid.",
      results,
      first?.nodeId,
    );
  }

  const levels = topoLevels(workflow.nodes, workflow.edges);
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const update = (result: NodeRunResult) => {
    results.set(result.nodeId, result);
    options.onUpdate?.(result);
  };

  for (const level of levels) {
    if (options.signal?.aborted) {
      throw new DOMException("The workflow run was cancelled.", "AbortError");
    }
    const failures: Array<{ nodeId: string; message: string }> = [];
    let aborted = false;
    let held = false;
    // allSettled semantics: siblings that finish keep their results even when
    // another node in the level fails.
    await Promise.all(
      level.map(async (nodeId) => {
        const node = nodeById.get(nodeId);
        if (!node) return;
        // Unknown schemas were rejected by validation; this is a type guard.
        if (!maybeNodeSchema(node.type)) return;
        // A resumed run replays finished nodes from their cached outputs
        // instead of re-executing (and re-spending) them.
        const cached = options.completed?.get(nodeId);
        if (cached) {
          update({ nodeId, status: "done", output: cached });
          return;
        }
        update({ nodeId, status: "running" });
        try {
          const ports = portInputs(node, workflow.edges, results, nodeById);
          const output =
            node.type === "gate"
              ? await gateDecision(node, workflow.edges, results, options.approvedGates, {
                  signal: options.signal,
                })
              : await withTransientTolerance(
                  () =>
                    executeNode(node, ports, {
                      signal: options.signal,
                      storage: options.storage,
                      costCredits: options.nodeCosts?.[nodeId],
                      durableMedia: options.durableMedia,
                      onProgress: (fraction) =>
                        update({ nodeId, status: "running", progress: fraction }),
                    }),
                  {
                    signal: options.signal,
                    budgetMs: options.transientWaitMs,
                    onWait: (note) => update({ nodeId, status: "running", note }),
                  },
                );
          update({ nodeId, status: "done", output });
        } catch (error) {
          if (error instanceof GateHold) {
            // Not a failure: the production is waiting for the user.
            held = true;
            update({ nodeId, status: "awaiting", note: error.note });
            return;
          }
          if (error instanceof DOMException && error.name === "AbortError") {
            // Cancellation is not a node failure; leave the node pending.
            aborted = true;
            update({ nodeId, status: "pending" });
            return;
          }
          const message = error instanceof Error ? error.message : "The node failed.";
          update({ nodeId, status: "error", error: message });
          failures.push({ nodeId, message });
        }
      }),
    );
    if (aborted || options.signal?.aborted) {
      throw new DOMException("The workflow run was cancelled.", "AbortError");
    }
    const firstFailure = failures[0];
    if (firstFailure) {
      throw new WorkflowRunError(firstFailure.message, results, firstFailure.nodeId);
    }
    // A held gate ends the run here, cleanly: what finished stays finished,
    // everything downstream stays pending, and the caller reads the awaiting
    // nodes off the results (see `awaitingGateIds`).
    if (held) return results;
  }
  return results;
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

// --- surviving a rail that flaps ---------------------------------------------

/**
 * Two upstream failures that are not the node's fault, and not the end of a
 * production.
 *
 * A `402` from the payment rail and a `503` from provider capacity both come
 * and go in windows of ten or twenty minutes. Treated as node failures they
 * kill a run that has already paid for everything before them - which is
 * exactly how a film called "Rosa - Spot" died three times in one day on the
 * remote studio this replaces. The lesson was bought once and is not being
 * bought again: temporise and retry the same node.
 *
 * Deliberately not `isAsyncRetrySignal` and not the client's own retry: those
 * are for a request that should be re-sent in seconds. This is for waiting out
 * an outage without losing the run.
 */
export function isTransientSpendFailure(error: unknown): boolean {
  if (!(error instanceof MediaError)) return false;
  return error.status === 402 || error.status === 503;
}

/**
 * How long to wait before each retry, in order.
 *
 * Fifteen seconds to two minutes, then two minutes forever until the budget of
 * patience runs out. Bounded at ten minutes rather than the half hour the
 * remote studio used: a wallet that is genuinely empty gives the same 402 as a
 * rail that is flapping, and nobody wants to watch a run wait half an hour to
 * tell them so.
 */
export const TRANSIENT_WAIT_BUDGET_MS = 10 * 60 * 1000;

export function transientDelays(budgetMs: number = TRANSIENT_WAIT_BUDGET_MS): number[] {
  const delays: number[] = [];
  let spent = 0;
  for (const delay of [15_000, 30_000, 60_000, 120_000]) {
    if (spent + delay > budgetMs) return delays;
    delays.push(delay);
    spent += delay;
  }
  while (spent + 120_000 <= budgetMs) {
    delays.push(120_000);
    spent += 120_000;
  }
  return delays;
}

/**
 * Run a node, waiting out a flapping rail rather than failing the run.
 *
 * Every other error goes straight up: a bad prompt does not get better in two
 * minutes, and retrying it four times bills it four times.
 */
export async function withTransientTolerance<T>(
  work: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    budgetMs?: number;
    onWait?: (note: string) => void;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  const delays = transientDelays(options.budgetMs ?? TRANSIENT_WAIT_BUDGET_MS);
  const sleeper = options.sleep ?? wait;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isTransientSpendFailure(error)) throw error;
      const reason =
        error instanceof MediaError && error.status === 402
          ? "The payment rail turned this down"
          : "There is no provider capacity right now";
      options.onWait?.(`${reason}. Trying again in ${Math.round(delay / 1000)}s.`);
      await sleeper(delay, options.signal);
    }
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The workflow run was cancelled.", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A gate either holds the run (no approval yet) or passes one upstream
 * candidate through untouched — parent links included, so an approved shot
 * still chains and trims like the shot it is.
 *
 * Three modes. `human` is what a gate has always been. `judged` asks a model
 * first and lets the work past on its own when the verdict clears the bar,
 * which is what makes a long production finish while nobody is watching.
 * `judged-then-human` always stops, but stops with an opinion attached.
 *
 * A judge never blocks: no model, a refusal, a timeout, an unreadable reply -
 * every one of them degrades to a plain human gate. An approval the user has
 * already given always wins, so re-running a judged gate after approving it
 * does not spend another judgement.
 */
async function gateDecision(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  results: Map<string, NodeRunResult>,
  approvedGates?: Map<string, string | undefined>,
  options?: { signal?: AbortSignal },
): Promise<NodeOutput> {
  const inbound = edges.filter((edge) => edge.target === node.id);
  const candidates = inbound
    .map((edge) => ({ source: edge.source, output: results.get(edge.source)?.output }))
    .filter(
      (candidate): candidate is { source: string; output: NodeOutput } =>
        candidate.output !== undefined,
    );

  if (!approvedGates?.has(node.id)) {
    const verdict = await gateVerdict(node, candidates, options?.signal);
    const mode = stringParam(node.params, "mode") ?? "human";
    if (verdict && mode === "judged" && verdict.passes && candidates[0]) {
      return candidates[0].output;
    }
    throw new GateHold(verdict ? verdictLine(verdict) : undefined);
  }

  const choice = approvedGates.get(node.id);
  const picked = choice
    ? candidates.find((candidate) => candidate.source === choice)
    : candidates[0];
  if (!picked) {
    throw new Error("The approved candidate has no result to pass through.");
  }
  return picked.output;
}

/** What the judge says about a gate's candidates, or nothing at all. */
async function gateVerdict(
  node: WorkflowNode,
  candidates: ReadonlyArray<{ source: string; output: NodeOutput }>,
  signal?: AbortSignal,
): Promise<JudgeVerdict | undefined> {
  const mode = stringParam(node.params, "mode") ?? "human";
  if (mode === "human") return undefined;
  const model = stringParam(node.params, "judgeModel") ?? "";
  if (!model) return undefined;
  const subjects = candidates
    .map((candidate, index) => ({
      label: `Candidate ${index + 1}`,
      imageDataUri:
        candidate.output.kind === "image"
          ? `data:${candidate.output.mimeType};base64,${candidate.output.base64}`
          : undefined,
    }))
    .filter((subject) => Boolean(subject.imageDataUri));
  if (subjects.length === 0) return undefined;
  return judge(
    {
      subjects,
      brief: stringParam(node.params, "note") || undefined,
      lens: "continuity and composition",
    },
    model,
    signal,
  );
}
