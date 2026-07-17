/**
 * Per-turn model routing for the mobile chat (agent-lite).
 *
 * The model is a per-turn choice on agent-lite (the whole transcript is re-sent
 * each turn with a `model` field), so a single turn can run on a different model
 * than the chat's default. The first use: an image turn must reach a
 * vision-capable model even when the user's chosen chat model is text-only, so
 * attaching a photo "just works" without making them switch models by hand.
 *
 * Pure and catalog-shaped so it unit-tests apart from the chat screen. General
 * enough to grow other task-based routing later (e.g. an "auto" model).
 */

import type { MediaModel } from "./studio/types";

/** Whether a chat model can read image input. Mirrors the mobile picker's
 * vision badge: the catalog's `supportsVision` flag, or a `vision` trait as a
 * defensive fallback for models that only advertise it in `traits`. */
export function mediaModelSupportsVision(model: MediaModel | undefined): boolean {
  return Boolean(model?.supportsVision || model?.traits?.some((trait) => trait.includes("vision")));
}

/**
 * The model id a turn should actually run on. A text-only chat model is
 * transparently swapped for a vision-capable one on an image turn (leaving the
 * user's persistent chat model untouched); every other turn keeps the selected
 * model. When the selected model is unknown (e.g. the "Default" option) it is
 * treated as non-vision, so an image turn still routes to a known vision model
 * rather than risk a blind default silently dropping the image.
 *
 * Falls back to the selected model when no vision-capable model is available,
 * so callers never break — the turn just behaves as before.
 */
export function resolveTurnModel(params: {
  selectedModelId: string;
  models: MediaModel[];
  hasImages: boolean;
}): string {
  const { selectedModelId, models, hasImages } = params;
  if (!hasImages) return selectedModelId;
  const selected = models.find((model) => model.id === selectedModelId);
  if (mediaModelSupportsVision(selected)) return selectedModelId;
  const visionModel = models.find(mediaModelSupportsVision);
  return visionModel?.id ?? selectedModelId;
}
