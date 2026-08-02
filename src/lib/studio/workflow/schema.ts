// Declarative node schemas for Studio workflows. This is the single source of
// truth consumed by the validator, the default-params factory, and the UI
// (param forms, connection hints). The data model is deliberately UI-agnostic:
// no React Flow types leak in here, only plain ids and positions.

export type WorkflowNodeType =
  | "textInput"
  | "chat"
  | "image"
  | "tts"
  | "music"
  | "video"
  | "lastFrame"
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

export interface ParamSchema {
  name: string;
  type: "string" | "text" | "number" | "boolean" | "enum" | "model";
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
}

export interface NodeSchema {
  type: WorkflowNodeType;
  label: string;
  description: string;
  input: IOKind;
  output: IOKind;
  params: ParamSchema[];
}

export const NODE_SCHEMAS: Record<WorkflowNodeType, NodeSchema> = {
  textInput: {
    type: "textInput",
    label: "Text input",
    description: "Static text written by the user. The starting point of a workflow.",
    input: "none",
    output: "text",
    params: [{ name: "text", type: "text", label: "Text", required: true, default: "" }],
  },
  chat: {
    type: "chat",
    label: "Chat",
    description: "Run a chat completion. Upstream text feeds the prompt.",
    input: "text",
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
    input: "text",
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
  tts: {
    type: "tts",
    label: "Text to speech",
    description: "Narrate upstream text as speech audio.",
    input: "text",
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
    input: "text",
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
    description: "Generate a short video. A parent image node chains as the start frame.",
    input: "text",
    output: "video",
    params: [
      { name: "model", type: "model", label: "Model", required: true, mediaType: "video" },
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
    input: "video",
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
  output: {
    type: "output",
    label: "Output",
    description: "Displays whatever its upstream nodes produced. Accepts any kind.",
    input: "text",
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

/** Anything can connect to anything, except from or to a "none" port. */
export function isInputCompatible(sourceKind: IOKind, targetKind: IOKind): boolean {
  return sourceKind !== "none" && targetKind !== "none";
}

/** Text targets accept every kind (media degrades to a description); other
 * targets are ideal only for their own kind. Mismatch is a warning, not an
 * error. */
export function isIdealMatch(sourceKind: IOKind, targetKind: IOKind): boolean {
  if (sourceKind === "none" || targetKind === "none") return false;
  if (targetKind === "text") return true;
  return sourceKind === targetKind;
}
