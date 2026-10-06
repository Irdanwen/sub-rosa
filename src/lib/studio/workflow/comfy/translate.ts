// A ComfyUI workflow, translated into a native one (ADR-0075).
//
// ComfyUI runs graphs of nodes; most of them load and sample a model on the
// person's own GPU (checkpoints, samplers, VAEs, LoRAs), which Sub Rosa never
// does: every model it runs is hosted. What translates is what a hosted model
// can do: loading a picture, writing a prompt, the partner nodes that call a
// hosted image or video model, and saving the result. A local diffusion chain
// (a sampler fed by text prompts) is rebuilt as one hosted image node with the
// same prompts, and said so.
//
// Nothing is dropped in silence: every node lands in the report as
// translated, adjusted or left out, with the reason, before anything is saved.
// The importer is pure: it reads the file and the live catalog, and returns a
// workflow and its report.

import {
  imageEditModels,
  imageGenerationModels,
  videoDirection,
  type VideoDirection,
} from "../../catalog";
import { t } from "../../../i18n";
import type { MediaCatalog, MediaModel } from "../../types";
import { modelParamPatch, modelsForParam } from "../models";
import {
  defaultParams,
  NODE_SCHEMAS,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../schema";

/** The shapes a workflow file can come in. */
export type WorkflowFileFormat = "comfy-ui" | "comfy-api" | "subrosa" | "unknown";

export interface ImportReport {
  /** Comfy nodes that became native nodes. */
  translated: Array<{ comfyType: string; as: string }>;
  /** What was changed to fit (a model, a frame, a resolution). */
  adjusted: string[];
  /** Comfy nodes with no native counterpart, and why. */
  dropped: Array<{ comfyType: string; reason: string }>;
  /** Pictures, clips or sounds the file names but does not carry. */
  missing: string[];
}

export interface ComfyImport {
  workflow: Omit<Workflow, "id" | "createdAt" | "updatedAt">;
  report: ImportReport;
  /** False when nothing in the file makes anything: no reason to import it. */
  usable: boolean;
}

/** One Comfy node, reduced to what both file formats share. */
interface ComfyNode {
  id: string;
  type: string;
  title?: string;
  position: { x: number; y: number };
  /** Widget values by input name, without the "model." prefix. */
  values: Record<string, unknown>;
  /** Linked inputs: input name -> [source node id, source slot]. */
  links: Map<string, [string, number]>;
}

export function detectWorkflowFile(json: unknown): WorkflowFileFormat {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "unknown";
  const record = json as Record<string, unknown>;
  if (record.format === "subrosa-workflow") return "subrosa";
  if (Array.isArray(record.nodes) && Array.isArray(record.links)) return "comfy-ui";
  const entries = Object.values(record);
  if (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { class_type?: unknown }).class_type === "string",
    )
  )
    return "comfy-api";
  return "unknown";
}

// --- Reading both Comfy formats -------------------------------------------

const SEED_CONTROLS = new Set(["fixed", "increment", "decrement", "randomize"]);

function shortName(name: string): string {
  return name.replace(/^model\./, "").replace(/^images\./, "");
}

function readUiFormat(json: Record<string, unknown>): ComfyNode[] {
  const rawNodes = (json.nodes as Array<Record<string, unknown>>) ?? [];
  const rawLinks = (json.links as unknown[][]) ?? [];
  const linkById = new Map<number, [string, number]>();
  for (const link of rawLinks) {
    if (!Array.isArray(link) || link.length < 5) continue;
    linkById.set(Number(link[0]), [String(link[1]), Number(link[2])]);
  }
  return rawNodes.map((raw) => {
    const inputs = Array.isArray(raw.inputs) ? (raw.inputs as Array<Record<string, unknown>>) : [];
    const values: Record<string, unknown> = {};
    const widgetValues = raw.widgets_values;
    if (Array.isArray(widgetValues)) {
      // Widget inputs are listed in the order their values are stored; a
      // seed is followed by its "control after generate" value.
      let cursor = 0;
      const widgets = inputs.filter((input) => input.widget);
      if (widgets.length > 0) {
        for (const input of widgets) {
          const name = shortName(String(input.name));
          values[name] = widgetValues[cursor];
          cursor += 1;
          if (
            typeof widgetValues[cursor] === "string" &&
            SEED_CONTROLS.has(widgetValues[cursor] as string)
          )
            cursor += 1;
        }
      } else {
        values._widgets = widgetValues;
      }
    } else if (widgetValues && typeof widgetValues === "object") {
      for (const [name, value] of Object.entries(widgetValues)) values[shortName(name)] = value;
    }
    const links = new Map<string, [string, number]>();
    for (const input of inputs) {
      if (input.link === null || input.link === undefined) continue;
      const source = linkById.get(Number(input.link));
      if (source) links.set(shortName(String(input.name)), source);
    }
    const pos = Array.isArray(raw.pos) ? (raw.pos as number[]) : [0, 0];
    return {
      id: String(raw.id),
      type: String(raw.type),
      title: typeof raw.title === "string" ? raw.title : undefined,
      position: { x: Number(pos[0]) || 0, y: Number(pos[1]) || 0 },
      values,
      links,
    };
  });
}

function readApiFormat(json: Record<string, unknown>): ComfyNode[] {
  return Object.entries(json).map(([id, raw], index) => {
    const node = raw as {
      class_type: string;
      inputs?: Record<string, unknown>;
      _meta?: { title?: string };
    };
    const values: Record<string, unknown> = {};
    const links = new Map<string, [string, number]>();
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === "number")
        links.set(shortName(name), [String(value[0]), value[1]]);
      else values[shortName(name)] = value;
    }
    return {
      id,
      type: node.class_type,
      title: node._meta?.title,
      // The API format carries no layout: lay the nodes out in a row.
      position: { x: index * 320, y: 0 },
      values,
      links,
    };
  });
}

// --- What each Comfy node becomes ------------------------------------------

const LOADERS: Record<string, "image" | "video" | "audio"> = {
  LoadImage: "image",
  LoadImageMask: "image",
  LoadVideo: "video",
  VHS_LoadVideo: "video",
  LoadAudio: "audio",
  VHS_LoadAudio: "audio",
};

const SAVERS = new Set([
  "SaveImage",
  "PreviewImage",
  "SaveVideo",
  "PreviewVideo",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
  "VHS_VideoCombine",
  "SaveAudio",
  "PreviewAudio",
  "SaveWEBM",
]);

const TEXTS = new Set([
  "PrimitiveString",
  "PrimitiveStringMultiline",
  "String Literal",
  "StringConstant",
  "StringConstantMultiline",
  "Text Multiline",
]);

const NOTES = new Set(["MarkdownNote", "Note"]);

/** The local diffusion chain: samplers and what only they consume. */
const SAMPLERS = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
]);
const LOCAL_ONLY =
  /^(Checkpoint|UNET|Unet|VAE|CLIP(?!TextEncode)|Lora|ControlNet|EmptyLatent|EmptySD3Latent|Latent|ModelSampling|Upscale.*Model|IPAdapter|InstantID|Conditioning|BasicScheduler|BasicGuider|RandomNoise|KSamplerSelect|CFGGuider|DualCLIP|Flux(Guidance)|DiffusersLoader)/;

const PROVIDERS = [
  "gemini",
  "veo",
  "kling",
  "minimax",
  "hailuo",
  "pixverse",
  "runway",
  "luma",
  "seedance",
  "bytedance",
  "wan",
  "vidu",
  "moonvalley",
  "sora",
  "openai",
  "ideogram",
  "flux",
  "recraft",
  "stability",
  "gpt",
  "imagen",
  "qwen",
  "seedream",
];

function isVideoPartner(type: string): boolean {
  return /video/i.test(type) && PROVIDERS.some((provider) => type.toLowerCase().includes(provider));
}

function isImagePartner(type: string): boolean {
  return (
    !/video/i.test(type) &&
    /(image|ideogram|flux|recraft|stability|imagen|seedream)/i.test(type) &&
    PROVIDERS.some((provider) => type.toLowerCase().includes(provider))
  );
}

/** The words a model id is likely to share with a Comfy node and its model
 * widget: "GeminiVideoOmniV2" + "Omni Flash 1.1" -> gemini, omni, flash, 1-1. */
export function modelHints(...sources: unknown[]): string[] {
  const words = new Set<string>();
  for (const source of sources) {
    if (typeof source !== "string") continue;
    const spaced = source
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/(\d)\.(\d)/g, "$1-$2")
      .toLowerCase();
    for (const word of spaced.split(/[^a-z0-9-]+/)) {
      if (word.length < 2 || /^(node|api|v\d|video|image|to|the|model|generation|text)$/.test(word))
        continue;
      words.add(word);
    }
  }
  return [...words];
}

/** The catalog model that shares the most words with the hints, preferring
 * one that runs in the wanted direction. */
export function pickModel(
  models: MediaModel[],
  hints: string[],
  direction?: VideoDirection,
): MediaModel | undefined {
  const live = models.filter((model) => !model.offline);
  let best: { model: MediaModel; score: number } | undefined;
  for (const model of live) {
    const id = model.id.toLowerCase();
    const name = model.name.toLowerCase();
    let score = 0;
    for (const hint of hints) if (id.includes(hint) || name.includes(hint)) score += hint.length;
    if (direction && isVideo(model) && videoDirection(model) === direction) score += 1;
    if (score === 0) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && model.id.length < best.model.id.length)
    )
      best = { model, score };
  }
  return best?.model;
}

function isVideo(model: MediaModel): boolean {
  return (
    model.mediaType === "video" ||
    model.mediaType === "imageToVideo" ||
    model.mediaType === "referenceToVideo"
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(values: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = values[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  const widgets = values._widgets;
  if (Array.isArray(widgets)) {
    const found = widgets.find((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof found === "string") return found;
  }
  return "";
}

// --- The translation ------------------------------------------------------

interface Built {
  node: WorkflowNode;
  /** Which native port a Comfy input name lands on. */
  portFor: (input: string, sourceKind: string) => string | undefined;
}

export function translateComfy(json: unknown, catalog: MediaCatalog): ComfyImport {
  const format = detectWorkflowFile(json);
  const comfy =
    format === "comfy-ui"
      ? readUiFormat(json as Record<string, unknown>)
      : format === "comfy-api"
        ? readApiFormat(json as Record<string, unknown>)
        : [];
  const report: ImportReport = { translated: [], adjusted: [], dropped: [], missing: [] };
  const notes: string[] = [];
  const built = new Map<string, Built>();
  const byId = new Map(comfy.map((node) => [node.id, node]));
  /** Text nodes a sampler took as its negative prompt: folded into the
   * image node, not kept as a second prompt. */
  const absorbed = new Set<string>();

  const make = (
    source: ComfyNode,
    type: WorkflowNodeType,
    params: Record<string, unknown>,
    portFor: Built["portFor"] = () => undefined,
  ) => {
    const node: WorkflowNode = {
      id: crypto.randomUUID(),
      type,
      label: source.title && source.title !== source.type ? source.title : "",
      position: source.position,
      params: { ...defaultParams(type), ...params },
    };
    built.set(source.id, { node, portFor });
    report.translated.push({ comfyType: source.type, as: NODE_SCHEMAS[type].label });
    return node;
  };

  const withModel = (
    type: WorkflowNodeType,
    params: Record<string, unknown>,
    model: MediaModel | undefined,
  ) => {
    const schema = NODE_SCHEMAS[type];
    const modelParam = schema.params.find((param) => param.name === "model");
    if (!modelParam || !model) return params;
    return { ...params, ...modelParamPatch(schema, params, modelParam, model) };
  };

  for (const source of comfy) {
    if (NOTES.has(source.type)) {
      const body = firstString(source.values, ["text", "value"]);
      if (body.trim()) notes.push(body.trim());
      continue;
    }
    const loaded = LOADERS[source.type];
    if (loaded) {
      const fileName = firstString(source.values, ["image", "video", "audio", "file"]);
      if (fileName) report.missing.push(fileName);
      const node = make(source, "asset", { assetKind: loaded, artifactId: "" });
      if (fileName && !node.label) node.label = fileName;
      continue;
    }
    if (SAVERS.has(source.type)) {
      make(source, "output", {}, () => "in");
      continue;
    }
    if (TEXTS.has(source.type)) {
      make(source, "textInput", { text: firstString(source.values, ["value", "text", "string"]) });
      continue;
    }
    if (isVideoPartner(source.type)) {
      const values = source.values;
      const linkedImage = [...source.links.keys()].some((name) => /image|frame/i.test(name));
      const task = text(values.task_type).toLowerCase();
      const direction: VideoDirection = task.includes("reference")
        ? "reference"
        : task.includes("image") || linkedImage
          ? "image"
          : "text";
      const hints = modelHints(source.type, values.model, values.model_name);
      const candidates = modelsForParam(catalog, {
        name: "model",
        type: "model",
        label: "",
        mediaTypes: ["video", "imageToVideo", "referenceToVideo"],
      });
      const model = pickModel(candidates, hints, direction);
      if (!model)
        report.adjusted.push(
          t("No hosted model matches {node}: pick one on the video node.", { node: source.type }),
        );
      else if (videoDirection(model) !== direction)
        report.adjusted.push(
          t("{model} is the closest hosted model, but it does not start from the same input.", {
            model: model.name,
          }),
        );
      const wanted: Record<string, unknown> = {
        prompt: firstString(values, ["prompt", "text"]),
        aspectRatio: text(values.aspect_ratio),
        resolution: text(values.resolution),
        duration: String(values.duration ?? values.duration_seconds ?? values.length ?? ""),
      };
      const params = withModel("video", wanted, model);
      for (const key of ["aspectRatio", "resolution"] as const) {
        if (wanted[key] && params[key] !== wanted[key])
          report.adjusted.push(
            t("{wanted} is not offered by {model}: {used} instead.", {
              wanted: String(wanted[key]),
              model: model?.name ?? t("this model"),
              used: String(params[key] || t("its default")),
            }),
          );
      }
      if (values.seed !== undefined)
        report.adjusted.push(t("The seed is not kept: hosted video models choose their own."));
      make(source, "video", params, (input, kind) => {
        if (kind === "VIDEO" || /video/i.test(input)) return "referenceClips";
        if (kind === "AUDIO" || /audio/i.test(input)) return "referenceAudio";
        if (/end|last/i.test(input)) return "endFrame";
        if (kind === "IMAGE" || /image|frame/i.test(input))
          return (model ? videoDirection(model) : direction) === "reference"
            ? "references"
            : "openingFrame";
        return "prompt";
      });
      continue;
    }
    if (isImagePartner(source.type)) {
      const linkedImage = [...source.links.keys()].some((name) => /image/i.test(name));
      const type: WorkflowNodeType = linkedImage ? "imageEdit" : "image";
      const models = linkedImage ? imageEditModels(catalog) : imageGenerationModels(catalog);
      const model = pickModel(models, modelHints(source.type, source.values.model));
      if (!model)
        report.adjusted.push(
          t("No hosted model matches {node}: pick one on the image node.", { node: source.type }),
        );
      const params = withModel(
        type,
        {
          prompt: firstString(source.values, ["prompt", "text"]),
          aspectRatio: text(source.values.aspect_ratio),
          ...(type === "image" ? { negativePrompt: text(source.values.negative_prompt) } : {}),
        },
        model,
      );
      make(source, type, params, (input, kind) =>
        kind === "IMAGE" || /image/i.test(input)
          ? type === "imageEdit"
            ? "images"
            : undefined
          : "prompt",
      );
      continue;
    }
    if (SAMPLERS.has(source.type)) {
      // A local diffusion run, rebuilt as one hosted image render.
      const promptOf = (input: string) => {
        const link = source.links.get(input);
        const upstream = link ? byId.get(link[0]) : undefined;
        if (!upstream) return { text: "", id: undefined };
        return { text: firstString(upstream.values, ["text"]), id: upstream.id };
      };
      const positive = promptOf("positive");
      const negative = promptOf("negative");
      if (negative.id) absorbed.add(negative.id);
      const model =
        pickModel(imageGenerationModels(catalog), []) ?? imageGenerationModels(catalog)[0];
      const params = withModel(
        "image",
        { prompt: positive.text, negativePrompt: negative.text },
        model,
      );
      report.adjusted.push(
        t(
          "{node} ran a model on a local graphics card: rebuilt as one image from {model} with the same prompts.",
          {
            node: source.type,
            model: model?.name ?? t("a hosted model"),
          },
        ),
      );
      make(source, "image", params, () => "prompt");
      continue;
    }
    if (source.type === "CLIPTextEncode") continue; // decided once the samplers are known
    report.dropped.push({
      comfyType: source.type,
      reason: LOCAL_ONLY.test(source.type)
        ? t("runs a model on a local graphics card, which Sub Rosa does not do")
        : t("has no counterpart in Sub Rosa"),
    });
  }

  // A prompt encoder feeding a sampler's positive input is that image node's
  // prompt already; one feeding nothing else is left out, said once.
  for (const source of comfy) {
    if (source.type !== "CLIPTextEncode") continue;
    const feedsSampler = comfy.some(
      (other) =>
        SAMPLERS.has(other.type) && [...other.links.values()].some(([from]) => from === source.id),
    );
    if (feedsSampler || absorbed.has(source.id)) continue;
    report.dropped.push({
      comfyType: source.type,
      reason: t("encodes a prompt for a local model"),
    });
  }

  // Edges: a link between two translated nodes lands on the target's port. A
  // link from a node that did not translate is followed upstream until it
  // reaches one that did (a VAE decode between a sampler and a save).
  const edges: WorkflowEdge[] = [];
  const seen = new Set<string>();
  const upstreamBuilt = (id: string, guard = new Set<string>()): Built | undefined => {
    if (guard.has(id)) return undefined;
    guard.add(id);
    const direct = built.get(id);
    if (direct) return direct;
    const node = byId.get(id);
    if (!node) return undefined;
    for (const [from] of node.links.values()) {
      const found = upstreamBuilt(from, guard);
      if (found) return found;
    }
    return undefined;
  };
  for (const target of comfy) {
    const to = built.get(target.id);
    if (!to) continue;
    for (const [input, [fromId]] of target.links) {
      if (SAMPLERS.has(target.type)) continue; // its prompts are folded in
      const from = upstreamBuilt(fromId);
      if (!from || from === to) continue;
      const fromNode = byId.get(fromId);
      const kind = kindOfComfyOutput(fromNode, from.node.type);
      const port = to.portFor(input, kind);
      if (!port) continue;
      const key = `${from.node.id}>${to.node.id}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: crypto.randomUUID(),
        source: from.node.id,
        target: to.node.id,
        targetPort: port,
      });
    }
  }

  const nodes = [...built.values()].map((entry) => entry.node);
  const usable = nodes.some((node) => ["image", "imageEdit", "video"].includes(node.type));
  return {
    workflow: { name: "", description: notes.join("\n\n") || undefined, nodes, edges },
    report,
    usable,
  };
}

/** What a Comfy link carries, for picking the port it lands on. */
function kindOfComfyOutput(source: ComfyNode | undefined, nativeType: WorkflowNodeType): string {
  if (nativeType === "video") return "VIDEO";
  if (nativeType === "image" || nativeType === "imageEdit") return "IMAGE";
  if (nativeType === "textInput") return "STRING";
  if (nativeType === "asset" && source) {
    const kind = LOADERS[source.type];
    return kind === "video" ? "VIDEO" : kind === "audio" ? "AUDIO" : "IMAGE";
  }
  return "STRING";
}
