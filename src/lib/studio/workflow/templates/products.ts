// Starter workflows for a product: a photo of it made into a packshot, a
// clip, an ad or a scene. Each one is re-authored from a recipe in ComfyUI's
// official gallery (ADR-0121), named in its comment.

import type { Workflow } from "../schema";
import { t } from "../../../i18n";
import { EDIT_MODEL, edge, FRAMES_VIDEO_MODEL, node, VIDEO_FROM_IMAGE_MODEL } from "./build";

/** What every product edit asks for, whatever the setting: the product
 * itself must not change. */
const KEEP_THE_PRODUCT =
  "Keep the product exactly as it is: same shape, proportions, materials, colors, label and text.";

/** A phone photo of a product made into a clean studio packshot
 * (ComfyUI: templates-product_scene_relight). */
export function productStudioShot(): Workflow {
  return {
    id: "template-product-studio-shot",
    name: t("Product studio shot"),
    description: t("A phone photo of a product, made into a clean studio packshot."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("product", "asset", t("Product photo"), 0, 0, { assetKind: "image" }),
      node("set", "textInput", t("The set"), 0, 1, {
        text: "a seamless light grey backdrop, soft key light from the upper left, a gentle reflection under the product",
      }),
      node("packshot", "imageEdit", t("Packshot"), 1, 0, {
        model: EDIT_MODEL,
        aspectRatio: "1:1",
        prompt: `Turn this photo into a professional studio packshot of the same product, centered, on {{input}}. Crisp focus, true colors, no other objects, no added text. ${KEEP_THE_PRODUCT}`,
      }),
      node("out", "output", t("Packshot"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "product", param: "artifactId", label: t("Your product photo") },
        { nodeId: "set", param: "text", label: t("The set") },
      ],
      outputs: ["out"],
      intro: t("Pick a photo of a product, get a studio packshot."),
    },
    edges: [
      edge("product", "packshot", "images"),
      edge("set", "packshot", "prompt"),
      edge("packshot", "out"),
    ],
  };
}

/** The packshot, then a few seconds of it turning in the light
 * (ComfyUI: templates-photo_to_product_vid). */
export function productToVideo(): Workflow {
  return {
    id: "template-product-to-video",
    name: t("Product video from a photo"),
    description: t("A phone photo of a product, made into a packshot and a short clip of it."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("product", "asset", t("Product photo"), 0, 0, { assetKind: "image" }),
      node("packshot", "imageEdit", t("Packshot"), 1, 0, {
        model: EDIT_MODEL,
        aspectRatio: "16:9",
        prompt: `Turn this photo into a premium studio shot of the same product on a dark, softly lit surface with a subtle gradient behind it, room on both sides. ${KEEP_THE_PRODUCT}`,
      }),
      node("clip", "video", t("Product clip"), 2, 0, {
        model: VIDEO_FROM_IMAGE_MODEL,
        duration: "5s",
        prompt:
          "A slow orbit around the product, a soft highlight gliding across its surface, shallow depth of field. The product stays perfectly still and unchanged.",
      }),
      node("out-picture", "output", t("Packshot"), 3, 1),
      node("out", "output", t("Clip"), 3, 0),
    ],
    app: {
      fields: [
        { nodeId: "product", param: "artifactId", label: t("Your product photo") },
        { nodeId: "clip", param: "prompt", label: t("The camera move") },
      ],
      outputs: ["out", "out-picture"],
      intro: t("Pick a photo of a product, get a packshot and a short clip."),
    },
    edges: [
      edge("product", "packshot", "images"),
      edge("packshot", "clip", "openingFrame"),
      edge("packshot", "out-picture"),
      edge("clip", "out"),
    ],
  };
}

/** A person and a product, composed into the person holding it
 * (ComfyUI: templates-subject_holding_product). */
export function productInHand(): Workflow {
  return {
    id: "template-product-in-hand",
    name: t("Product in hand"),
    description: t("A photo of a person and a photo of a product: the person holding it."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("person", "asset", t("The person"), 0, 0, { assetKind: "image" }),
      node("product", "asset", t("The product"), 0, 1, { assetKind: "image" }),
      node("holding", "imageEdit", t("Holding it"), 1, 0, {
        model: EDIT_MODEL,
        aspectRatio: "4:5",
        prompt: `The person from the first picture holds the product from the second picture in one hand, at chest height, turned toward the camera, with a natural grip and a relaxed expression. Keep the person's face, hair and clothes. Match the light and shadows of the first picture. ${KEEP_THE_PRODUCT}`,
      }),
      node("out", "output", t("Picture"), 2, 0),
    ],
    app: {
      fields: [
        { nodeId: "person", param: "artifactId", label: t("A photo of the person") },
        { nodeId: "product", param: "artifactId", label: t("A photo of the product") },
      ],
      outputs: ["out"],
      intro: t("Pick a person and a product, see the person holding it."),
    },
    // The person first: the edit keeps image 1 and borrows from image 2.
    edges: [
      edge("person", "holding", "images"),
      edge("product", "holding", "images"),
      edge("holding", "out"),
    ],
  };
}

/** An ad you like, remade around your product, then set in motion
 * (ComfyUI: templates-product_ad-v2.0). */
export function adInTheStyleOf(): Workflow {
  return {
    id: "template-ad-in-the-style-of",
    name: t("Ad in the style of another"),
    description: t("An ad you like, remade around your product, then set in motion."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("product", "asset", t("Your product"), 0, 0, { assetKind: "image" }),
      node("reference", "asset", t("An ad you like"), 0, 1, { assetKind: "image" }),
      node("ad", "imageEdit", t("Your ad"), 1, 0, {
        model: EDIT_MODEL,
        aspectRatio: "9:16",
        prompt: `Recreate the advertisement of the second picture with the product of the first picture as its hero: the same composition, set, lighting, color grade and mood, the product in place of the advertised one. Leave out the original brand and its text. ${KEEP_THE_PRODUCT}`,
      }),
      node("clip", "video", t("Ad clip"), 2, 0, {
        model: VIDEO_FROM_IMAGE_MODEL,
        duration: "5s",
        prompt:
          "The camera pushes in slowly toward the product, light shifting gently across the set, a premium commercial feel. The product does not change.",
      }),
      node("out-picture", "output", t("Ad picture"), 3, 1),
      node("out", "output", t("Ad clip"), 3, 0),
    ],
    app: {
      fields: [
        { nodeId: "product", param: "artifactId", label: t("Your product") },
        { nodeId: "reference", param: "artifactId", label: t("An ad you like") },
      ],
      outputs: ["out", "out-picture"],
      intro: t("Pick your product and an ad you like, get the same ad for your product."),
    },
    edges: [
      edge("product", "ad", "images"),
      edge("reference", "ad", "images"),
      edge("ad", "clip", "openingFrame"),
      edge("ad", "out-picture"),
      edge("clip", "out"),
    ],
  };
}

/** An object coming apart into its exploded view: the photo is the first
 * frame, the exploded view the last (ComfyUI: template_eric_exploded_view). */
export function explodedView(): Workflow {
  return {
    id: "template-exploded-view",
    name: t("Exploded view"),
    description: t("An object coming apart, part by part, into its exploded view."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("object", "asset", t("The object"), 0, 0, { assetKind: "image" }),
      node("exploded", "imageEdit", t("Exploded view"), 1, 1, {
        model: EDIT_MODEL,
        prompt:
          "The same object as a technical exploded view: every part separated along one axis and floating in assembly order with even gaps, the same materials and colors, the same camera angle and framing, on the same background.",
      }),
      node("clip", "video", t("Coming apart"), 2, 0, {
        model: FRAMES_VIDEO_MODEL,
        duration: "5s",
        prompt:
          "The object comes apart smoothly into its exploded view, each part sliding outward along one axis in turn. The camera does not move. Clean studio light.",
      }),
      node("out-picture", "output", t("Exploded view"), 3, 1),
      node("out", "output", t("Clip"), 3, 0),
    ],
    app: {
      fields: [{ nodeId: "object", param: "artifactId", label: t("A photo of the object") }],
      outputs: ["out", "out-picture"],
      intro: t("Pick a photo of an object, watch it come apart."),
    },
    edges: [
      edge("object", "exploded", "images"),
      edge("object", "clip", "openingFrame"),
      edge("exploded", "clip", "endFrame"),
      edge("exploded", "out-picture"),
      edge("clip", "out"),
    ],
  };
}

/** A product placed in a scene of your own, then filmed there
 * (ComfyUI: template_product_placement). */
export function productPlacement(): Workflow {
  return {
    id: "template-product-placement",
    name: t("Product placement"),
    description: t("Your product placed in a scene of your choice, then filmed there."),
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("product", "asset", t("The product"), 0, 0, { assetKind: "image" }),
      node("scene", "asset", t("The scene"), 0, 1, { assetKind: "image" }),
      node("placed", "imageEdit", t("Placed"), 1, 0, {
        model: EDIT_MODEL,
        prompt: `Place the product of the first picture into the scene of the second picture, on the most natural surface, at a believable size, with the scene's light, shadows and reflections on it. Keep the scene as it is. ${KEEP_THE_PRODUCT}`,
      }),
      node("clip", "video", t("Scene clip"), 2, 0, {
        model: VIDEO_FROM_IMAGE_MODEL,
        duration: "5s",
        prompt:
          "A slow handheld push in toward the product, natural movement in the scene around it. The product stays exactly as it is.",
      }),
      node("out-picture", "output", t("Placed"), 3, 1),
      node("out", "output", t("Clip"), 3, 0),
    ],
    app: {
      fields: [
        { nodeId: "product", param: "artifactId", label: t("A photo of the product") },
        { nodeId: "scene", param: "artifactId", label: t("A photo of the scene") },
      ],
      outputs: ["out", "out-picture"],
      intro: t("Pick a product and a scene, see the product there."),
    },
    // The product first: it is what the edit must keep.
    edges: [
      edge("product", "placed", "images"),
      edge("scene", "placed", "images"),
      edge("placed", "clip", "openingFrame"),
      edge("placed", "out-picture"),
      edge("clip", "out"),
    ],
  };
}
