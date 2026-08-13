// Prebuilt starter workflows. Template ids are stable ("template-" prefix)
// and timestamps are 0: the UI clones a template with fresh ids before
// letting the user edit or save it.

import {
  defaultParams,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./schema";

const LEVEL_X = 300;
const ROW_Y = 220;

const CHAT_MODEL = "qwen3-next-80b";
const IMAGE_MODEL = "seedream-v4";
const TTS_MODEL = "tts-kokoro";
const MUSIC_MODEL = "ace-step-15";
const VIDEO_MODEL = "kling-2.5-turbo-pro-text-to-video";
/** The image-to-video half of the same family, for a shot that continues
 * another one from its handoff frame. */
const VIDEO_FROM_IMAGE_MODEL = "kling-2.5-turbo-pro-image-to-video";

function node(
  id: string,
  type: WorkflowNodeType,
  label: string,
  level: number,
  row: number,
  params: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    type,
    label,
    position: { x: level * LEVEL_X, y: row * ROW_Y },
    params: { ...defaultParams(type), ...params },
  };
}

function edge(source: string, target: string, targetPort?: string): WorkflowEdge {
  return {
    id: `${source}-${target}${targetPort ? `-${targetPort}` : ""}`,
    source,
    target,
    targetPort,
  };
}

function albumCover(): Workflow {
  return {
    id: "template-album-cover",
    name: "Album cover",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", "Album description", 0, 0, {
        text: "A synthwave album called Midnight Drive: moody neon city at night, rain on the windshield, retro 1980s energy.",
      }),
      node("direction", "chat", "Art direction", 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "You are an art director. Turn the following album description into one detailed image generation prompt for a square album cover. Describe composition, color palette, lighting, and mood in under 120 words. Reply with the prompt only.\n\n{{input}}",
      }),
      node("cover", "image", "Cover art", 2, 0, {
        model: IMAGE_MODEL,
        aspectRatio: "1:1",
      }),
      node("out", "output", "Cover", 3, 0),
    ],
    edges: [edge("input", "direction"), edge("direction", "cover"), edge("cover", "out")],
  };
}

function storyScene(): Workflow {
  return {
    id: "template-story-scene",
    name: "Story scene",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", "Story premise", 0, 0, {
        text: "A lighthouse keeper finds a message in a bottle on the morning after a violent storm.",
      }),
      node("scene", "chat", "Scene writing", 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write a vivid opening scene for this story premise. One paragraph, present tense, third person, strong sensory detail. Reply with the scene only.\n\n{{input}}",
      }),
      node("illustration", "image", "Illustration", 2, 0, {
        model: IMAGE_MODEL,
        prompt:
          "A cinematic illustration of this scene, painterly style, dramatic natural light: {{input}}",
      }),
      node("narration", "tts", "Narration", 2, 1, { model: TTS_MODEL }),
      node("out-image", "output", "Scene image", 3, 0),
      node("out-audio", "output", "Scene narration", 3, 1),
    ],
    edges: [
      edge("input", "scene"),
      edge("scene", "illustration"),
      edge("scene", "narration"),
      edge("illustration", "out-image"),
      edge("narration", "out-audio"),
    ],
  };
}

function musicFromMood(): Workflow {
  return {
    id: "template-music-from-mood",
    name: "Music from a mood",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", "Mood", 0, 0, {
        text: "Late night rain against the window, warm coffee, quiet optimism.",
      }),
      node("brief", "chat", "Music brief", 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Turn this mood into a short music brief: genre, tempo, instrumentation, and overall feel. Two sentences maximum, no lyrics. Reply with the brief only.\n\n{{input}}",
      }),
      node("track", "music", "Track", 2, 0, {
        model: MUSIC_MODEL,
        instrumental: true,
        durationSeconds: 90,
      }),
      node("out", "output", "Track", 3, 0),
    ],
    edges: [edge("input", "brief"), edge("brief", "track"), edge("track", "out")],
  };
}

function shortVideoAd(): Workflow {
  return {
    id: "template-short-video-ad",
    name: "Short video ad",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", "Product", 0, 0, {
        text: "A reusable smart water bottle that tracks hydration and glows softly to remind you to drink.",
      }),
      node("script", "chat", "Ad script", 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write a single-shot video prompt for a 5 second product ad based on this description. Describe the camera move, the setting, and the product hero moment in under 60 words. Reply with the prompt only.\n\n{{input}}",
      }),
      node("clip", "video", "Ad clip", 2, 0, {
        model: VIDEO_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
      }),
      node("out", "output", "Clip", 3, 0),
    ],
    edges: [edge("input", "script"), edge("script", "clip"), edge("clip", "out")],
  };
}

/** Two shots that run on: the second starts from the frame the first ended on,
 * which is the only way past a single model's clip length. */
function twoShotSequence(): Workflow {
  return {
    id: "template-two-shot-sequence",
    name: "Two shot sequence",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("scene", "textInput", "Scene", 0, 0, {
        text: "A woman in a grey coat walks along a rain-slicked metro platform at night, neon reflections in the puddles.",
      }),
      node("first", "video", "First shot", 1, 0, {
        model: VIDEO_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
        prompt: "{{input}} The camera tracks her from the side.",
      }),
      node("frame", "lastFrame", "Handoff frame", 2, 0, { position: "handoff" }),
      node("second", "video", "Second shot", 3, 0, {
        model: VIDEO_FROM_IMAGE_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
        prompt:
          "Continue the shot, no cut: she reaches the end of the platform and looks back down the tunnel. Same lighting, same coat.",
      }),
      node("out", "output", "Second shot", 4, 0),
    ],
    edges: [
      edge("scene", "first", "prompt"),
      edge("first", "frame", "video"),
      edge("frame", "second", "openingFrame"),
      edge("second", "out"),
    ],
  };
}

/** The whole production loop on one canvas: two chained shots, a score, and
 * an assemble node that cuts them into one film with the music under it. */
function shortFilm(): Workflow {
  return {
    id: "template-short-film",
    name: "Short film with score",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("scene", "textInput", "Scene", 0, 0, {
        text: "A paper boat drifts down a rain gutter through a miniature city of moss and bottle caps, dusk light.",
      }),
      node("first", "video", "First shot", 1, 0, {
        model: VIDEO_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
        prompt: "{{input}} Low tracking shot at water level, following the boat.",
      }),
      node("frame", "lastFrame", "Handoff frame", 2, 0, { position: "handoff" }),
      node("second", "video", "Second shot", 3, 0, {
        model: VIDEO_FROM_IMAGE_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
        prompt:
          "Continue the shot, no cut: the boat tips over a tiny waterfall between two cobblestones and rights itself. Same light.",
      }),
      node("mood", "textInput", "Score mood", 0, 1, {
        text: "A tiny adventure: playful strings and a music box, light rain percussion, wonder.",
      }),
      node("score", "music", "Score", 1, 1, {
        model: MUSIC_MODEL,
        instrumental: true,
        durationSeconds: 30,
      }),
      node("film", "assemble", "Final cut", 4, 0, { audioVolume: 0.6 }),
      node("out", "output", "Film", 5, 0),
    ],
    edges: [
      edge("scene", "first", "prompt"),
      edge("first", "frame", "video"),
      edge("frame", "second", "openingFrame"),
      // Clips cut in connection order: first shot, then its continuation.
      edge("first", "film", "clips"),
      edge("second", "film", "clips"),
      edge("mood", "score", "prompt"),
      edge("score", "film", "audio"),
      edge("film", "out"),
    ],
  };
}

/** Fresh copies each call so callers can mutate their clone safely. */
export function templateWorkflows(): Workflow[] {
  return [
    albumCover(),
    storyScene(),
    musicFromMood(),
    shortVideoAd(),
    twoShotSequence(),
    shortFilm(),
  ];
}
