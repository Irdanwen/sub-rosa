// Starter workflows for a brand: a design reformatted, a thumbnail, a logo
// set in motion. Each one is re-authored from a recipe in ComfyUI's official
// gallery (ADR-0121), named in its comment.

import type { Workflow } from "../schema";
import { t } from "../../../i18n";
import {
  EDIT_MODEL,
  edge,
  FAITHFUL_EDIT_MODEL,
  FRAMES_VIDEO_MODEL,
  LETTERING_MODEL,
  node,
} from "./build";

/** How each format is asked for: the design is recomposed, never cropped. */
function recompose(shape: string): string {
  return `Recompose this design for a ${shape} format: extend the background naturally and rearrange the elements so they fit, keeping every element, every word and the logo exactly as designed, nothing cropped and nothing new added.`;
}

/** One design, recomposed for a square post, a story and a wide banner
 * (ComfyUI: templates_graphic_design_recomposer,
 * template_outpaint_to_any_aspect_ratio_nano_banana_pro). */
export function reformatForEveryFormat(): Workflow {
  return {
    id: "template-reformat-for-every-format",
    name: t("One design, every format"),
    description: t("A design recomposed for a square post, a story and a wide banner."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("design", "asset", t("The design"), 0, 1, { assetKind: "image" }),
      node("square", "imageEdit", t("Square"), 1, 0, {
        model: EDIT_MODEL,
        aspectRatio: "1:1",
        prompt: recompose("square 1:1"),
      }),
      node("story", "imageEdit", t("Story"), 1, 1, {
        model: EDIT_MODEL,
        aspectRatio: "9:16",
        prompt: recompose("tall 9:16 story"),
      }),
      node("banner", "imageEdit", t("Banner"), 1, 2, {
        model: EDIT_MODEL,
        aspectRatio: "16:9",
        prompt: recompose("wide 16:9 banner"),
      }),
      node("out-square", "output", t("Square"), 2, 0),
      node("out-story", "output", t("Story"), 2, 1),
      node("out-banner", "output", t("Banner"), 2, 2),
    ],
    app: {
      fields: [{ nodeId: "design", param: "artifactId", label: t("Your design") }],
      outputs: ["out-square", "out-story", "out-banner"],
      intro: t("Pick a design, get it in three formats."),
    },
    edges: [
      edge("design", "square", "images"),
      edge("design", "story", "images"),
      edge("design", "banner", "images"),
      edge("square", "out-square"),
      edge("story", "out-story"),
      edge("banner", "out-banner"),
    ],
  };
}

/** A video thumbnail from its title and a photo of the host
 * (ComfyUI: template_eric_thumbnail_generator). */
export function videoThumbnail(): Workflow {
  return {
    id: "template-video-thumbnail",
    name: t("Video thumbnail"),
    description: t("A bold thumbnail from a video's title and a photo of its host."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("title", "textInput", t("Title"), 0, 0, {
        text: "I cooked every meal over a campfire for a week",
      }),
      node("host", "asset", t("The host"), 0, 1, { assetKind: "image" }),
      node("thumbnail", "imageEdit", t("Thumbnail"), 1, 0, {
        model: FAITHFUL_EDIT_MODEL,
        aspectRatio: "16:9",
        prompt:
          'A bold video thumbnail. On one side, the person from the picture in a close-up with an expressive face, keeping their likeness. On the other side, the title "{{input}}" in large, thick, high-contrast letters, short enough to read at a glance. A vivid background that says what the video is about. Readable at a small size.',
      }),
      node("out", "output", t("Thumbnail"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "title", param: "text", label: t("The video's title") },
        { nodeId: "host", param: "artifactId", label: t("A photo of the host") },
      ],
      outputs: ["out"],
      intro: t("Write a title and pick a photo, get a thumbnail."),
    },
    edges: [
      edge("title", "thumbnail", "prompt"),
      edge("host", "thumbnail", "images"),
      edge("thumbnail", "out"),
    ],
  };
}

/** A brand name set as a logotype, given a material, and a clip that turns
 * the flat one into the textured one (ComfyUI: templates-textured_logotype,
 * templates-3D_logo_texture_animation). */
export function animatedLogo(): Workflow {
  return {
    id: "template-animated-logo",
    name: t("Animated logo"),
    description: t("A logotype from a brand name, given a material, then brought to life."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("brand", "textInput", t("Brand name"), 0, 0, { text: "Northwind" }),
      node("material", "textInput", t("Material"), 0, 1, {
        text: "brushed gold metal with soft reflections",
      }),
      node("flat", "image", t("Flat logo"), 1, 0, {
        model: LETTERING_MODEL,
        aspectRatio: "16:9",
        prompt:
          "A clean, flat logotype for a brand called {{input}}: the name set in a distinctive bold typeface, centered on a plain off-white background, one accent color, no other elements, no tagline.",
      }),
      node("textured", "imageEdit", t("Textured logo"), 2, 1, {
        model: EDIT_MODEL,
        aspectRatio: "16:9",
        prompt:
          "The same logotype, the same letters, layout and position, now made of {{input}}, lit like a premium studio product shot against a dark background.",
      }),
      node("clip", "video", t("Logo reveal"), 3, 0, {
        model: FRAMES_VIDEO_MODEL,
        duration: "5s",
        prompt:
          "The flat logo transforms smoothly into its textured version, a sweep of light running across the letters. The camera does not move.",
      }),
      node("out-picture", "output", t("Textured logo"), 4, 1),
      node("out", "output", t("Logo reveal"), 4, 0),
    ],
    app: {
      fields: [
        { nodeId: "brand", param: "text", label: t("Your brand's name") },
        { nodeId: "material", param: "text", label: t("What it is made of") },
      ],
      outputs: ["out", "out-picture"],
      intro: t("Write a brand name and a material, get its logo brought to life."),
    },
    edges: [
      edge("brand", "flat", "prompt"),
      edge("flat", "textured", "images"),
      edge("material", "textured", "prompt"),
      edge("flat", "clip", "openingFrame"),
      edge("textured", "clip", "endFrame"),
      edge("textured", "out-picture"),
      edge("clip", "out"),
    ],
  };
}
