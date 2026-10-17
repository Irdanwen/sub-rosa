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
import { t } from "../../i18n";
import { appWithIds } from "./app";
import { PREFERRED_RETOUCH_MODEL } from "../retouch/request";
import { TRY_ON_MODEL_PREFERENCE, tryOnPrompt } from "../try-on";

const LEVEL_X = 300;
const ROW_Y = 220;

export const CHAT_MODEL = "qwen3-next-80b";
const IMAGE_MODEL = "seedream-v4";
export const TTS_MODEL = "tts-kokoro";
export const MUSIC_MODEL = "ace-step-15";
export const VIDEO_MODEL = "kling-2.5-turbo-pro-text-to-video";
/** The image-to-video half of the same family, for a shot that continues
 * another one from its handoff frame. */
export const VIDEO_FROM_IMAGE_MODEL = "kling-2.5-turbo-pro-image-to-video";

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
    name: t("Album cover"),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", t("Album description"), 0, 0, {
        text: "A synthwave album called Midnight Drive: moody neon city at night, rain on the windshield, retro 1980s energy.",
      }),
      node("direction", "chat", t("Art direction"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "You are an art director. Turn the following album description into one detailed image generation prompt for a square album cover. Describe composition, color palette, lighting, and mood in under 120 words. Reply with the prompt only.\n\n{{input}}",
      }),
      node("cover", "image", t("Cover art"), 2, 0, {
        model: IMAGE_MODEL,
        aspectRatio: "1:1",
      }),
      node("out", "output", t("Cover"), 3, 0),
    ],
    app: {
      fields: [{ nodeId: "input", param: "text", label: t("Describe the album") }],
      outputs: ["out"],
      intro: t("Describe an album, get its cover."),
    },
    edges: [edge("input", "direction"), edge("direction", "cover"), edge("cover", "out")],
  };
}

function storyScene(): Workflow {
  return {
    id: "template-story-scene",
    name: t("Story scene"),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", t("Story premise"), 0, 0, {
        text: "A lighthouse keeper finds a message in a bottle on the morning after a violent storm.",
      }),
      node("scene", "chat", t("Scene writing"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write a vivid opening scene for this story premise. One paragraph, present tense, third person, strong sensory detail. Reply with the scene only.\n\n{{input}}",
      }),
      node("illustration", "image", t("Illustration"), 2, 0, {
        model: IMAGE_MODEL,
        prompt:
          "A cinematic illustration of this scene, painterly style, dramatic natural light: {{input}}",
      }),
      node("narration", "tts", t("Narration"), 2, 1, { model: TTS_MODEL }),
      node("out-image", "output", t("Scene image"), 3, 0),
      node("out-audio", "output", t("Scene narration"), 3, 1),
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
    name: t("Music from a mood"),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", t("Mood"), 0, 0, {
        text: "Late night rain against the window, warm coffee, quiet optimism.",
      }),
      node("brief", "chat", t("Music brief"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Turn this mood into a short music brief: genre, tempo, instrumentation, and overall feel. Two sentences maximum, no lyrics. Reply with the brief only.\n\n{{input}}",
      }),
      node("track", "music", t("Track"), 2, 0, {
        model: MUSIC_MODEL,
        instrumental: true,
        durationSeconds: 90,
      }),
      node("out", "output", t("Track"), 3, 0),
    ],
    app: {
      fields: [{ nodeId: "input", param: "text", label: t("The mood") }],
      outputs: ["out"],
      intro: t("Describe a mood, get a track."),
    },
    edges: [edge("input", "brief"), edge("brief", "track"), edge("track", "out")],
  };
}

function shortVideoAd(): Workflow {
  return {
    id: "template-short-video-ad",
    name: t("Short video ad"),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("input", "textInput", t("Product"), 0, 0, {
        text: "A reusable smart water bottle that tracks hydration and glows softly to remind you to drink.",
      }),
      node("script", "chat", t("Ad script"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write a single-shot video prompt for a 5 second product ad based on this description. Describe the camera move, the setting, and the product hero moment in under 60 words. Reply with the prompt only.\n\n{{input}}",
      }),
      node("clip", "video", t("Ad clip"), 2, 0, {
        model: VIDEO_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
      }),
      node("out", "output", t("Clip"), 3, 0),
    ],
    edges: [edge("input", "script"), edge("script", "clip"), edge("clip", "out")],
  };
}

/** Two shots that run on: the second starts from the frame the first ended on,
 * which is the only way past a single model's clip length. */
function twoShotSequence(): Workflow {
  return {
    id: "template-two-shot-sequence",
    name: t("Two shot sequence"),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("scene", "textInput", t("Scene"), 0, 0, {
        text: "A woman in a grey coat walks along a rain-slicked metro platform at night, neon reflections in the puddles.",
      }),
      node("first", "video", t("First shot"), 1, 0, {
        model: VIDEO_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
        prompt: "{{input}} The camera tracks her from the side.",
      }),
      node("frame", "lastFrame", t("Handoff frame"), 2, 0, { position: "handoff" }),
      node("second", "video", t("Second shot"), 3, 0, {
        model: VIDEO_FROM_IMAGE_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
        prompt:
          "Continue the shot, no cut: she reaches the end of the platform and looks back down the tunnel. Same lighting, same coat.",
      }),
      node("out", "output", t("Second shot"), 4, 0),
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
    name: t("Short film with score"),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("scene", "textInput", t("Scene"), 0, 0, {
        text: "A paper boat drifts down a rain gutter through a miniature city of moss and bottle caps, dusk light.",
      }),
      node("first", "video", t("First shot"), 1, 0, {
        model: VIDEO_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
        prompt: "{{input}} Low tracking shot at water level, following the boat.",
      }),
      node("frame", "lastFrame", t("Handoff frame"), 2, 0, { position: "handoff" }),
      node("second", "video", t("Second shot"), 3, 0, {
        model: VIDEO_FROM_IMAGE_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
        prompt:
          "Continue the shot, no cut: the boat tips over a tiny waterfall between two cobblestones and rights itself. Same light.",
      }),
      node("mood", "textInput", t("Score mood"), 0, 1, {
        text: "A tiny adventure: playful strings and a music box, light rain percussion, wonder.",
      }),
      node("score", "music", t("Score"), 1, 1, {
        model: MUSIC_MODEL,
        instrumental: true,
        durationSeconds: 30,
      }),
      node("film", "assemble", t("Final cut"), 4, 0, { audioVolume: 0.6 }),
      node("out", "output", t("Film"), 5, 0),
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

/** Virtual try-on: a photo of a person and a photo of a garment, composed
 * into the person wearing it. The prompt is the tuned one the chat card uses
 * (`try-on.ts`); both photos are picked from the gallery before a run. */
function tryItOn(): Workflow {
  return {
    id: "template-try-it-on",
    name: t("Try it on"),
    description: t("A photo of you and a photo of a garment: see yourself wearing it."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("person", "asset", t("Your photo"), 0, 0, { assetKind: "image" }),
      node("garment", "asset", t("The garment"), 0, 1, { assetKind: "image" }),
      node("fitting", "imageEdit", t("Try it on"), 1, 0, {
        model: TRY_ON_MODEL_PREFERENCE[0],
        prompt: tryOnPrompt(),
      }),
      node("out", "output", t("You, wearing it"), 2, 0),
    ],
    // The person first: the edit keeps image 1 and borrows from image 2.
    app: {
      fields: [
        { nodeId: "person", param: "artifactId", label: t("Your photo") },
        { nodeId: "garment", param: "artifactId", label: t("The garment") },
      ],
      outputs: ["out"],
      intro: t("Pick a photo of you and a garment, see yourself wearing it."),
    },
    edges: [
      edge("person", "fitting", "images"),
      edge("garment", "fitting", "images"),
      edge("fitting", "out"),
    ],
  };
}

/** One picture per line of a list: the step that makes a picture runs once
 * for each title (ADR-0117). */
function coversFromList(): Workflow {
  return {
    id: "template-covers-from-list",
    name: t("Covers from a list"),
    description: t("One cover per line: write the titles, get a picture for each."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("titles", "textList", t("Titles"), 0, 0, {
        items: "Midnight Drive\nPaper Lanterns\nSalt and Static",
      }),
      node("cover", "image", t("Cover"), 1, 0, {
        model: IMAGE_MODEL,
        aspectRatio: "1:1",
        prompt:
          "A square album cover for a record called {{input}}: one striking image, bold composition, rich color, no text.",
      }),
      node("out", "output", t("Covers"), 2, 0),
    ],
    app: {
      fields: [{ nodeId: "titles", param: "items", label: t("Titles, one per line") }],
      outputs: ["out"],
      intro: t("Write titles, get a cover for each."),
    },
    edges: [edge("titles", "cover", "prompt"), edge("cover", "out")],
  };
}

/** Nine views of one character in one sheet, from a single picture. */
function characterSheet(): Workflow {
  return {
    id: "template-character-sheet",
    name: t("Character sheet"),
    description: t("Nine views of a character from one picture, ready for a film's bible."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("picture", "asset", t("Character"), 0, 0, { assetKind: "image" }),
      node("sheet", "sheet", t("Sheet"), 1, 0, {
        model: PREFERRED_RETOUCH_MODEL,
        pack: "character",
      }),
      node("out", "output", t("Sheet"), 2, 0),
    ],
    app: {
      fields: [{ nodeId: "picture", param: "artifactId", label: t("The character") }],
      outputs: ["out"],
      intro: t("Pick a character, get nine views of it."),
    },
    edges: [edge("picture", "sheet", "image"), edge("sheet", "out")],
  };
}

/** A spoken intro over its own music, the music lowered under the voice. */
function podcastIntro(): Workflow {
  return {
    id: "template-podcast-intro",
    name: t("Podcast intro"),
    description: t("A few lines read aloud over a short score, mixed and levelled."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("lines", "textInput", t("Lines"), 0, 0, {
        text: "Welcome back to Small Hours, the show about the work people do while the rest of us sleep.",
      }),
      node("voice", "tts", t("Voice"), 1, 0, { model: TTS_MODEL }),
      node("brief", "textInput", t("Music brief"), 0, 1, {
        text: "Warm lo-fi intro, soft keys and brushed drums, calm and inviting.",
      }),
      node("score", "music", t("Music"), 1, 1, {
        model: MUSIC_MODEL,
        instrumental: true,
        durationSeconds: 30,
      }),
      node("mix", "soundMix", t("Mix"), 2, 0, { audioVolume: 0.5 }),
      node("out", "output", t("Intro"), 3, 0),
    ],
    app: {
      fields: [
        { nodeId: "lines", param: "text", label: t("What the voice says") },
        { nodeId: "brief", param: "text", label: t("The music") },
      ],
      outputs: ["out"],
      intro: t("Write a few lines and describe the music, get the intro."),
    },
    edges: [
      edge("lines", "voice", "text"),
      edge("brief", "score", "prompt"),
      edge("voice", "mix", "dialogue"),
      edge("score", "mix", "music"),
      edge("mix", "out"),
    ],
  };
}

/** One part of a picture changed, the rest left as it was, both side by side. */
function beforeAndAfter(): Workflow {
  return {
    id: "template-before-and-after",
    name: t("Before and after"),
    description: t("Change one part of a picture and compare it with the original."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("picture", "asset", t("Picture"), 0, 0, { assetKind: "image" }),
      node("fix", "zoneEdit", t("Change"), 1, 0, {
        model: PREFERRED_RETOUCH_MODEL,
        prompt: "Replace the sky with a soft golden sunset.",
        zone: { x: 0, y: 0, width: 1, height: 0.45 },
      }),
      node("compare", "compare", t("Before and after"), 2, 0),
      node("out", "output", t("Changed"), 2, 1),
    ],
    app: {
      fields: [
        { nodeId: "picture", param: "artifactId", label: t("The picture") },
        { nodeId: "fix", param: "prompt", label: t("What to change") },
      ],
      outputs: ["compare"],
      intro: t("Pick a picture and say what to change."),
    },
    edges: [
      edge("picture", "fix", "image"),
      edge("picture", "compare", "before"),
      edge("fix", "compare", "after"),
      edge("fix", "out"),
    ],
  };
}

/** A story idea written as three shots, each shot filmed, the three cut
 * together: the list is cut during the run (ADR-0117). */
function storyInThreeShots(): Workflow {
  return {
    id: "template-story-in-three-shots",
    name: t("Story in three shots"),
    description: t("An idea written as three shots, each one filmed, cut into one film."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("idea", "textInput", t("Idea"), 0, 0, {
        text: "A street musician's violin case fills with paper birds that fly away at dusk.",
      }),
      node("shots", "chat", t("Shot list"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write this idea as exactly three shots for a short film. One line per shot, each a self-contained video prompt naming the framing, the action and the light. No numbering, no other text.\n\n{{input}}",
      }),
      node("lines", "splitText", t("One per shot"), 2, 0, { max: 3 }),
      node("shot", "video", t("Shot"), 3, 0, {
        model: VIDEO_MODEL,
        duration: "5s",
        aspectRatio: "16:9",
      }),
      node("film", "assemble", t("Cut"), 4, 0),
      node("out", "output", t("Film"), 5, 0),
    ],
    edges: [
      edge("idea", "shots"),
      edge("shots", "lines", "text"),
      edge("lines", "shot", "prompt"),
      edge("shot", "film", "clips"),
      edge("film", "out"),
    ],
  };
}

/** A picture made four times larger, for a print or a large screen. */
function upscaleForPrint(): Workflow {
  return {
    id: "template-upscale-for-print",
    name: t("Upscale for print"),
    description: t("A copy of a picture four times larger, sharp enough to print."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("picture", "asset", t("Picture"), 0, 0, { assetKind: "image" }),
      node("up", "upscale", t("Upscale"), 1, 0, { scale: "4" }),
      node("out", "output", t("Large picture"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "picture", param: "artifactId", label: t("The picture") },
        { nodeId: "up", param: "scale" },
      ],
      outputs: ["out"],
    },
    edges: [edge("picture", "up", "image"), edge("up", "out")],
  };
}

/** A post's picture and its caption, from one idea. */
function postWithCaption(): Workflow {
  return {
    id: "template-post-with-caption",
    name: t("Post with caption"),
    description: t("A picture and the words to go with it, from one idea."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("idea", "textInput", t("Idea"), 0, 0, {
        text: "Opening day of a tiny bakery on a rainy corner: the first loaves cooling in the window.",
      }),
      node("caption", "chat", t("Caption"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write a warm, short social media caption for this moment, two sentences at most, no hashtags. Reply with the caption only.\n\n{{input}}",
      }),
      node("picture", "image", t("Picture"), 1, 1, {
        model: IMAGE_MODEL,
        aspectRatio: "4:5",
        prompt: "An inviting, natural photograph of this moment, soft daylight: {{input}}",
      }),
      node("out-caption", "output", t("Caption"), 2, 0),
      node("out-picture", "output", t("Picture"), 2, 1),
    ],
    app: {
      fields: [{ nodeId: "idea", param: "text", label: t("The moment") }],
      outputs: ["out-picture", "out-caption"],
      intro: t("Describe a moment, get a picture and its caption."),
    },
    edges: [
      edge("idea", "caption"),
      edge("idea", "picture", "prompt"),
      edge("caption", "out-caption"),
      edge("picture", "out-picture"),
    ],
  };
}

/** A text translated, then read aloud in that language. */
function readInAnotherLanguage(): Workflow {
  return {
    id: "template-read-in-another-language",
    name: t("Read it in another language"),
    description: t("A text translated, then read aloud in the new language."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("text", "textInput", t("Text"), 0, 0, {
        text: "Thank you for coming tonight. The doors open at eight, and the first act starts at half past.",
      }),
      node("translate", "chat", t("Translation"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Translate this text into Spanish, natural and spoken in tone. Reply with the translation only.\n\n{{input}}",
      }),
      node("voice", "tts", t("Voice"), 2, 0, { model: TTS_MODEL }),
      node("out", "output", t("Spoken"), 3, 0),
    ],
    app: {
      fields: [{ nodeId: "text", param: "text", label: t("Your text") }],
      outputs: ["out"],
    },
    edges: [edge("text", "translate"), edge("translate", "voice", "text"), edge("voice", "out")],
  };
}

export type TemplateCategory = "pictures" | "video" | "sound" | "retouch";

/** What each template is for, as the library sorts them. */
const CATEGORIES: Record<string, TemplateCategory> = {
  "template-album-cover": "pictures",
  "template-story-scene": "pictures",
  "template-covers-from-list": "pictures",
  "template-post-with-caption": "pictures",
  "template-short-video-ad": "video",
  "template-two-shot-sequence": "video",
  "template-short-film": "video",
  "template-story-in-three-shots": "video",
  "template-music-from-mood": "sound",
  "template-podcast-intro": "sound",
  "template-read-in-another-language": "sound",
  "template-try-it-on": "retouch",
  "template-character-sheet": "retouch",
  "template-before-and-after": "retouch",
  "template-upscale-for-print": "retouch",
};

export function templateCategory(id: string): TemplateCategory {
  return CATEGORIES[id] ?? "pictures";
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
    tryItOn(),
    coversFromList(),
    characterSheet(),
    podcastIntro(),
    beforeAndAfter(),
    storyInThreeShots(),
    upscaleForPrint(),
    postWithCaption(),
    readInAnotherLanguage(),
  ];
}

/** A template copied into a workflow of its own: fresh ids for every step
 * and wire, and its app pointing at them. */
export function copyTemplate(template: Workflow, into: Workflow): Workflow {
  const ids = new Map(template.nodes.map((node) => [node.id, crypto.randomUUID()]));
  const app = appWithIds(template.app, ids);
  return {
    ...into,
    ...(template.description ? { description: template.description } : {}),
    nodes: template.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id) ?? node.id,
      params: { ...node.params },
    })),
    edges: template.edges.map((edge) => ({
      ...edge,
      id: crypto.randomUUID(),
      source: ids.get(edge.source) ?? edge.source,
      target: ids.get(edge.target) ?? edge.target,
    })),
    ...(app ? { app } : {}),
  };
}
