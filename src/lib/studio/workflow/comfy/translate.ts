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
// A node that is not clearly a hosted call stays out: guessing wrong would
// turn a free local step into a paid render. The importer is pure: it reads
// the file and the live catalog, and returns a workflow and its report.

import {
  defaultImageModel,
  imageEditModels,
  imageGenerationModels,
  videoDirection,
  type VideoDirection,
} from "../../catalog";
import { t } from "../../../i18n";
import type { MediaCatalog, MediaModel } from "../../types";
import { nodeTypeLabel } from "../labels";
import { modelParamPatch, modelsForParam } from "../models";
import {
  defaultParams,
  NODE_SCHEMAS,
  openInputPorts,
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

interface ComfyLink {
  from: string;
  /** What the link carries, as ComfyUI types it ("IMAGE", "STRING"...), or
   * "" when the file does not say (the API format). */
  type: string;
}

/** One Comfy node, reduced to what both file formats share. */
interface ComfyNode {
  id: string;
  type: string;
  title?: string;
  position: { x: number; y: number };
  /** 0 runs, 2 is muted, 4 is bypassed (its inputs pass straight through). */
  mode: number;
  /** Widget values by input name, without the "model." prefix. */
  values: Record<string, unknown>;
  /** Every widget value in file order, for files whose names cannot be
   * matched to positions. */
  widgets: unknown[];
  /** Linked inputs by input name. */
  links: Map<string, ComfyLink>;
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
  const rawLinks = (json.links as unknown[]) ?? [];
  const linkById = new Map<number, ComfyLink>();
  for (const link of rawLinks) {
    if (Array.isArray(link) && link.length >= 5) {
      linkById.set(Number(link[0]), { from: String(link[1]), type: String(link[5] ?? "") });
    } else if (link && typeof link === "object") {
      // Newer files write links as objects.
      const entry = link as { id?: unknown; origin_id?: unknown; type?: unknown };
      if (entry.id !== undefined && entry.origin_id !== undefined)
        linkById.set(Number(entry.id), {
          from: String(entry.origin_id),
          type: String(entry.type ?? ""),
        });
    }
  }
  return rawNodes.map((raw) => {
    const inputs = Array.isArray(raw.inputs) ? (raw.inputs as Array<Record<string, unknown>>) : [];
    const values: Record<string, unknown> = {};
    const raw_widgets = raw.widgets_values;
    const widgets = Array.isArray(raw_widgets) ? raw_widgets : [];
    if (Array.isArray(raw_widgets)) {
      // Newer files list every widget among the inputs, in the order their
      // values are stored, a seed followed by its "control after generate".
      // Older ones list only the widgets converted to inputs, so positions
      // mean nothing there: name values only when the counts agree.
      const named = inputs.filter((input) => input.widget);
      const controls = raw_widgets.filter(
        (value) => typeof value === "string" && SEED_CONTROLS.has(value),
      ).length;
      if (named.length > 0 && named.length === raw_widgets.length - controls) {
        let cursor = 0;
        for (const input of named) {
          values[shortName(String(input.name))] = raw_widgets[cursor];
          cursor += 1;
          const next = raw_widgets[cursor];
          if (typeof next === "string" && SEED_CONTROLS.has(next)) cursor += 1;
        }
      }
    } else if (raw_widgets && typeof raw_widgets === "object") {
      for (const [name, value] of Object.entries(raw_widgets)) values[shortName(name)] = value;
    }
    const links = new Map<string, ComfyLink>();
    for (const input of inputs) {
      if (input.link === null || input.link === undefined) continue;
      const source = linkById.get(Number(input.link));
      if (source)
        links.set(shortName(String(input.name)), {
          from: source.from,
          type: source.type || String(input.type ?? ""),
        });
    }
    const pos = Array.isArray(raw.pos) ? (raw.pos as number[]) : [0, 0];
    return {
      id: String(raw.id),
      type: String(raw.type),
      title: typeof raw.title === "string" ? raw.title : undefined,
      position: { x: Number(pos[0]) || 0, y: Number(pos[1]) || 0 },
      mode: Number(raw.mode) || 0,
      values,
      widgets,
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
    const links = new Map<string, ComfyLink>();
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === "number")
        links.set(shortName(name), { from: String(value[0]), type: "" });
      else values[shortName(name)] = value;
    }
    return {
      id,
      type: node.class_type,
      title: node._meta?.title,
      // The API format carries no layout: lay the nodes out in a row.
      position: { x: index * 320, y: 0 },
      mode: 0,
      values,
      widgets: [],
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

/** Plumbing a graph routes through, traversed and not reported. */
const PASS_THROUGH = new Set(["Reroute", "PrimitiveNode"]);

/** The local diffusion chain: samplers and what only they consume. */
const SAMPLERS = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
]);
const LOCAL_ONLY =
  /(Checkpoint|UNET|Unet|VAE|CLIP|Lora|LoRA|ControlNet|Latent|ModelSampling|Upscale.*Model|IPAdapter|InstantID|Conditioning|Scheduler|Guider|Guidance|RandomNoise|KSampler|Sampler|Loader|Encode|Decode|Scale|Mask)/;

/** Providers of ComfyUI's partner nodes, which call a hosted model and are
 * named after it ("KlingImage2VideoNode", "IdeogramV3", "WanTextToVideoApi"). */
const PROVIDERS = [
  "gemini",
  "google",
  "veo",
  "kling",
  "minimax",
  "hailuo",
  "pixverse",
  "runway",
  "luma",
  "bytedance",
  "seedance",
  "seedream",
  "wan",
  "vidu",
  "moonvalley",
  "openai",
  "ideogram",
  "flux",
  "recraft",
  "stability",
  "imagen",
  "sora",
];

/** A hosted partner node: named for its provider, ending the way ComfyUI
 * names them, and nothing that runs a local model. "WanImageToVideo" (local)
 * and "FluxGuidance" (local) stay out; "WanImageToVideoApi" and
 * "FluxProUltraImageNode" are in. */
function partnerProvider(type: string): string | undefined {
  if (LOCAL_ONLY.test(type)) return undefined;
  if (!/(Node|Api|API|V\d+|\d)$/.test(type)) return undefined;
  const lower = type.toLowerCase();
  return PROVIDERS.find((provider) => lower.startsWith(provider));
}

function isVideoPartner(type: string): boolean {
  return Boolean(partnerProvider(type)) && /video|veo|sora/i.test(type);
}

/** An image partner names what it makes: a chat node ("OpenAIChatNode",
 * "GeminiNode") answers in text and must never become a paid image. */
function isImagePartner(type: string): boolean {
  return (
    Boolean(partnerProvider(type)) &&
    !isVideoPartner(type) &&
    /image|ideogram|recraft|imagen|seedream|dall|kontext|flux|stable/i.test(type)
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
      if (
        word.length < 2 ||
        /^(node|api|v\d|video|image|images|to|the|model|generation|text|pro)$/.test(word)
      )
        continue;
      words.add(word);
    }
  }
  return [...words];
}

/** The catalog model sharing the most words with the hints, preferring one
 * that runs in the wanted direction. A model that shares no word is never
 * chosen: picking another provider's model would be a silent swap. */
export function pickModel(
  models: MediaModel[],
  hints: string[],
  direction?: VideoDirection,
): MediaModel | undefined {
  let best: { model: MediaModel; score: number } | undefined;
  for (const model of models.filter((entry) => !entry.offline)) {
    const id = model.id.toLowerCase();
    const name = model.name.toLowerCase();
    let score = 0;
    for (const hint of hints) if (id.includes(hint) || name.includes(hint)) score += hint.length;
    if (score === 0) continue;
    if (direction && isVideo(model) && videoDirection(model) === direction) score += 1;
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

/** A named widget's string value, else the best guess from the raw widget
 * list: the longest string for a prompt. */
function promptOf(node: ComfyNode, names: string[]): string {
  for (const name of names) {
    const value = node.values[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  const strings = node.widgets.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return strings.sort((a, b) => b.length - a.length)[0] ?? "";
}

/** A named widget's value, else the first raw widget that looks like one. */
function settingOf(node: ComfyNode, name: string, shape: RegExp): string {
  const value = node.values[name];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  const found = node.widgets.find((entry) => typeof entry === "string" && shape.test(entry));
  return typeof found === "string" ? found : "";
}

const RATIO = /^\d+(\.\d+)?:\d+(\.\d+)?$/;
const RESOLUTION = /^\d+(p|K|k)$/;

// --- The translation ------------------------------------------------------

interface Built {
  node: WorkflowNode;
  /** Which native port a Comfy input lands on, given what its link carries;
   * undefined leaves the link out. */
  portFor: (input: string, linkType: string) => string | undefined;
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
  /** Text encoders a sampler took as its prompts: folded into its node. */
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
    report.translated.push({ comfyType: source.type, as: nodeTypeLabel(type) });
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

  const drop = (source: ComfyNode, reason: string) =>
    report.dropped.push({ comfyType: source.title || source.type, reason });

  for (const source of comfy) {
    if (source.mode === 2) {
      drop(source, t("is muted in the file"));
      continue;
    }
    if (source.mode === 4) {
      // Bypassed: its inputs reach its outputs, which the edge pass follows.
      drop(source, t("is bypassed in the file"));
      continue;
    }
    if (source.type === "PrimitiveNode" && typeof source.widgets[0] === "string") {
      // An older file's shared prompt: a primitive holding text feeds the
      // nodes whose prompt was converted to an input.
      make(source, "textInput", { text: source.widgets[0] });
      continue;
    }
    if (PASS_THROUGH.has(source.type)) continue;
    if (NOTES.has(source.type)) {
      const body = promptOf(source, ["text", "value"]);
      if (body.trim()) notes.push(body.trim());
      continue;
    }
    const loaded = LOADERS[source.type];
    if (loaded) {
      const fileName = settingOf(source, loaded, /\.\w{2,5}$/) || promptOf(source, ["file"]);
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
      make(source, "textInput", { text: promptOf(source, ["value", "text", "string"]) });
      continue;
    }
    if (isVideoPartner(source.type)) {
      const linkedImage = [...source.links.entries()].some(
        ([name, link]) => link.type === "IMAGE" || /image|frame/i.test(name),
      );
      const task = settingOf(source, "task_type", /_to_/).toLowerCase();
      const direction: VideoDirection = task.includes("reference")
        ? "reference"
        : task.includes("image") || linkedImage
          ? "image"
          : "text";
      const hints = modelHints(
        source.type,
        source.values.model,
        source.values.model_name,
        partnerProvider(source.type),
      );
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
        prompt: promptOf(source, ["prompt", "text"]),
        aspectRatio: settingOf(source, "aspect_ratio", RATIO),
        resolution: settingOf(source, "resolution", RESOLUTION),
        duration: String(
          source.values.duration ?? source.values.duration_seconds ?? source.values.length ?? "",
        ),
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
      if (source.values.seed !== undefined)
        report.adjusted.push(t("The seed is not kept: hosted video models choose their own."));
      const node = make(source, "video", params);
      const open = new Set(openInputPorts(NODE_SCHEMAS.video, node.params).map((port) => port.id));
      built.set(source.id, {
        node,
        portFor: (input, linkType) => {
          if (/negative/i.test(input)) return undefined;
          const kind = linkType || (/image|frame/i.test(input) ? "IMAGE" : "");
          const port =
            kind === "VIDEO"
              ? "referenceClips"
              : kind === "AUDIO"
                ? "referenceAudio"
                : kind === "IMAGE"
                  ? /end|last/i.test(input)
                    ? "endFrame"
                    : open.has("openingFrame")
                      ? "openingFrame"
                      : "references"
                  : kind === "STRING" || /prompt|text/i.test(input)
                    ? "prompt"
                    : undefined;
          if (port && !open.has(port)) {
            report.adjusted.push(
              t("{model} takes no {input}: that link is left out.", {
                model: model?.name ?? t("this model"),
                input,
              }),
            );
            return undefined;
          }
          return port;
        },
      });
      continue;
    }
    if (isImagePartner(source.type)) {
      const linkedImage = [...source.links.entries()].some(
        ([name, link]) => link.type === "IMAGE" || /image/i.test(name),
      );
      const type: WorkflowNodeType = linkedImage ? "imageEdit" : "image";
      const models = linkedImage ? imageEditModels(catalog) : imageGenerationModels(catalog);
      const model = pickModel(
        models,
        modelHints(source.type, source.values.model, partnerProvider(source.type)),
      );
      if (!model)
        report.adjusted.push(
          t("No hosted model matches {node}: pick one on the image node.", { node: source.type }),
        );
      const params = withModel(
        type,
        {
          prompt: promptOf(source, ["prompt", "text"]),
          aspectRatio: settingOf(source, "aspect_ratio", RATIO),
          ...(type === "image"
            ? {
                negativePrompt:
                  typeof source.values.negative_prompt === "string"
                    ? source.values.negative_prompt
                    : "",
              }
            : {}),
        },
        model,
      );
      make(source, type, params, (input, linkType) => {
        if (/negative/i.test(input) || /mask/i.test(input)) return undefined;
        const kind = linkType || (/image/i.test(input) ? "IMAGE" : "");
        if (kind === "IMAGE") return type === "imageEdit" ? "images" : undefined;
        if (kind === "STRING" || /prompt|text/i.test(input)) return "prompt";
        return undefined;
      });
      continue;
    }
    if (SAMPLERS.has(source.type)) {
      // A local diffusion run, rebuilt as one hosted image render.
      const encoderText = (input: string) => {
        const link = source.links.get(input);
        const upstream = link ? byId.get(link.from) : undefined;
        if (!upstream) return "";
        absorbed.add(upstream.id);
        return promptOf(upstream, ["text"]);
      };
      const positive = encoderText("positive");
      const negative = encoderText("negative");
      const model = defaultImageModel(catalog);
      const params = withModel("image", { prompt: positive, negativePrompt: negative }, model);
      report.adjusted.push(
        t(
          "{node} ran a model on a local graphics card: rebuilt as one image from {model} with the same prompts.",
          { node: source.type, model: model?.name ?? t("a hosted model") },
        ),
      );
      make(source, "image", params);
      continue;
    }
    if (source.type === "CLIPTextEncode") continue; // decided once the samplers are known
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(source.type)) {
      drop(source, t("is a group of nodes, which Sub Rosa does not open"));
      continue;
    }
    drop(
      source,
      LOCAL_ONLY.test(source.type)
        ? t("runs a model on a local graphics card, which Sub Rosa does not do")
        : partnerProvider(source.type) ||
            PROVIDERS.some((p) => source.type.toLowerCase().startsWith(p))
          ? t("calls a hosted model Sub Rosa does not know yet")
          : t("has no counterpart in Sub Rosa"),
    );
  }

  // A prompt encoder feeding a sampler is that image node's prompt already;
  // one feeding nothing translated is left out, said once.
  for (const source of comfy) {
    if (source.type !== "CLIPTextEncode" || absorbed.has(source.id) || source.mode !== 0) continue;
    drop(source, t("encodes a prompt for a local model"));
  }

  // Edges: a link between two translated nodes lands on the target's port. A
  // link from a node that did not translate is followed upstream until it
  // reaches one that did (a VAE decode between a sampler and a save, a
  // bypassed node, a reroute).
  const edges: WorkflowEdge[] = [];
  const seen = new Set<string>();
  const upstreamBuilt = (id: string, guard = new Set<string>()): Built | undefined => {
    if (guard.has(id)) return undefined;
    guard.add(id);
    const direct = built.get(id);
    if (direct) return direct;
    const node = byId.get(id);
    if (!node || (node.mode === 2 && !PASS_THROUGH.has(node.type))) return undefined;
    for (const link of node.links.values()) {
      const found = upstreamBuilt(link.from, guard);
      if (found) return found;
    }
    return undefined;
  };
  /** Ports that take one link and already have it. */
  const filled = new Set<string>();
  for (const target of comfy) {
    const to = built.get(target.id);
    if (!to || SAMPLERS.has(target.type)) continue; // a sampler's prompts are folded in
    for (const [input, link] of target.links) {
      const from = upstreamBuilt(link.from);
      if (!from || from === to) continue;
      const port = to.portFor(input, link.type || kindOf(from.node.type, byId.get(link.from)));
      if (!port) continue;
      const key = `${from.node.id}>${to.node.id}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const single = NODE_SCHEMAS[to.node.type].inputs.find((entry) => entry.id === port);
      if (single && !single.multi) {
        if (filled.has(`${to.node.id}:${port}`)) {
          report.adjusted.push(
            t("{node} takes one {input}: the extra link is left out.", {
              node: nodeTypeLabel(to.node.type),
              input,
            }),
          );
          continue;
        }
        filled.add(`${to.node.id}:${port}`);
      }
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

/** What a link carries when the file does not say (the API format), from the
 * native node it comes from. */
function kindOf(nativeType: WorkflowNodeType, source: ComfyNode | undefined): string {
  if (nativeType === "video") return "VIDEO";
  if (nativeType === "image" || nativeType === "imageEdit") return "IMAGE";
  if (nativeType === "textInput") return "STRING";
  if (nativeType === "asset" && source) {
    const kind = LOADERS[source.type];
    return kind === "video" ? "VIDEO" : kind === "audio" ? "AUDIO" : "IMAGE";
  }
  return "";
}
