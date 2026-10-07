import { stripReasoningEffortAlias } from "./desktop-reasoning-effort";
import { IMAGE_MODELS } from "./image-models";
import { humanizeModelId } from "./studio/catalog";
import type { MediaCatalog } from "./studio/types";

/**
 * The name a person reads for a model id.
 *
 * The sidecar reports Carpe Diem's catalog with each id as its own display
 * name, so the phone's Models screen read "z-ai-glm-5-3-flash". A name equal
 * to its id is no name at all: the media catalog, which carries Venice's
 * published names, is asked next, then the curated image list, and only then
 * is the id made presentable.
 */
export function readableModelName(
  model: string,
  reported?: string,
  catalog?: MediaCatalog | null,
): string {
  // A desktop chat's model can carry its reasoning effort (ADR-0080); the
  // name is the model's, never the alias's.
  const id = stripReasoningEffortAlias(model);
  const given = reported?.trim();
  if (given && given !== id) return given;
  const published = catalog?.models.find((model) => model.id === id)?.name?.trim();
  if (published && published !== id) return published;
  const curated = IMAGE_MODELS.find((model) => model.id === id)?.name;
  if (curated) return curated;
  const bare = id.split("/").pop() || id;
  return humanizeModelId(bare);
}
