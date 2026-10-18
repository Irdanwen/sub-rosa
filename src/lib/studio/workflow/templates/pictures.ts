// Starter workflows that make a picture from words.

import type { Workflow } from "../schema";
import { t } from "../../../i18n";
import { CHAT_MODEL, IMAGE_MODEL, TTS_MODEL, edge, node } from "./build";

export function albumCover(): Workflow {
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

export function storyScene(): Workflow {
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

/** One picture per line of a list: the step that makes a picture runs once
 * for each title (ADR-0117). */
export function coversFromList(): Workflow {
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

/** A post's picture and its caption, from one idea. */
export function postWithCaption(): Workflow {
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

/** Four takes on one idea, the person picks the best, and the one picked is
 * made four times larger: the gate gathers every take
 * (ComfyUI: template_3x3_contact_sheet). */
export function pickTheBestOfFour(): Workflow {
  return {
    id: "template-pick-the-best-of-four",
    name: t("Pick the best of four"),
    description: t("Four takes on one idea: pick the best, get it four times larger."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("idea", "textInput", t("Idea"), 0, 0, {
        text: "A cozy reading nook in a treehouse during a summer rain.",
      }),
      node("takes", "chat", t("Four takes"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write four different image prompts for this idea, each with its own composition, point of view and palette. One line per prompt, under 60 words each. No numbering, no other text.\n\n{{input}}",
      }),
      node("lines", "splitText", t("One per take"), 2, 0, { max: 4 }),
      node("take", "image", t("Take"), 3, 0, { model: IMAGE_MODEL, aspectRatio: "1:1" }),
      node("pick", "gate", t("Pick one"), 4, 0, {
        note: "Pick the take to keep: it is made four times larger.",
      }),
      node("large", "upscale", t("Larger"), 5, 0, { scale: "4" }),
      node("out", "output", t("Chosen picture"), 6, 0),
    ],
    edges: [
      edge("idea", "takes"),
      edge("takes", "lines", "text"),
      edge("lines", "take", "prompt"),
      edge("take", "pick", "in"),
      edge("pick", "large", "image"),
      edge("large", "out"),
    ],
  };
}
