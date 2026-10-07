// How hard a reasoning model thinks before it answers. The chat sends it as
// the flat `reasoning_effort` field of the completion, and only for a model
// whose catalog entry says it honours one (`supportsReasoningEffort`): another
// model may refuse the field outright, which would turn a preference into a
// failed turn. Shared by the phone chat and, later, the desktop agent, so the
// two offer the same choices under the same names.

import { t } from "./i18n";

export type ReasoningEffort = "low" | "medium" | "high";

/** The choices, in the order a picker lists them. "Default" (no effort sent,
 * the provider decides) comes before them and is not a value. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

/** The two catalog shapes that describe a text model: the media catalog
 * (`supportsReasoningEffort`) and the provider model list (capability
 * names). */
export type ReasoningCapable = {
  supportsReasoningEffort?: boolean;
  capabilities?: readonly string[];
};

export function supportsReasoningEffort(model: ReasoningCapable | null | undefined): boolean {
  if (!model) return false;
  return (
    model.supportsReasoningEffort === true ||
    (model.capabilities ?? []).includes("supportsReasoningEffort")
  );
}

/** A stored or received value, read strictly: anything unknown is the
 * default. */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return REASONING_EFFORTS.find((effort) => effort === value);
}

/** What to send for a turn on `model`: the chosen effort when the model
 * honours one, nothing otherwise. A choice made on one model is kept for the
 * next capable one rather than cleared when the user passes through another. */
export function effortForModel(
  model: ReasoningCapable | null | undefined,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  return effort && supportsReasoningEffort(model) ? effort : undefined;
}

/** The name of a choice. Each names the effort in full: "Medium" alone
 * already means a shot size in the catalog, and would translate as one. */
export function reasoningEffortLabel(effort: ReasoningEffort | undefined): string {
  switch (effort) {
    case "low":
      return t("Low effort");
    case "medium":
      return t("Medium effort");
    case "high":
      return t("High effort");
    default:
      return t("Default");
  }
}

export function storedReasoningEffort(key: string): ReasoningEffort | undefined {
  try {
    return parseReasoningEffort(localStorage.getItem(key));
  } catch {
    return undefined;
  }
}

export function storeReasoningEffort(key: string, effort: ReasoningEffort | undefined) {
  try {
    if (effort) localStorage.setItem(key, effort);
    else localStorage.removeItem(key);
  } catch {
    // Remembering it is a convenience; the in-memory choice still applies.
  }
}
