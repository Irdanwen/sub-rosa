// The blocks Sub Rosa ships with (ADR-0116): common jobs of several steps,
// offered by the step search beside the person's own saved blocks, and
// copied into a workflow by value like them. Their ids are stable
// ("builtin-block-"), their timestamps 0, and they are never in the store,
// so nothing can delete or overwrite them.

import { t } from "../../i18n";
import { PREFERRED_RETOUCH_MODEL } from "../retouch/request";
import {
  type BlockInput,
  type BlockOutput,
  type BlockSetting,
  defaultParams,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./schema";
import {
  CHAT_MODEL,
  MUSIC_MODEL,
  TTS_MODEL,
  VIDEO_FROM_IMAGE_MODEL,
  VIDEO_MODEL,
} from "./templates";

const STEP_X = 320;

function step(
  id: string,
  type: WorkflowNodeType,
  column: number,
  row: number,
  params: Record<string, unknown> = {},
  label = "",
): WorkflowNode {
  return {
    id,
    type,
    label,
    position: { x: column * STEP_X, y: row * 240 },
    params: { ...defaultParams(type), ...params },
  };
}

function wire(source: string, target: string, targetPort?: string): WorkflowEdge {
  return { id: `${source}-${target}-${targetPort ?? ""}`, source, target, targetPort };
}

function block(
  id: string,
  name: string,
  description: string,
  graph: {
    nodes: WorkflowNode[];
    edges?: WorkflowEdge[];
    inputs: BlockInput[];
    outputs: BlockOutput[];
    promoted?: BlockSetting[];
  },
): Workflow {
  return {
    id: `builtin-block-${id}`,
    name,
    description,
    nodes: graph.nodes,
    edges: graph.edges ?? [],
    extra: {
      face: { inputs: graph.inputs, outputs: graph.outputs, promoted: graph.promoted ?? [] },
    },
    origin: "block",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The shipped blocks, in the language of the moment. */
export function builtInBlocks(): Workflow[] {
  return [
    block(
      "animate",
      t("Animate a picture"),
      t("A clip that starts on the picture, and its last frame to continue from."),
      {
        nodes: [
          step(
            "shot",
            "video",
            0,
            0,
            {
              model: VIDEO_FROM_IMAGE_MODEL,
              modelDirection: "image",
              prompt: "Slow push in, the scene comes alive.",
              duration: "5s",
            },
            t("Shot"),
          ),
          step("last", "lastFrame", 1, 0, { position: "end" }, t("Last frame")),
        ],
        edges: [wire("shot", "last", "video")],
        inputs: [{ id: "in-1", label: t("Picture"), nodeId: "shot", port: "openingFrame" }],
        outputs: [
          { id: "out-1", label: t("Clip"), nodeId: "shot" },
          { id: "out-2", label: t("Last frame"), nodeId: "last" },
        ],
        promoted: [
          { nodeId: "shot", param: "prompt" },
          { nodeId: "shot", param: "duration" },
          { nodeId: "shot", param: "model" },
        ],
      },
    ),
    block(
      "better-prompt",
      t("Better prompt"),
      t("An idea rewritten as one vivid, specific prompt."),
      {
        nodes: [
          step(
            "write",
            "chat",
            0,
            0,
            {
              model: CHAT_MODEL,
              prompt:
                "Rewrite this idea as one vivid, specific prompt for an image or video model. Name the subject, the setting, the light, the framing and the mood. Answer with the prompt only.\n\n{{input}}",
            },
            t("Rewrite"),
          ),
        ],
        inputs: [{ id: "in-1", label: t("Idea"), nodeId: "write", port: "prompt" }],
        outputs: [{ id: "out-1", label: t("Prompt"), nodeId: "write" }],
        promoted: [{ nodeId: "write", param: "model" }],
      },
    ),
    block(
      "two-shots",
      t("Two chained shots"),
      t("A wide shot and a close shot that continues it, cut together."),
      {
        nodes: [
          step("scene", "relay", 0, 0),
          step(
            "first",
            "video",
            1,
            0,
            { model: VIDEO_MODEL, prompt: "{{input}} Wide shot.", duration: "5s" },
            t("First shot"),
          ),
          step("handoff", "lastFrame", 2, 0, { position: "handoff" }, t("Handoff")),
          step(
            "second",
            "video",
            3,
            0,
            {
              model: VIDEO_FROM_IMAGE_MODEL,
              modelDirection: "image",
              prompt: "{{input}} Close shot, continuing the movement.",
              duration: "5s",
            },
            t("Second shot"),
          ),
          step("cut", "assemble", 4, 0, {}, t("Cut")),
        ],
        edges: [
          wire("scene", "first", "prompt"),
          wire("scene", "second", "prompt"),
          wire("first", "handoff", "video"),
          wire("handoff", "second", "openingFrame"),
          wire("first", "cut", "clips"),
          wire("second", "cut", "clips"),
        ],
        inputs: [{ id: "in-1", label: t("Scene"), nodeId: "scene", port: "in" }],
        outputs: [{ id: "out-1", label: t("Film"), nodeId: "cut" }],
        promoted: [
          { nodeId: "first", param: "prompt", label: t("First shot") },
          { nodeId: "second", param: "prompt", label: t("Second shot") },
        ],
      },
    ),
    block(
      "voice-music",
      t("Voice over music"),
      t("Lines read aloud over a score, the music lowered under the voice."),
      {
        nodes: [
          step("voice", "tts", 1, 0, { model: TTS_MODEL }, t("Voice")),
          // The music is asked for in words, through its prompt input.
          step(
            "brief",
            "textInput",
            0,
            1,
            { text: "Soft ambient score, slow and warm." },
            t("Music brief"),
          ),
          step(
            "score",
            "music",
            1,
            1,
            { model: MUSIC_MODEL, instrumental: true, durationSeconds: 30 },
            t("Music"),
          ),
          step("mix", "soundMix", 2, 0, {}, t("Mix")),
        ],
        edges: [
          wire("brief", "score", "prompt"),
          wire("voice", "mix", "dialogue"),
          wire("score", "mix", "music"),
        ],
        inputs: [{ id: "in-1", label: t("Lines"), nodeId: "voice", port: "text" }],
        outputs: [{ id: "out-1", label: t("Mix"), nodeId: "mix" }],
        promoted: [
          { nodeId: "brief", param: "text", label: t("Music") },
          { nodeId: "mix", param: "audioVolume" },
        ],
      },
    ),
    block(
      "character-sheet",
      t("Character sheet"),
      t("Nine views of a picture's subject in one sheet, for one edit."),
      {
        nodes: [
          step("sheet", "sheet", 0, 0, { model: PREFERRED_RETOUCH_MODEL, pack: "character" }),
        ],
        inputs: [{ id: "in-1", label: t("Picture"), nodeId: "sheet", port: "image" }],
        outputs: [{ id: "out-1", label: t("Sheet"), nodeId: "sheet" }],
        promoted: [
          { nodeId: "sheet", param: "pack" },
          { nodeId: "sheet", param: "model" },
        ],
      },
    ),
    block(
      "clean-cutout",
      t("Clean cutout"),
      t("The subject on a transparent background, from a sharper copy for cleaner edges."),
      {
        nodes: [
          step("up", "upscale", 0, 0, { scale: "2" }, t("Sharpen")),
          step("cut", "cutout", 1, 0, {}, t("Cut out")),
        ],
        edges: [wire("up", "cut", "image")],
        inputs: [{ id: "in-1", label: t("Picture"), nodeId: "up", port: "image" }],
        outputs: [{ id: "out-1", label: t("Cutout"), nodeId: "cut" }],
      },
    ),
    block("print", t("Upscale for print"), t("A copy four times larger."), {
      nodes: [step("up", "upscale", 0, 0, { scale: "4" })],
      inputs: [{ id: "in-1", label: t("Picture"), nodeId: "up", port: "image" }],
      outputs: [{ id: "out-1", label: t("Large picture"), nodeId: "up" }],
    }),
    block("fix-zone", t("Fix a zone"), t("Change one part of a picture and leave the rest."), {
      nodes: [step("fix", "zoneEdit", 0, 0, { model: PREFERRED_RETOUCH_MODEL })],
      inputs: [
        { id: "in-1", label: t("Picture"), nodeId: "fix", port: "image" },
        { id: "in-2", label: t("Instruction"), nodeId: "fix", port: "prompt" },
      ],
      outputs: [{ id: "out-1", label: t("Fixed"), nodeId: "fix" }],
      promoted: [
        { nodeId: "fix", param: "prompt" },
        { nodeId: "fix", param: "zone" },
        { nodeId: "fix", param: "model" },
      ],
    }),
  ];
}
