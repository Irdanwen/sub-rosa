// Declarative node schemas for Studio workflows. This is the single source of
// truth consumed by the validator, the default-params factory, and the UI
// (param forms, connection hints). The data model is deliberately UI-agnostic:
// no React Flow types leak in here, only plain ids and positions.
//
// Nodes expose *named input ports*. A port is typed (text, image, audio,
// video, any) and edges land on a specific port, which is what makes a video
// node's opening frame, its references, and its prompt three different things
// to connect to. Edges saved before ports existed carry no `targetPort`; they
// resolve by kind affinity (see `resolveInputPort`), which preserves the old
// behavior — an image feeding a video node still becomes its start frame.

import { maxReferenceVideos, maxVideoReferences } from "../seedance";

export type WorkflowNodeType =
  | "textInput"
  | "asset"
  | "document"
  | "chat"
  | "image"
  | "imageEdit"
  | "tts"
  | "music"
  | "video"
  | "lastFrame"
  | "gate"
  | "assemble"
  | "output";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** The input port this edge lands on. Absent on edges saved before ports
   * existed (and on mobile's linear chains); resolved by kind affinity. */
  targetPort?: string;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
}

export type IOKind = "text" | "image" | "audio" | "video" | "none";

/** What a port consumes. "any" accepts every kind (the output node). */
export type PortKind = Exclude<IOKind, "none"> | "any";

export interface InputPort {
  id: string;
  label: string;
  kind: PortKind;
  /** Accepts several inbound edges (an assemble node's clips, references). */
  multi?: boolean;
  /**
   * Cap on inbound edges when `multi`, as the schema knows it. Some caps are
   * really per model (seedance 2.0 takes 9 reference photos, 2.5 takes 30),
   * so `maxFor` refines this one against the node's chosen model; the schema
   * value stays the ceiling any model may reach.
   */
  max?: number;
  /** Refines `max` from the node's params (its model, chiefly). */
  maxFor?: (params: Record<string, unknown>) => number;
  /** The node cannot run without this port connected. */
  required?: boolean;
}

/** The effective cap of a port for one node: the schema's, refined per model. */
export function portCapacity(port: InputPort, params: Record<string, unknown>): number | undefined {
  if (!port.multi) return 1;
  const refined = port.maxFor?.(params);
  if (refined !== undefined) return refined;
  return port.max;
}

export interface ParamSchema {
  name: string;
  type: "string" | "text" | "number" | "boolean" | "enum" | "model" | "artifact" | "note";
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enumValues?: string[];
  min?: number;
  max?: number;
  step?: number;
  /** For "model" params: which catalog media type to pick the model from. */
  mediaType?: string;
  /** For "model" params spanning several catalog types (a video model can be
   * text-to-video, image-to-video, or reference-to-video). Overrides
   * `mediaType` when present. */
  mediaTypes?: string[];
}

export interface NodeSchema {
  type: WorkflowNodeType;
  label: string;
  description: string;
  inputs: InputPort[];
  output: IOKind;
  params: ParamSchema[];
}

/** The conventional single text port most generators read their prompt from. */
const PROMPT_PORT: InputPort = { id: "prompt", label: "Prompt", kind: "text", multi: true };

export const NODE_SCHEMAS: Record<WorkflowNodeType, NodeSchema> = {
  textInput: {
    type: "textInput",
    label: "Text input",
    description: "Static text written by the user. The starting point of a workflow.",
    inputs: [],
    output: "text",
    params: [{ name: "text", type: "text", label: "Text", required: true, default: "" }],
  },
  asset: {
    type: "asset",
    label: "Asset",
    description:
      "An item from your gallery: a reference image, a clip, or a track. Connect it to every scene that should use it.",
    inputs: [],
    output: "image",
    params: [
      {
        name: "assetKind",
        type: "enum",
        label: "Kind",
        enumValues: ["image", "video", "audio"],
        default: "image",
      },
      { name: "artifactId", type: "artifact", label: "Gallery item", required: true },
    ],
  },
  document: {
    type: "document",
    label: "Document",
    description:
      "The content of one of your notes, as text. Use it as a brief, a script, or art direction other nodes read from.",
    inputs: [],
    output: "text",
    params: [{ name: "noteId", type: "note", label: "Note", required: true }],
  },
  chat: {
    type: "chat",
    label: "Chat",
    description: "Run a chat completion. Upstream text feeds the prompt.",
    inputs: [PROMPT_PORT],
    output: "text",
    params: [
      { name: "model", type: "model", label: "Model", required: true, mediaType: "text" },
      {
        name: "prompt",
        type: "text",
        label: "Prompt",
        description: "Use {{input}} to place upstream text, or leave the marker out to append it.",
        required: true,
        default: "",
      },
      {
        name: "temperature",
        type: "number",
        label: "Temperature",
        default: 0.7,
        min: 0,
        max: 2,
        step: 0.1,
      },
      { name: "maxTokens", type: "number", label: "Max tokens", default: 2048, min: 1 },
    ],
  },
  image: {
    type: "image",
    label: "Image",
    description: "Generate an image from a text prompt.",
    inputs: [PROMPT_PORT],
    output: "image",
    params: [
      { name: "model", type: "model", label: "Model", required: true, mediaType: "image" },
      {
        name: "prompt",
        type: "text",
        label: "Prompt",
        description: "Use {{input}} to place upstream text, or leave the marker out to append it.",
        required: true,
        default: "",
      },
      { name: "negativePrompt", type: "text", label: "Negative prompt", default: "" },
      { name: "aspectRatio", type: "string", label: "Aspect ratio", default: "" },
      { name: "stylePreset", type: "string", label: "Style preset", default: "" },
      { name: "hideWatermark", type: "boolean", label: "Hide watermark", default: true },
    ],
  },
  imageEdit: {
    type: "imageEdit",
    label: "Image edit",
    description:
      "Transform or compose up to three images with a prompt: restyle a frame, or place a reference subject into a scene.",
    inputs: [
      PROMPT_PORT,
      { id: "images", label: "Images", kind: "image", multi: true, max: 3, required: true },
    ],
    output: "image",
    params: [
      { name: "model", type: "model", label: "Model", required: true, mediaType: "imageEdit" },
      {
        name: "prompt",
        type: "text",
        label: "Prompt",
        description: "Use {{input}} to place upstream text, or leave the marker out to append it.",
        required: true,
        default: "",
      },
    ],
  },
  tts: {
    type: "tts",
    label: "Text to speech",
    description: "Narrate upstream text as speech audio.",
    inputs: [{ id: "text", label: "Text", kind: "text", multi: true }],
    output: "audio",
    params: [
      {
        name: "model",
        type: "model",
        label: "Model",
        required: true,
        default: "tts-kokoro",
        mediaType: "tts",
      },
      { name: "voice", type: "string", label: "Voice", default: "" },
      { name: "speed", type: "number", label: "Speed", default: 1, min: 0.25, max: 4, step: 0.25 },
      {
        name: "responseFormat",
        type: "enum",
        label: "Response format",
        default: "mp3",
        enumValues: ["mp3", "wav", "flac"],
      },
    ],
  },
  music: {
    type: "music",
    label: "Music",
    description: "Generate a music track. Upstream text is the style prompt.",
    inputs: [PROMPT_PORT],
    output: "audio",
    params: [
      { name: "model", type: "model", label: "Model", required: true, mediaType: "music" },
      { name: "lyrics", type: "text", label: "Lyrics", default: "" },
      { name: "durationSeconds", type: "number", label: "Duration (seconds)", min: 1 },
      { name: "instrumental", type: "boolean", label: "Instrumental", default: false },
    ],
  },
  video: {
    type: "video",
    label: "Video",
    description:
      "Generate a short video. Feed an image to start from, an image to end on, reference images that keep a subject consistent, and (on the seedance reference models that take video input) clips to edit, extend or stitch.",
    inputs: [
      PROMPT_PORT,
      { id: "openingFrame", label: "Opening frame", kind: "image" },
      { id: "endFrame", label: "End frame", kind: "image" },
      {
        id: "references",
        label: "References",
        kind: "image",
        multi: true,
        // The ceiling is the most generous family's (seedance 2.5); what the
        // chosen model actually takes comes from `maxVideoReferences`.
        max: 30,
        maxFor: (params) =>
          maxVideoReferences(typeof params.model === "string" ? { id: params.model } : undefined),
      },
      {
        // Reference clips: what the seedance edit, extend and stitch workflows
        // work from. The cap is zero on every other model - including the
        // public `-basic` reference variants, which publish no video input - so
        // the validator refuses the connection rather than letting the engine
        // drop the clips at submit, after the prompt was written around them.
        // Only the id is in hand here; `takesReferenceClips` knows that tier.
        id: "referenceClips",
        label: "Reference clips",
        kind: "video",
        multi: true,
        max: 10,
        maxFor: (params) =>
          maxReferenceVideos(typeof params.model === "string" ? { id: params.model } : undefined),
      },
    ],
    output: "video",
    params: [
      {
        name: "model",
        type: "model",
        label: "Model",
        required: true,
        mediaType: "video",
        mediaTypes: ["video", "imageToVideo", "referenceToVideo"],
      },
      {
        name: "prompt",
        type: "text",
        label: "Prompt",
        description: "Use {{input}} to place upstream text, or leave the marker out to append it.",
        required: true,
        default: "",
      },
      {
        name: "duration",
        type: "string",
        label: "Duration",
        description: 'For example "5s".',
        default: "",
      },
      { name: "aspectRatio", type: "string", label: "Aspect ratio", default: "" },
      { name: "resolution", type: "string", label: "Resolution", default: "" },
    ],
  },
  lastFrame: {
    type: "lastFrame",
    label: "Frame from video",
    description:
      "Take a still out of a video: the handoff frame near its end (the sharpest one, so the next shot can continue from it), its very end, or its first frame. Feeds an image input.",
    inputs: [{ id: "video", label: "Video", kind: "video", required: true }],
    output: "image",
    params: [
      {
        name: "position",
        type: "enum",
        label: "Frame",
        enumValues: ["handoff", "end", "start"],
        default: "handoff",
        description:
          "Handoff is taken just before the end and picks the sharpest candidate, which is what a continuation should start from.",
      },
    ],
  },
  gate: {
    type: "gate",
    label: "Approval gate",
    description:
      "Pauses the production here until you approve. With several inputs connected, approving picks which one continues - wire alternative takes in and choose.",
    inputs: [{ id: "in", label: "Candidates", kind: "any", multi: true }],
    // Dynamic in practice: a gate emits whatever it lets through. See
    // `outputKindOf`, which resolves it from the connected input.
    output: "text",
    params: [
      {
        name: "note",
        type: "text",
        label: "What to check",
        description: "Shown when the production pauses here.",
        default: "",
      },
    ],
  },
  assemble: {
    type: "assemble",
    label: "Assemble",
    description:
      "Cut connected clips together into one film, in connection order, with an optional audio track under it. Chained shots are trimmed at their handoff automatically.",
    inputs: [
      { id: "clips", label: "Clips", kind: "video", multi: true, required: true },
      { id: "audio", label: "Audio track", kind: "audio" },
    ],
    output: "video",
    params: [
      {
        name: "audioVolume",
        type: "number",
        label: "Audio volume",
        default: 0.6,
        min: 0,
        max: 1,
        step: 0.1,
      },
    ],
  },
  output: {
    type: "output",
    label: "Output",
    description: "Displays whatever its upstream nodes produced. Accepts any kind.",
    inputs: [{ id: "in", label: "Result", kind: "any", multi: true }],
    output: "none",
    params: [],
  },
};

export const NODE_TYPES: WorkflowNodeType[] = Object.keys(NODE_SCHEMAS) as WorkflowNodeType[];

export function nodeSchema(type: WorkflowNodeType): NodeSchema {
  return NODE_SCHEMAS[type];
}

/** Runtime-safe lookup: workflows loaded from storage may carry stale types. */
export function maybeNodeSchema(type: string): NodeSchema | undefined {
  return Object.hasOwn(NODE_SCHEMAS, type) ? NODE_SCHEMAS[type as WorkflowNodeType] : undefined;
}

export function defaultParams(type: WorkflowNodeType): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const param of NODE_SCHEMAS[type].params) {
    if (param.default !== undefined) params[param.name] = param.default;
  }
  return params;
}

/** Graph context for the node types whose output kind depends on wiring. */
export interface OutputKindContext {
  nodeById: Map<string, WorkflowNode>;
  edges: WorkflowEdge[];
}

/**
 * What a node actually emits. Static per schema, except the asset node whose
 * kind follows the gallery item it points at, and the gate node, which emits
 * whatever it lets through — resolved from its first connected input when
 * `context` is given (gates chained through gates recurse, cycle-guarded).
 */
export function outputKindOf(
  node: Pick<WorkflowNode, "id" | "type" | "params">,
  context?: OutputKindContext,
  visited?: Set<string>,
): IOKind {
  const schema = maybeNodeSchema(node.type);
  if (!schema) return "none";
  if (node.type === "asset") {
    const kind = node.params.assetKind;
    if (kind === "video") return "video";
    if (kind === "audio") return "audio";
    return "image";
  }
  if (node.type === "gate" && context) {
    const seen = visited ?? new Set<string>();
    if (seen.has(node.id)) return "text";
    seen.add(node.id);
    const inbound = context.edges.find((edge) => edge.target === node.id);
    const source = inbound ? context.nodeById.get(inbound.source) : undefined;
    // An unconnected gate has nothing to pass; "text" keeps it connectable
    // while validation separately warns about the missing input.
    return source ? outputKindOf(source, context, seen) : "text";
  }
  return schema.output;
}

/** Whether an output of `sourceKind` may land on a port. Text ports accept
 * everything (media degrades to a short description); "any" ports accept
 * everything; media ports demand their own kind. */
export function isInputCompatible(sourceKind: IOKind, portKind: PortKind): boolean {
  if (sourceKind === "none") return false;
  if (portKind === "any" || portKind === "text") return true;
  return sourceKind === portKind;
}

/** True when the connection loses nothing: same kind, or an "any" port. A
 * media output on a text port is allowed but degrades, which the validator
 * surfaces as a warning. */
export function isIdealMatch(sourceKind: IOKind, portKind: PortKind): boolean {
  if (sourceKind === "none") return false;
  if (portKind === "any") return true;
  return sourceKind === portKind;
}

/**
 * The port an edge lands on.
 *
 * An explicit `targetPort` wins (unknown ids resolve to undefined so the
 * validator can flag them). A portless edge — anything saved before ports
 * existed, and every edge mobile's linear editor builds — resolves by kind
 * affinity: the first port that consumes exactly the source's kind, else the
 * first port that accepts it at all. That affinity rule is what keeps an
 * old image→video edge behaving as the start frame rather than becoming a
 * "[generated image]" mention in the prompt.
 */
export function resolveInputPort(
  target: NodeSchema,
  edge: Pick<WorkflowEdge, "targetPort">,
  sourceKind: IOKind,
): InputPort | undefined {
  if (edge.targetPort !== undefined) {
    return target.inputs.find((port) => port.id === edge.targetPort);
  }
  return (
    target.inputs.find((port) => port.kind === sourceKind) ??
    target.inputs.find((port) => isInputCompatible(sourceKind, port.kind))
  );
}
