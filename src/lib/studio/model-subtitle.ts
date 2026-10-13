import { t } from "../i18n";
import { modelPrivacyBadge } from "../model-privacy";
import { formatCredits } from "./catalog";

/** The line under a model's name in a picker: its tier and what happens to
 * the prompt, in words. The catalog's own values ("standard · anonymized")
 * were shown as they came, in English. */
export function modelSubtitle(model: {
  tier?: string;
  privacy?: string;
  costCredits?: number;
}): string {
  const parts: string[] = [];
  const tier = model.tier?.trim().toLowerCase();
  if (tier === "standard") parts.push(t("Standard"));
  else if (tier === "premium") parts.push(t("Premium"));
  else if (tier) parts.push(tier[0].toUpperCase() + tier.slice(1));
  const privacy = modelPrivacyBadge({ privacy: model.privacy, traits: [] });
  if (privacy?.mode === "private") parts.push(t("Zero data retention"));
  else if (privacy?.mode === "anonymous") parts.push(t("Anonymous mode"));
  else if (privacy) parts.push(privacy.label);
  // The price of one render, where the catalog publishes a flat one: the thing
  // that most separates two otherwise similar rows.
  if (typeof model.costCredits === "number" && Number.isFinite(model.costCredits)) {
    parts.push(`~${formatCredits(model.costCredits)}`);
  }
  return parts.join(" · ");
}

/** Strip a `data:...;base64,` prefix so the raw bytes can go to /image/upscale,
 * which (unlike /image/edit) rejects a data URI. */
