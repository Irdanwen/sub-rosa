// How hard a reasoning model thinks before it answers. One module for both
// shells: the same three levels, the same capability check and the same names
// on the phone (which sends the flat `reasoning_effort` field of the
// completion) and on the desktop (which carries it on the model name, see the
// alias below). An effort is offered only for a model whose catalog entry says
// it honours one (`supportsReasoningEffort`): another model may refuse the
// field outright, which would turn a preference into a failed turn.

import {
  effortForModel,
  parseReasoningEffort,
  type ReasoningCapable,
  type ReasoningEffort,
  stripReasoningEffortAlias,
  withReasoningEffortAlias,
} from "@subrosa/chat-core/reasoning-effort";
import { t } from "./i18n";

export * from "@subrosa/chat-core/reasoning-effort";

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
      return t("Default effort");
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

// The desktop carries the effort as a model alias (ADR-0080): see
// `@subrosa/chat-core/reasoning-effort` for why.

const DESKTOP_PREFERENCE_KEY = "os-june:desktop-reasoning-effort";

function readDesktopPreferences(): Record<string, ReasoningEffort> {
  try {
    const raw = window.localStorage.getItem(DESKTOP_PREFERENCE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, ReasoningEffort] => parseReasoningEffort(entry[1]) !== undefined,
      ),
    );
  } catch {
    return {};
  }
}

/** The effort the person picked for this model on this desktop, if any. The
 * desktop keeps one choice per model; the phone keeps one for its chat. */
export function desktopReasoningEffortFor(modelId: string): ReasoningEffort | undefined {
  return readDesktopPreferences()[stripReasoningEffortAlias(modelId)];
}

/** Remembers (or, with `undefined`, forgets) the effort for one model. */
export function setDesktopReasoningEffort(modelId: string, effort: ReasoningEffort | undefined) {
  const preferences = readDesktopPreferences();
  const key = stripReasoningEffortAlias(modelId);
  if (effort) preferences[key] = effort;
  else delete preferences[key];
  try {
    window.localStorage.setItem(DESKTOP_PREFERENCE_KEY, JSON.stringify(preferences));
  } catch {
    // A blocked storage keeps the default effort; nothing to surface.
  }
}

/** The model string to hand Hermes for this catalog id: the alias when the
 * model takes an effort and one is chosen, the bare id otherwise (an
 * unresolved model never gets one, so a stale catalog cannot send a field a
 * model would reject). */
export function desktopRuntimeModel(
  modelId: string,
  catalog: readonly (ReasoningCapable & { id: string })[],
): string {
  const bare = stripReasoningEffortAlias(modelId);
  const model = catalog.find((entry) => entry.id === bare);
  return withReasoningEffortAlias(bare, effortForModel(model, desktopReasoningEffortFor(bare)));
}
