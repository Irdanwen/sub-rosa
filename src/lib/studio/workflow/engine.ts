// Workflow execution: nodes run level by level (Kahn topological order),
// each level in parallel. Node outputs are typed, never string-tagged.
// Media chains for real only where the backend supports it (a parent image
// feeds a video node as an image_url data URI); every other cross-media edge
// degrades to a short text mention in the child's input.

import { fileResultFrom, type MediaFileResult, pollUntilDone } from "../async-job";
import { fetchMediaCatalog } from "../catalog";
import { mediaBinary, mediaJson } from "../client";
import { extractFrameAt, extractHandoffFrame } from "../frames";
import { musicPaths, retrieveBody } from "../paths";
import { maybeNodeSchema, type Workflow, type WorkflowEdge, type WorkflowNode } from "./schema";
import { validateWorkflow } from "./validator";

export type NodeOutput =
  | { kind: "text"; text: string }
  | { kind: "image"; base64: string; mimeType: string }
  // `source` tells savers which gallery bucket the audio belongs to — with
  // base64 delivery, music and speech are otherwise indistinguishable.
  | { kind: "audio"; url?: string; base64?: string; mimeType: string; source?: "music" | "speech" }
  | { kind: "video"; url: string };

export interface NodeRunResult {
  nodeId: string;
  status: "pending" | "running" | "done" | "error";
  output?: NodeOutput;
  error?: string;
}

export interface RunWorkflowOptions {
  signal?: AbortSignal;
  onUpdate?: (result: NodeRunResult) => void;
  /**
   * Turn a backend video URL into something the webview can decode, so a
   * `lastFrame` node can read a still out of it.
   *
   * Injected rather than imported: the engine stays storage-agnostic, and only
   * the caller knows where a clip should land (the gallery on both shells) and
   * which URL scheme this platform's webview can actually play. Without it,
   * `lastFrame` fails with a clear message instead of silently doing nothing.
   */
  materializeVideo?: (url: string, signal?: AbortSignal) => Promise<string>;
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

/** {{input}} substitutes upstream text; without the marker the input is
 * appended after the prompt; an empty prompt passes the input through. */
export function resolvePrompt(template: string, input: string): string {
  if (!template) return input;
  // split/join instead of replace: input may contain "$" patterns.
  if (template.includes("{{input}}")) return template.split("{{input}}").join(input);
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

function parentOutputs(
  nodeId: string,
  edges: WorkflowEdge[],
  results: Map<string, NodeRunResult>,
): NodeOutput[] {
  const outputs: NodeOutput[] = [];
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const parent = results.get(edge.source);
    if (parent?.output) outputs.push(parent.output);
  }
  return outputs;
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

async function executeNode(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  results: Map<string, NodeRunResult>,
  signal?: AbortSignal,
  materializeVideo?: RunWorkflowOptions["materializeVideo"],
): Promise<NodeOutput> {
  const params = node.params;
  const parents = parentOutputs(node.id, edges, results);
  const inputText = joinAsText(parents);

  switch (node.type) {
    case "textInput":
      return { kind: "text", text: stringParam(params, "text") ?? "" };

    case "output": {
      // Pass through: the first media output when present, else the text.
      const media = parents.find((output) => output.kind !== "text");
      return media ?? { kind: "text", text: inputText };
    }

    case "chat": {
      const prompt = resolvePrompt(stringParam(params, "prompt") ?? "", inputText);
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
      const body: Record<string, unknown> = {
        model: stringParam(params, "model") ?? "",
        prompt: resolvePrompt(stringParam(params, "prompt") ?? "", inputText),
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
      const response = await mediaJson<{ images?: unknown[] }>("/image/generate", body, signal);
      const first = response.images?.[0];
      if (typeof first !== "string" || first === "") {
        throw new Error("The image backend returned no image.");
      }
      return { kind: "image", base64: first, mimeType: "image/png" };
    }

    case "tts": {
      const format = stringParam(params, "responseFormat") ?? "mp3";
      const body: Record<string, unknown> = {
        model: stringParam(params, "model") ?? "tts-kokoro",
        input: inputText,
        speed: numberParam(params, "speed") ?? 1,
        response_format: format,
      };
      const voice = stringParam(params, "voice");
      if (voice) body.voice = voice;
      const { base64, contentType } = await mediaBinary("/audio/speech", body, signal);
      return {
        kind: "audio",
        base64,
        mimeType: contentType ?? TTS_MIME[format] ?? "audio/mpeg",
        source: "speech",
      };
    }

    case "music": {
      const model = stringParam(params, "model") ?? "";
      const body: Record<string, unknown> = {
        model,
        prompt: inputText,
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
      const queued = await mediaJson<Record<string, unknown>>(paths.queue, body, signal);
      // Carpe Diem streams the finished track as the retrieve body (one
      // shot); Venice answers JSON with an `audio_url`.
      const result = await pollUntilDone<MediaFileResult>({
        retrievePath: paths.retrieve,
        retrieveBody: retrieveBody(queueId(queued), model),
        getResult: fileResultFrom("audio_url", "url"),
        signal,
      });
      return { kind: "audio", ...result, mimeType: "audio/mpeg", source: "music" };
    }

    case "video": {
      const model = stringParam(params, "model") ?? "";
      // A parent image chains as the start frame; exclude it from the text
      // input so its "[generated image]" mention does not pollute the prompt.
      const chainedImage = parents.find(
        (output): output is Extract<NodeOutput, { kind: "image" }> => output.kind === "image",
      );
      const textInput = joinAsText(parents.filter((output) => output !== chainedImage));
      const body: Record<string, unknown> = {
        model,
        prompt: resolvePrompt(stringParam(params, "prompt") ?? "", textInput),
      };
      const duration = stringParam(params, "duration");
      if (duration) body.duration = duration;
      const aspectRatio = stringParam(params, "aspectRatio");
      if (aspectRatio) body.aspect_ratio = aspectRatio;
      const resolution = stringParam(params, "resolution");
      if (resolution) body.resolution = resolution;
      if (chainedImage) {
        body.image_url = `data:${chainedImage.mimeType};base64,${chainedImage.base64}`;
      }
      const queued = await mediaJson<Record<string, unknown>>("/video/queue", body, signal);
      const url = await pollUntilDone<string>({
        retrievePath: "/video/retrieve",
        // The video retrieve endpoint requires the model alongside the id.
        retrieveBody: retrieveBody(queueId(queued), model),
        getResult: (response) =>
          typeof response.video_url === "string" ? response.video_url : undefined,
        signal,
      });
      return { kind: "video", url };
    }

    case "lastFrame": {
      const source = parents.find(
        (output): output is Extract<NodeOutput, { kind: "video" }> => output.kind === "video",
      );
      if (!source) throw new Error("Connect a video to take a frame from.");
      if (!materializeVideo) {
        throw new Error("This runner cannot read frames out of a video.");
      }
      const src = await materializeVideo(source.url, signal);
      const position = stringParam(params, "position") ?? "handoff";
      const frame =
        position === "handoff"
          ? await extractHandoffFrame(src)
          : await extractFrameAt(src, position === "start" ? 0 : Number.MAX_SAFE_INTEGER);
      const comma = frame.dataUrl.indexOf(",");
      return {
        kind: "image",
        base64: comma >= 0 ? frame.dataUrl.slice(comma + 1) : frame.dataUrl,
        mimeType: "image/jpeg",
      };
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
    // allSettled semantics: siblings that finish keep their results even when
    // another node in the level fails.
    await Promise.all(
      level.map(async (nodeId) => {
        const node = nodeById.get(nodeId);
        if (!node) return;
        // Unknown schemas were rejected by validation; this is a type guard.
        if (!maybeNodeSchema(node.type)) return;
        update({ nodeId, status: "running" });
        try {
          const output = await executeNode(
            node,
            workflow.edges,
            results,
            options.signal,
            options.materializeVideo,
          );
          update({ nodeId, status: "done", output });
        } catch (error) {
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
  }
  return results;
}
