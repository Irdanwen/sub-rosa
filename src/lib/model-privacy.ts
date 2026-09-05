import type { ProviderModelMode, VeniceModelDto } from "./tauri";
import { t } from "./i18n";

export type ModelPrivacyMode = "e2ee" | "private" | "anonymous";

export type ModelPrivacyBadge = {
  mode: ModelPrivacyMode;
  label: string;
  description: string;
};

export type ModelPrivacyFlags = {
  e2ee: boolean;
  private: boolean;
  anonymous: boolean;
  uncensored: boolean;
};

export const PROVIDER_MODEL_SETTINGS_CHANGED_EVENT = "june:provider-model-settings-changed";

export type ProviderModelSettingsChangedDetail = {
  mode: ProviderModelMode;
  modelId: string;
};

export function dispatchProviderModelSettingsChanged(detail: ProviderModelSettingsChangedDetail) {
  window.dispatchEvent(
    new CustomEvent<ProviderModelSettingsChangedDetail>(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, {
      detail,
    }),
  );
}

function privacyDescriptions() {
  return {
    e2ee: t(
      "The catalog lists this model as end-to-end encrypted. This describes its advertised privacy policy, not a verification of how Sub Rosa encrypts each request.",
    ),
    private: t(
      "The catalog lists this model as private with zero data retention. This reflects the provider's published policy.",
    ),
    anonymous: t(
      "The catalog lists this model as anonymized. The provider may retain prompts. This label does not guarantee that personal information in your prompt is removed.",
    ),
  };
}

// Compatibility exports for consumers describing the initial language. Badges
// resolve their descriptions when called, so locale changes cannot leave stale copy.
export const E2EE_MODEL_DESCRIPTION = privacyDescriptions().e2ee;
export const PRIVATE_MODEL_DESCRIPTION = privacyDescriptions().private;
export const ANONYMOUS_MODEL_DESCRIPTION = privacyDescriptions().anonymous;

type ModelPrivacySignals = Pick<VeniceModelDto, "privacy" | "traits"> &
  Partial<Pick<VeniceModelDto, "capabilities">>;

/** The agent drives everything through tool calls, so a text model without
 * function calling bricks June — prompts run but no file, shell, or memory
 * tool ever executes. Venice's E2EE models are the common case: encrypted
 * inference can't expose tools. The capability name comes from Venice's
 * catalog (`supportsFunctionCalling`); match defensively on the normalized
 * name so a rename to snake_case or "tool calling" keeps working. */
export function modelSupportsTools(model: Partial<Pick<VeniceModelDto, "capabilities">>) {
  return (model.capabilities ?? []).some((capability) => {
    const normalized = capability.toLowerCase().replace(/[^a-z]/g, "");
    return normalized.includes("functioncalling") || normalized.includes("toolcalling");
  });
}

/** Whether the model can read image input (vision). Mirrors
 * `modelSupportsTools`: key off the authoritative capability flag on
 * `capabilities` only, never `traits`. Venice's backend emits a capability
 * string only when its boolean is true (`collect_capability_names` in
 * june-api), so `capabilities` reliably lists genuine vision support. `traits`
 * is descriptive/marketing text (e.g. "multimodal") that conflates image
 * OUTPUT with image INPUT — matching it would let the image-attach fallback
 * switch to a model that can't actually read the image. The capability name
 * comes from Venice's catalog (`supportsVision`); match defensively on the
 * normalized name so a rename to snake_case keeps working. */
export function modelSupportsImageInput(model: Partial<Pick<VeniceModelDto, "capabilities">>) {
  return (model.capabilities ?? []).some((capability) => {
    const normalized = capability.toLowerCase().replace(/[^a-z]/g, "");
    return normalized.includes("supportsvision");
  });
}

// Flags already resolve the authoritative privacy field before fallback
// signals. Descriptions and labels use the current language at display time.
export function modelPrivacyBadge(
  model: ModelPrivacySignals,
  flags = modelPrivacyFlags(model),
): ModelPrivacyBadge | undefined {
  if (flags.e2ee) {
    return {
      mode: "e2ee",
      label: "E2EE",
      description: privacyDescriptions().e2ee,
    };
  }
  if (flags.private) {
    return {
      mode: "private",
      label: t("Private mode"),
      description: privacyDescriptions().private,
    };
  }
  if (flags.anonymous) {
    return {
      mode: "anonymous",
      label: t("Anonymous mode"),
      description: privacyDescriptions().anonymous,
    };
  }
  return undefined;
}

export function modelPrivacyFlags(model: ModelPrivacySignals): ModelPrivacyFlags {
  const privacy = (model.privacy ?? "").trim().toLowerCase();
  const traits = model.traits.map((trait) => trait.toLowerCase());
  const capabilities = (model.capabilities ?? []).map((capability) => capability.toLowerCase());
  return {
    // A published policy wins even when stale traits/capabilities claim
    // stronger protection. Unknown explicit policies earn no privacy badge.
    // Legacy catalogs without a privacy field can still use their old signals.
    e2ee: privacy ? privacy === "e2ee" : traits.includes("e2ee") || capabilities.includes("e2ee"),
    private: privacy ? privacy === "private" : traits.includes("private"),
    anonymous: privacy
      ? ["anonymous", "anonymized"].includes(privacy)
      : traits.some((trait) => ["anonymous", "anonymized"].includes(trait)),
    uncensored: traits.some((trait) => trait.includes("uncensored")),
  };
}
