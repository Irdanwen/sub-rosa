// Starter workflows that film a shot or a short sequence.

import type { Workflow } from "../schema";
import { t } from "../../../i18n";
import {
  CHAT_MODEL,
  edge,
  FAITHFUL_EDIT_MODEL,
  FRAMES_VIDEO_MODEL,
  IMAGE_MODEL,
  MOTION_VIDEO_MODEL,
  MUSIC_MODEL,
  node,
  REFERENCES_VIDEO_MODEL,
  RESTYLE_VIDEO_MODEL,
  SPEAKING_VIDEO_MODEL,
  TTS_MODEL,
  VIDEO_FROM_IMAGE_MODEL,
  VIDEO_MODEL,
} from "./build";

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

/** An idea drawn as a storyboard, then filmed with the panels as references:
 * the video's references gather every panel, in order
 * (ComfyUI: template_seedance2_storyboard_to_video). */
export function storyboardToVideo(): Workflow {
  return {
    id: "template-storyboard-to-video",
    name: t("Storyboard to video"),
    description: t("An idea drawn as six storyboard panels, then filmed from them."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("idea", "textInput", t("Idea"), 0, 0, {
        text: "A lighthouse keeper rescues a stranded seal pup during a storm and returns it to the sea at dawn.",
      }),
      node("panels", "chat", t("Storyboard"), 1, 0, {
        model: CHAT_MODEL,
        prompt:
          "Write this idea as exactly six storyboard panels for one continuous short film. One line per panel, each a self-contained image description naming the framing, the characters, what happens and the light, with the same characters described the same way in every line. No numbering, no other text.\n\n{{input}}",
      }),
      node("lines", "splitText", t("One per panel"), 2, 0, { max: 6 }),
      node("panel", "image", t("Panel"), 3, 0, {
        model: IMAGE_MODEL,
        aspectRatio: "16:9",
        prompt: "A cinematic storyboard frame, consistent painterly style: {{input}}",
      }),
      node("film", "video", t("Film"), 4, 0, {
        model: REFERENCES_VIDEO_MODEL,
        duration: "10s",
        aspectRatio: "16:9",
        prompt:
          "Refer to the reference images as a storyboard, in order: one continuous cinematic short film that follows the panels shot by shot, the same characters and places throughout, smooth cuts, natural motion.",
      }),
      node("out", "output", t("Film"), 5, 0),
      node("out-panels", "output", t("Storyboard"), 4, 1),
    ],
    app: {
      fields: [{ nodeId: "idea", param: "text", label: t("Your idea") }],
      outputs: ["out", "out-panels"],
      intro: t("Describe an idea, get its storyboard and a short film from it."),
    },
    edges: [
      edge("idea", "panels"),
      edge("panels", "lines", "text"),
      edge("lines", "panel", "prompt"),
      edge("panel", "film", "references"),
      edge("panel", "out-panels"),
      edge("film", "out"),
    ],
  };
}

/** An editorial picture, three more angles of it, and the four joined by
 * clips that run from one picture to the next (ComfyUI: template_contact_sheet
 * steps 1 to 3). */
export function editorialToMotion(): Workflow {
  const angle = (id: string, label: string, row: number, view: string) =>
    node(id, "imageEdit", label, 1, row, {
      model: FAITHFUL_EDIT_MODEL,
      aspectRatio: "16:9",
      prompt: `The same person, outfit, place and light as this picture, seen ${view}. Keep the face and every detail of the clothes.`,
    });
  const clip = (id: string, label: string, row: number) =>
    node(id, "video", label, 2, row, {
      model: FRAMES_VIDEO_MODEL,
      duration: "5s",
      prompt:
        "A smooth camera move from the first picture to the last, the person moving naturally between the two poses. One continuous shot, no cut.",
    });
  return {
    id: "template-editorial-to-motion",
    name: t("Editorial to motion"),
    description: t(
      "A fashion picture seen from four angles, joined by camera moves into one film.",
    ),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("brief", "textInput", t("The shoot"), 0, 0, {
        text: "A model in an oversized camel coat on a rooftop at golden hour, city skyline behind, editorial fashion photography.",
      }),
      node("hero", "image", t("Hero picture"), 0, 1, {
        model: IMAGE_MODEL,
        aspectRatio: "16:9",
      }),
      angle("side", t("Side angle"), 0, "from the side, a full-length profile"),
      angle("close", t("Close angle"), 1, "in a close-up on the face and collar"),
      angle("back", t("Back angle"), 2, "from behind, looking out over the skyline"),
      clip("move-1", t("First move"), 0),
      clip("move-2", t("Second move"), 1),
      clip("move-3", t("Third move"), 2),
      node("film", "assemble", t("Film"), 3, 0),
      node("out", "output", t("Film"), 4, 0),
    ],
    app: {
      fields: [{ nodeId: "brief", param: "text", label: t("Describe the shoot") }],
      outputs: ["out"],
      intro: t("Describe a fashion picture, get it turned into a short film."),
    },
    edges: [
      edge("brief", "hero", "prompt"),
      edge("hero", "side", "images"),
      edge("hero", "close", "images"),
      edge("hero", "back", "images"),
      edge("hero", "move-1", "openingFrame"),
      edge("side", "move-1", "endFrame"),
      edge("side", "move-2", "openingFrame"),
      edge("close", "move-2", "endFrame"),
      edge("close", "move-3", "openingFrame"),
      edge("back", "move-3", "endFrame"),
      // Cut in connection order: each move picks up where the last one ended.
      edge("move-1", "film", "clips"),
      edge("move-2", "film", "clips"),
      edge("move-3", "film", "clips"),
      edge("film", "out"),
    ],
  };
}

/** A clip carried on past its end: its last sharp frame opens a new shot,
 * and the two are cut together (ComfyUI: api_seedance2_5_video_extend). */
export function extendAClip(): Workflow {
  return {
    id: "template-extend-a-clip",
    name: t("Extend a clip"),
    description: t("A clip carried on past its end, then cut together with the original."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("clip", "asset", t("Your clip"), 0, 0, { assetKind: "video" }),
      node("frame", "lastFrame", t("Handoff frame"), 1, 1, { position: "handoff" }),
      node("more", "video", t("What happens next"), 2, 1, {
        model: VIDEO_FROM_IMAGE_MODEL,
        duration: "5s",
        prompt:
          "Continue the shot, no cut: the camera keeps moving the same way and the action carries on naturally. Same light, same people, same place.",
      }),
      node("film", "assemble", t("Extended"), 3, 0),
      node("out", "output", t("Extended clip"), 4, 0),
    ],
    app: {
      fields: [
        { nodeId: "clip", param: "artifactId", label: t("Your clip") },
        { nodeId: "more", param: "prompt", label: t("What happens next") },
      ],
      outputs: ["out"],
      intro: t("Pick a clip and say what happens next, get it longer."),
    },
    edges: [
      edge("clip", "frame", "video"),
      edge("frame", "more", "openingFrame"),
      // Cut in connection order: the original, then its continuation.
      edge("clip", "film", "clips"),
      edge("more", "film", "clips"),
      edge("film", "out"),
    ],
  };
}

/** A portrait that says a line: the line read aloud, then followed by the
 * clip as its soundtrack (ComfyUI: api_heygen_talking_photo,
 * template_image_speech_to_video). */
export function talkingPhoto(): Workflow {
  return {
    id: "template-talking-photo",
    name: t("Talking photo"),
    description: t("A portrait that says the words you write."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("portrait", "asset", t("Portrait"), 0, 0, { assetKind: "image" }),
      node("line", "textInput", t("What they say"), 0, 1, {
        text: "Hello there. I am only a photograph, but today I learned how to speak.",
      }),
      node("voice", "tts", t("Voice"), 1, 1, { model: TTS_MODEL, voice: "am_michael" }),
      node("clip", "video", t("Speaking"), 2, 0, {
        model: SPEAKING_VIDEO_MODEL,
        duration: "5s",
        prompt:
          "The person in the picture looks into the camera and says the words of the audio, natural lip movement, small head movements and blinks.",
      }),
      node("out", "output", t("Talking photo"), 3, 0),
    ],
    app: {
      fields: [
        { nodeId: "portrait", param: "artifactId", label: t("A portrait") },
        { nodeId: "line", param: "text", label: t("What they say") },
      ],
      outputs: ["out"],
      intro: t("Pick a portrait and write a line, watch it say the line."),
    },
    edges: [
      edge("portrait", "clip", "openingFrame"),
      edge("line", "voice", "text"),
      edge("voice", "clip", "speech"),
      edge("clip", "out"),
    ],
  };
}

/** A clip remade in another style, its motion and framing kept
 * (ComfyUI: api_kling_o3_video_edit, api_runway_aleph2_video_edit). */
export function restyleAClip(): Workflow {
  return {
    id: "template-restyle-a-clip",
    name: t("Restyle a clip"),
    description: t("A clip remade in another style, the same motion and framing."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("clip", "asset", t("Your clip"), 0, 0, { assetKind: "video" }),
      node("restyled", "video", t("Restyled"), 1, 0, {
        model: RESTYLE_VIDEO_MODEL,
        prompt:
          "Restyle this clip as a hand-painted watercolor animation on textured paper. Keep the same people, movements, framing and timing.",
      }),
      node("out", "output", t("Restyled clip"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "clip", param: "artifactId", label: t("Your clip") },
        { nodeId: "restyled", param: "prompt", label: t("The new style") },
      ],
      outputs: ["out"],
      intro: t("Pick a clip and describe a style, get the clip in that style."),
    },
    edges: [edge("clip", "restyled", "sourceClip"), edge("restyled", "out")],
  };
}

/** A character of your own performing what someone does in a clip
 * (ComfyUI: template_seedance2_0_viral_videos_character_swap). */
export function recastAClip(): Workflow {
  return {
    id: "template-recast-a-clip",
    name: t("Recast a clip"),
    description: t("Your character performing the movements of someone in a clip."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("character", "asset", t("Your character"), 0, 0, { assetKind: "image" }),
      node("clip", "asset", t("The clip"), 0, 1, { assetKind: "video" }),
      node("recast", "video", t("Recast"), 1, 0, {
        model: MOTION_VIDEO_MODEL,
        prompt:
          "The character from the picture performs exactly the movements of the person in the clip, with the character's own face, body and clothes.",
      }),
      node("out", "output", t("Recast clip"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "character", param: "artifactId", label: t("A picture of your character") },
        { nodeId: "clip", param: "artifactId", label: t("A clip of the movements") },
      ],
      outputs: ["out"],
      intro: t("Pick a character and a clip, watch the character move like it."),
    },
    edges: [
      edge("character", "recast", "openingFrame"),
      edge("clip", "recast", "sourceClip"),
      edge("recast", "out"),
    ],
  };
}
