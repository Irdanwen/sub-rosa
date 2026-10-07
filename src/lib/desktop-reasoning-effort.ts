import type { VeniceModelDto } from "./tauri";

/**
 * Reasoning effort on the desktop chat, carried as a model ALIAS (ADR-0080).
 *
 * The pinned Hermes only emits a reasoning field for a few hosted routes
 * (`_supports_reasoning_extra_body()` in its run_agent.py), never for the
 * loopback provider Sub Rosa points it at, and the shell's provider proxy is
 * shared by every session of a process, so it cannot tell which chat a request
 * belongs to. The model name is the one thing Hermes forwards per session,
 * verbatim, on every request. So the chosen effort rides on it:
 * `zai-org-glm-5-2@reasoning-effort=high`. The proxy in `hermes_bridge`
 * (`provider_proxy.rs`) strips the suffix and sets the flat `reasoning_effort`
 * field before the body reaches the sidecar, so metering, pricing and the
 * catalog only ever see the real id.
 *
 * The suffix is long on purpose: Hermes auto-corrects a `/model` value that is
 * at least 90% similar to a listed id, and a short suffix on a long id would
 * be "corrected" back to the bare model, silently dropping the effort.
 */
export const REASONING_EFFORT_ALIAS_MARKER = "@reasoning-effort=";

export const DESKTOP_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type DesktopReasoningEffort = (typeof DESKTOP_REASONING_EFFORTS)[number];

const PREFERENCE_KEY = "os-june:desktop-reasoning-effort";

function isEffort(value: unknown): value is DesktopReasoningEffort {
  return (DESKTOP_REASONING_EFFORTS as readonly unknown[]).includes(value);
}

/** The model string Hermes is handed: the bare id, or the id with its effort. */
export function withReasoningEffortAlias(
  modelId: string,
  effort: DesktopReasoningEffort | null | undefined,
): string {
  const bare = stripReasoningEffortAlias(modelId);
  return effort ? `${bare}${REASONING_EFFORT_ALIAS_MARKER}${effort}` : bare;
}

/** Splits an alias back into the catalog id and the effort it carries. A
 * string without the marker is a plain id; an unknown effort is dropped
 * rather than passed on, so the id stays usable. */
export function parseReasoningEffortAlias(model: string): {
  modelId: string;
  effort?: DesktopReasoningEffort;
} {
  const index = model.lastIndexOf(REASONING_EFFORT_ALIAS_MARKER);
  if (index <= 0) return { modelId: model };
  const effort = model.slice(index + REASONING_EFFORT_ALIAS_MARKER.length).trim();
  const modelId = model.slice(0, index);
  return isEffort(effort) ? { modelId, effort } : { modelId };
}

/** The real catalog id behind whatever Hermes reports. Every surface that
 * shows, prices or looks up a model passes through this. */
export function stripReasoningEffortAlias(model: string): string;
export function stripReasoningEffortAlias(model: string | undefined): string | undefined;
export function stripReasoningEffortAlias(model: string | undefined) {
  return model === undefined ? undefined : parseReasoningEffortAlias(model).modelId;
}

/** Whether the catalog says this model takes a reasoning effort. Keyed off the
 * authoritative capability flag (`supportsReasoningEffort`) only; plain
 * `supportsReasoning` is a model that thinks, not one whose thinking can be
 * dialled. */
export function modelSupportsReasoningEffort(
  model: Partial<Pick<VeniceModelDto, "capabilities">> | undefined,
): boolean {
  return (model?.capabilities ?? []).some((capability) =>
    capability
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .includes("supportsreasoningeffort"),
  );
}

function readPreferences(): Record<string, DesktopReasoningEffort> {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, DesktopReasoningEffort] => isEffort(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** The effort the person picked for this model on this device, if any. */
export function desktopReasoningEffortFor(modelId: string): DesktopReasoningEffort | undefined {
  return readPreferences()[stripReasoningEffortAlias(modelId)];
}

/** Remembers (or, with `undefined`, forgets) the effort for one model. */
export function setDesktopReasoningEffort(
  modelId: string,
  effort: DesktopReasoningEffort | undefined,
): void {
  const preferences = readPreferences();
  const key = stripReasoningEffortAlias(modelId);
  if (effort) preferences[key] = effort;
  else delete preferences[key];
  try {
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences));
  } catch {
    // A blocked storage keeps the default effort; nothing to surface.
  }
}

/** The model string to hand Hermes for this catalog id: the alias when the
 * model takes an effort and one is chosen, the bare id otherwise (an
 * unresolved model never gets one, so a stale catalog cannot send a field a
 * model would reject). */
export function desktopRuntimeModel(modelId: string, catalog: readonly VeniceModelDto[]): string {
  const bare = stripReasoningEffortAlias(modelId);
  const model = catalog.find((entry) => entry.id === bare);
  return withReasoningEffortAlias(
    bare,
    modelSupportsReasoningEffort(model) ? desktopReasoningEffortFor(bare) : undefined,
  );
}
