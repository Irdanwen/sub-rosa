// Starter workflows that change a picture a person brings.

import type { Workflow } from "../schema";
import { t } from "../../../i18n";
import { PREFERRED_RETOUCH_MODEL } from "../../retouch/request";
import { TRY_ON_MODEL_PREFERENCE, tryOnPrompt } from "../../try-on";
import { EDIT_MODEL, edge, FAITHFUL_EDIT_MODEL, node } from "./build";

/** Virtual try-on: a photo of a person and a photo of a garment, composed
 * into the person wearing it. The prompt is the tuned one the chat card uses
 * (`try-on.ts`); both photos are picked from the gallery before a run. */
export function tryItOn(): Workflow {
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

/** Nine views of one character in one sheet, from a single picture. */
export function characterSheet(): Workflow {
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

/** One part of a picture changed, the rest left as it was, both side by side. */
export function beforeAndAfter(): Workflow {
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
      outputs: ["out"],
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

/** A picture made four times larger, for a print or a large screen. */
export function upscaleForPrint(): Workflow {
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
      intro: t("Pick a picture, get a copy four times larger."),
    },
    edges: [edge("picture", "up", "image"), edge("up", "out")],
  };
}

/** One portrait relit several ways, one picture per light: the edit runs
 * once for each line of the list (ComfyUI: template_character_portrait_relighting). */
export function relightAPortrait(): Workflow {
  return {
    id: "template-relight-a-portrait",
    name: t("Relight a portrait"),
    description: t("One portrait, relit several ways: one picture per light."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("portrait", "asset", t("Portrait"), 0, 0, { assetKind: "image" }),
      node("lights", "textList", t("Lights"), 0, 1, {
        items:
          "warm golden hour sun from the side\ncool blue moonlight through a window\nneon pink and teal from both sides\nsoft overhead studio light, white background",
      }),
      node("relit", "imageEdit", t("Relit"), 1, 0, {
        model: FAITHFUL_EDIT_MODEL,
        prompt:
          "Relight this portrait with {{input}}. Keep the person exactly: face, expression, hair, clothes and pose, the same framing. Only the light, the shadows and the colors it casts change.",
      }),
      node("out", "output", t("Portraits"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "portrait", param: "artifactId", label: t("The portrait") },
        { nodeId: "lights", param: "items", label: t("Lights, one per line") },
      ],
      outputs: ["out"],
      intro: t("Pick a portrait and list some lights, get it in each one."),
    },
    edges: [
      edge("portrait", "relit", "images"),
      edge("lights", "relit", "prompt"),
      edge("relit", "out"),
    ],
  };
}

/** The angles a film editor wants of one shot, each made from the same
 * picture (ComfyUI: templates-multiple_consistent_shots, template_contact_sheet). */
export function coverageFromOneShot(): Workflow {
  return {
    id: "template-coverage-from-one-shot",
    name: t("Coverage from one shot"),
    description: t("The same scene from several camera angles, from one picture."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("shot", "asset", t("The shot"), 0, 0, { assetKind: "image" }),
      node("angles", "textList", t("Angles"), 0, 1, {
        items:
          "a wide establishing shot showing the whole place\na medium shot from the other side\na close-up on the face\nan over-the-shoulder shot\na low angle looking up\na high angle looking down",
      }),
      node("angle", "imageEdit", t("Angle"), 1, 0, {
        model: FAITHFUL_EDIT_MODEL,
        aspectRatio: "16:9",
        prompt:
          "The same scene and moment as this picture, seen as {{input}}. Keep the same people, faces, clothes, place, light and time of day, as if a second camera were rolling.",
      }),
      node("out", "output", t("Angles"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "shot", param: "artifactId", label: t("The shot") },
        { nodeId: "angles", param: "items", label: t("Angles, one per line") },
      ],
      outputs: ["out"],
      intro: t("Pick a shot and list some angles, get the scene from each one."),
    },
    edges: [
      edge("shot", "angle", "images"),
      edge("angles", "angle", "prompt"),
      edge("angle", "out"),
    ],
  };
}

/** A character dressed in an outfit, in a few poses of a fashion shoot
 * (ComfyUI: templates_rob_fashion_shoot_vton-4in1). */
export function outfitShoot(): Workflow {
  return {
    id: "template-outfit-shoot",
    name: t("Outfit shoot"),
    description: t("A person and an outfit: a short fashion shoot of them wearing it."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("person", "asset", t("The person"), 0, 0, { assetKind: "image" }),
      node("outfit", "asset", t("The outfit"), 0, 1, { assetKind: "image" }),
      node("poses", "textList", t("Poses"), 0, 2, {
        items:
          "standing full length, facing the camera\nwalking toward the camera, mid stride\nseated on a low stool, looking away\na three-quarter close-up, hands in pockets",
      }),
      node("look", "imageEdit", t("Look"), 1, 0, {
        model: FAITHFUL_EDIT_MODEL,
        aspectRatio: "3:4",
        prompt:
          "A fashion photograph of the person from the first picture wearing the outfit from the second picture, {{input}}, in a bright minimal studio. Keep the person's face, hair and body. Keep every piece of the outfit, its cut, fabric and colors.",
      }),
      node("out", "output", t("Looks"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "person", param: "artifactId", label: t("A photo of the person") },
        { nodeId: "outfit", param: "artifactId", label: t("A photo of the outfit") },
        { nodeId: "poses", param: "items", label: t("Poses, one per line") },
      ],
      outputs: ["out"],
      intro: t("Pick a person and an outfit, get a short fashion shoot."),
    },
    // The person first: the edit keeps image 1 and borrows from image 2.
    edges: [
      edge("person", "look", "images"),
      edge("outfit", "look", "images"),
      edge("poses", "look", "prompt"),
      edge("look", "out"),
    ],
  };
}

/** Something taken out of a picture, the gap filled, the two side by side
 * (ComfyUI: api_flux_erase_image, api_bria_genfill). */
export function removeAnObject(): Workflow {
  return {
    id: "template-remove-an-object",
    name: t("Remove an object"),
    description: t("Something taken out of a picture, the gap filled as if it never was."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("picture", "asset", t("Picture"), 0, 0, { assetKind: "image" }),
      node("what", "textInput", t("What to remove"), 0, 1, {
        text: "the tourists in the background",
      }),
      node("removed", "imageEdit", t("Removed"), 1, 0, {
        model: EDIT_MODEL,
        prompt:
          "Remove {{input}} from this picture and fill the space with what would naturally be behind it, matching the light, texture and perspective. Change nothing else.",
      }),
      node("compare", "compare", t("Before and after"), 2, 0),
      node("out", "output", t("Cleaned up"), 2, 1),
    ],
    app: {
      fields: [
        { nodeId: "picture", param: "artifactId", label: t("The picture") },
        { nodeId: "what", param: "text", label: t("What to remove") },
      ],
      outputs: ["out"],
      intro: t("Pick a picture and say what to remove."),
    },
    edges: [
      edge("picture", "removed", "images"),
      edge("what", "removed", "prompt"),
      edge("picture", "compare", "before"),
      edge("removed", "compare", "after"),
      edge("removed", "out"),
    ],
  };
}
