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
//
// A port's capacity can be zero, and then the port is *closed*: the node's
// chosen model does not carry that input at all. Closed ports are not drawn,
// refuse connections, and make any edge still landing on one an error. See
// `openInputPorts`, which every surface must read instead of `schema.inputs`.

import { videoDirectionFromId, type VideoDirection } from "../catalog";
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
  /** Refines `max` from the node's params (its model, chiefly). Returning
   * undefined means "nothing to refine here": the schema's own figure stands,
   * which is how a port stays open while no model has been chosen. Returning
   * zero closes the port (see `openInputPorts`). */
  maxFor?: (params: Record<string, unknown>) => number | undefined;
  /** The node cannot run without this port connected. */
  required?: boolean;
}

/** The effective cap of a port for one node: the schema's, refined per model.
 * Zero means the port is closed on this node (see `openInputPorts`). */
export function portCapacity(port: InputPort, params: Record<string, unknown>): number | undefined {
  const refined = port.maxFor?.(params);
  if (refined !== undefined) return refined;
  if (!port.multi) return 1;
  return port.max;
}

/** Whether this node carries that input at all. */
export function isPortOpen(port: InputPort, params: Record<string, unknown>): boolean {
  return (portCapacity(port, params) ?? Number.POSITIVE_INFINITY) > 0;
}

/**
 * The input ports a node actually carries, given its params.
 *
 * Read this rather than `schema.inputs` everywhere a port is drawn, resolved,
 * counted or validated: what a model accepts is answered from what it
 * publishes and from its direction (ADR-0022), so the same node type carries
 * different inputs depending on the model chosen in it.
 */
export function openInputPorts(
  schema: NodeSchema,
  params: Record<string, unknown>,
): readonly InputPort[] {
  // Fast path: most node types have no per-model ports at all.
  return schema.inputs.some((port) => port.maxFor !== undefined)
    ? schema.inputs.filter((port) => isPortOpen(port, params))
    : schema.inputs;
}

/**
 * A port of this node type that the node's own params have closed, or
 * undefined when the id is not a port of it at all. Lets a surface say "this
 * model has no end frame" instead of "unknown input".
 */
export function closedInputPort(
  schema: NodeSchema,
  params: Record<string, unknown>,
  portId: string,
): InputPort | undefined {
  const port = schema.inputs.find((candidate) => candidate.id === portId);
  return port && !isPortOpen(port, params) ? port : undefined;
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
  /**
   * For params whose choices belong to the node's chosen model rather than to
   * the schema: which of that model's constraints to offer. Resolved by
   * `paramOptions`, which needs a catalog; a model nobody knows anything about
   * leaves the field free text, because an unrecognised key is rejected as
   * hard as a missing required one.
   */
  modelOptions?: "durations" | "aspectRatios" | "resolutions";
  /**
   * This param is the node's prompt template, so `{{input}}` in it is where
   * upstream text lands. Editors offer to write the marker; the engine's
   * `resolvePrompt` is what reads it.
   */
  acceptsInputMarker?: boolean;
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

/** The model a generator node is pinned to, or "" while none is chosen. */
function modelIdOf(params: Record<string, unknown>): string {
  return typeof params.model === "string" ? params.model : "";
}

/**
 * The direction the node's model runs in, or undefined when nobody can say.
 *
 * Read from `modelDirection`, which the model picker writes next to the id -
 * the same way an asset node keeps `assetLabel` next to `artifactId`. The
 * catalog is the only trustworthy source (nine of the operator's video models
 * name no direction in their id, five of them image-to-video), and neither the
 * validator nor the engine has one in hand; carrying the answer in the params
 * is what lets every surface agree without one.
 *
 * Falls back to the id for workflows saved before the field existed, for
 * templates, and for graphs built outside the editor.
 */
function videoDirectionOf(params: Record<string, unknown>): VideoDirection | undefined {
  const declared = params.modelDirection;
  if (
    declared === "text" ||
    declared === "image" ||
    declared === "reference" ||
    declared === "video"
  ) {
    return declared;
  }
  const id = modelIdOf(params);
  return id === "" ? undefined : videoDirectionFromId(id);
}

/**
 * Whether a video node carries the frame inputs (`image_url`,
 * `end_image_url`).
 *
 * The studios pin a *family* and let the filled-in inputs resolve the variant;
 * a workflow node pins one model, so its ports are that model's contract and
 * nothing else. The frames are the image-to-video contract: the operator
 * documents `image_url` as image-to-video only, and a reference-to-video
 * render steers from `reference_image_urls` instead.
 *
 * Not settled by probing, and deliberately so: the operator's pre-flight
 * (`VIDEO_PARAM_REJECTED`) enumerates every rejected *value* but says nothing
 * about unrecognised *keys*, so a frame sent to a reference model comes back
 * as a rendered clip that quietly ignored it - and is billed. Closing the port
 * is the reading that cannot cost anything.
 *
 * An unknown direction - no model yet, or an id that vouches for none - keeps
 * every port open. Closing one on a guess would take the frames away from the
 * models that exist for them.
 */
function videoFrameCapacity(params: Record<string, unknown>): number | undefined {
  const direction = videoDirectionOf(params);
  return direction === undefined || direction === "image" ? undefined : 0;
}

/** Reference clips, once a model is in hand. Before that the port stays open
 * on the schema's own ceiling: `maxReferenceVideos` answers zero for "no
 * model", which is the right answer for a request and the wrong one for an
 * editor the user has not finished filling in. */
function videoClipCapacity(params: Record<string, unknown>): number | undefined {
  const id = modelIdOf(params);
  return id === "" ? undefined : maxReferenceVideos({ id });
}

/** Reference photos are the reference-to-video contract; `videoRequestBody`
 * fills `reference_image_urls` for no other direction, so wiring them onto a
 * text- or image-to-video model dropped them in silence at submit. */
function videoReferenceCapacity(params: Record<string, unknown>): number {
  const id = modelIdOf(params);
  const model = id === "" ? undefined : { id };
  const direction = videoDirectionOf(params);
  if (direction === undefined) return maxVideoReferences(model);
  return direction === "reference" ? maxVideoReferences(model) : 0;
}

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
        acceptsInputMarker: true,
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
        acceptsInputMarker: true,
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
        acceptsInputMarker: true,
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
        name: "startAt",
        type: "string",
        label: "Starts at",
        description:
          "Where this is heard in the finished film, in seconds. Leave it empty and the cut places it after whatever came before.",
        default: "",
      },
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
      {
        id: "openingFrame",
        label: "Opening frame",
        kind: "image",
        maxFor: videoFrameCapacity,
      },
      { id: "endFrame", label: "End frame", kind: "image", maxFor: videoFrameCapacity },
      {
        id: "references",
        label: "References",
        kind: "image",
        multi: true,
        // The ceiling is the most generous family's (seedance 2.5); what the
        // chosen model actually takes comes from `videoReferenceCapacity`,
        // which is zero outside the reference-to-video direction.
        max: 30,
        maxFor: videoReferenceCapacity,
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
        maxFor: videoClipCapacity,
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
        acceptsInputMarker: true,
      },
      {
        name: "duration",
        type: "string",
        label: "Duration",
        description: 'For example "5s".',
        default: "",
        modelOptions: "durations",
      },
      {
        name: "aspectRatio",
        type: "string",
        label: "Aspect ratio",
        default: "",
        modelOptions: "aspectRatios",
      },
      {
        name: "resolution",
        type: "string",
        label: "Resolution",
        default: "",
        modelOptions: "resolutions",
      },
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
      "Pauses the production here until you approve. With several inputs connected, approving picks which one continues - wire alternative takes in and choose. A judged gate asks a model first.",
    inputs: [{ id: "in", label: "Candidates", kind: "any", multi: true }],
    // Dynamic in practice: a gate emits whatever it lets through. See
    // `outputKindOf`, which resolves it from the connected input.
    output: "text",
    params: [
      {
        name: "note",
        type: "text",
        label: "What to check",
        description: "Shown when the production pauses here, and told to the judge.",
        default: "",
      },
      {
        name: "mode",
        type: "enum",
        label: "Who decides",
        description:
          "Judged lets a model pass the work on its own, which is what lets a long production finish while nobody is watching. Judged then you always stops, but stops with an opinion attached. A judge that cannot answer degrades to you.",
        enumValues: ["human", "judged", "judged-then-human"],
        default: "human",
      },
      {
        name: "judgeModel",
        type: "model",
        label: "Judge",
        description: "A model that can look at pictures. Without one, the gate just waits for you.",
        mediaType: "text",
        default: "",
      },
    ],
  },
  assemble: {
    type: "assemble",
    label: "Assemble",
    description:
      "Cut connected clips together into one film, in connection order, and mix everything under it: dialogue, effects, a score. Chained shots are trimmed at their handoff automatically, the music gets out of the way of the dialogue, and the whole thing is levelled once.",
    inputs: [
      { id: "clips", label: "Clips", kind: "video", multi: true, required: true },
      { id: "dialogue", label: "Dialogue", kind: "audio", multi: true },
      { id: "sfx", label: "Effects", kind: "audio", multi: true },
      { id: "music", label: "Music", kind: "audio", multi: true },
      // The single track this node started with. Kept so a workflow saved
      // before the lanes existed still runs, and reads as the music it was.
      { id: "audio", label: "Audio track", kind: "audio" },
    ],
    output: "video",
    params: [
      {
        name: "audioVolume",
        type: "number",
        label: "Music level",
        default: 0.6,
        min: 0,
        max: 1,
        step: 0.1,
      },
      {
        name: "normalize",
        type: "boolean",
        label: "Level the film",
        description:
          "Bring the whole film to a standard loudness, so it does not arrive quieter than everything else the viewer watched today.",
        default: true,
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

/**
 * What a node is called: the name its author gave it, else its type's.
 *
 * A node is created *without* a name, so that "never named" stays tellable
 * from "named after its own type" - three asset nodes all reading "Asset" is
 * exactly what a name is for. Every surface that shows or sends a node's name
 * must come through here; `label` on its own is empty far more often than not.
 */
export function nodeLabel(node: Pick<WorkflowNode, "type" | "label">): string {
  return node.label.trim() || maybeNodeSchema(node.type)?.label || String(node.type);
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
 * The port an edge lands on, or undefined when it has nowhere to land.
 *
 * An explicit `targetPort` wins (unknown *and closed* ids resolve to undefined
 * so the validator can flag them). A portless edge — anything saved before
 * ports existed, and every edge mobile's linear editor builds — resolves by
 * kind affinity: the first port that consumes exactly the source's kind, else
 * the first port that accepts it at all. That affinity rule is what keeps an
 * old image→video edge behaving as the start frame rather than becoming a
 * "[generated image]" mention in the prompt.
 *
 * Only *open* ports are candidates, so affinity re-homes rather than breaks:
 * on a reference-to-video model the opening frame is closed, and a portless
 * image edge lands on the references instead of resolving to nothing.
 *
 * Takes the node rather than its schema because the answer depends on the
 * node's own params — passing a bare schema is what let a closed port keep
 * accepting edges.
 */
export function resolveInputPort(
  target: Pick<WorkflowNode, "type" | "params">,
  edge: Pick<WorkflowEdge, "targetPort">,
  sourceKind: IOKind,
): InputPort | undefined {
  const schema = maybeNodeSchema(target.type);
  if (!schema) return undefined;
  const ports = openInputPorts(schema, target.params);
  if (edge.targetPort !== undefined) {
    return ports.find((port) => port.id === edge.targetPort);
  }
  const exact = ports.find((port) => port.kind === sourceKind);
  if (exact) return exact;
  // Closed is not absent. A node whose ports of this kind were all closed by
  // its model must not quietly fall through to a text port, where the media
  // would chain as "[generated image]" and the render would look fine while
  // ignoring it. Nothing to land on is the honest answer, and the validator
  // says which model closed what.
  if (schema.inputs.some((port) => port.kind === sourceKind)) return undefined;
  return ports.find((port) => isInputCompatible(sourceKind, port.kind));
}
