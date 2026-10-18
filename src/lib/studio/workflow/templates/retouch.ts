// Starter workflows that change a picture a person brings.

import type { Workflow } from "../schema";
import { t } from "../../../i18n";
import { PREFERRED_RETOUCH_MODEL } from "../../retouch/request";
import { TRY_ON_MODEL_PREFERENCE, tryOnPrompt } from "../../try-on";
import { edge, node } from "./build";

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
