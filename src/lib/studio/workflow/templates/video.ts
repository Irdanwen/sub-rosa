// Starter workflows that film a shot or a short sequence.

import type { Workflow } from "../schema";
import { t } from "../../../i18n";
import { CHAT_MODEL, MUSIC_MODEL, VIDEO_MODEL, VIDEO_FROM_IMAGE_MODEL, edge, node } from "./build";

export function shortVideoAd(): Workflow {
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
export function twoShotSequence(): Workflow {
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
export function shortFilm(): Workflow {
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

/** A story idea written as three shots, each shot filmed, the three cut
 * together: the list is cut during the run (ADR-0117). */
export function storyInThreeShots(): Workflow {
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
