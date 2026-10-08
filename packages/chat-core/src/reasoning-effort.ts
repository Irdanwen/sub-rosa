// How hard a reasoning model thinks before it answers: the levels, the
// capability check and the model alias, shared by both app shells and the web
// client. The names of the levels are each surface's own copy
// (`src/lib/reasoning-effort.ts` in the app).
//
// An effort is offered only for a model whose catalog entry says it honours
// one (`supportsReasoningEffort`): another model may refuse the field
// outright, which would turn a preference into a failed turn.

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

/** Whether the catalog says this model takes an effort. Keyed off the
 * authoritative flag only: plain `supportsReasoning` is a model that thinks,
 * not one whose thinking can be dialled. Capability names are compared
 * loosely, so `capabilities.supportsReasoningEffort` counts too. */
export function supportsReasoningEffort(model: ReasoningCapable | null | undefined): boolean {
  if (!model) return false;
  if (model.supportsReasoningEffort === true) return true;
  return (model.capabilities ?? []).some((capability) =>
    capability
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .includes("supportsreasoningeffort"),
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

// ---------------------------------------------------------------------------
// The desktop carries the effort as a model ALIAS (ADR-0080).
//
// The pinned Hermes only emits a reasoning field for a few hosted routes
// (`_supports_reasoning_extra_body()` in its run_agent.py), never for the
// loopback provider Sub Rosa points it at, and the shell's provider proxy is
// shared by every session of a process, so it cannot tell which chat a request
// belongs to. The model name is the one thing Hermes forwards per session,
// verbatim, on every request. So the chosen effort rides on it:
// `zai-org-glm-5-2@reasoning-effort=high`. The proxy in `hermes_bridge`
// (`provider_proxy.rs`) strips the suffix and sets the flat `reasoning_effort`
// field before the body reaches the sidecar, so metering, pricing and the
// catalog only ever see the real id.
//
// The suffix is long on purpose: Hermes auto-corrects a `/model` value that is
// at least 90% similar to a listed id, and a short suffix on a long id would
// be "corrected" back to the bare model, silently dropping the effort.

export const REASONING_EFFORT_ALIAS_MARKER = "@reasoning-effort=";

/** The model string Hermes is handed: the bare id, or the id with its effort. */
export function withReasoningEffortAlias(
  modelId: string,
  effort: ReasoningEffort | null | undefined,
): string {
  const bare = stripReasoningEffortAlias(modelId);
  return effort ? `${bare}${REASONING_EFFORT_ALIAS_MARKER}${effort}` : bare;
}

/** Splits an alias back into the catalog id and the effort it carries. A
 * string without the marker is a plain id; an unknown effort is dropped
 * rather than passed on, so the id stays usable. */
export function parseReasoningEffortAlias(model: string): {
  modelId: string;
  effort?: ReasoningEffort;
} {
  const index = model.lastIndexOf(REASONING_EFFORT_ALIAS_MARKER);
  if (index <= 0) return { modelId: model };
  const effort = parseReasoningEffort(
    model.slice(index + REASONING_EFFORT_ALIAS_MARKER.length).trim(),
  );
  const modelId = model.slice(0, index);
  return effort ? { modelId, effort } : { modelId };
}

/** The real catalog id behind whatever Hermes reports. Every surface that
 * shows, prices or looks up a model passes through this. */
export function stripReasoningEffortAlias(model: string): string;
export function stripReasoningEffortAlias(model: string | undefined): string | undefined;
export function stripReasoningEffortAlias(model: string | undefined) {
  return model === undefined ? undefined : parseReasoningEffortAlias(model).modelId;
}
