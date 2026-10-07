/**
 * Which models protected mode hides (ADR-0084). No dependencies, so the
 * Studio catalog can import it without a cycle through `protected-mode.ts`.
 */

/** Mirrors `ADULT_MARKERS` in `protected_mode/guards.rs`; keep both the same. */
export const ADULT_MARKERS = ["uncensored", "lustify", "nsfw", "heretic", "abliterat"] as const;

type ModelSignals = { id: string; name?: string; traits?: string[] };

/** Whether a model belongs to an adult or uncensored family, by its id, its
 * name or a catalog trait (Venice tags the most permissive `most_uncensored`). */
export function isAdultModel(model: ModelSignals): boolean {
  return [model.id, model.name ?? "", ...(model.traits ?? [])].some((text) => {
    const lower = text.toLowerCase();
    return ADULT_MARKERS.some((marker) => lower.includes(marker));
  });
}

/** `models` without adult families when `enabled`. */
export function withoutAdultModels<T extends ModelSignals>(models: T[], enabled: boolean): T[] {
  return enabled ? models.filter((model) => !isAdultModel(model)) : models;
}
