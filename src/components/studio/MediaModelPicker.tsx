import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useMemo, useState } from "react";
import { intlLocale, t } from "../../lib/i18n";
import { modelPrivacyBadge } from "../../lib/model-privacy";
import { type VideoFamily, videoFamilySearchTerms } from "../../lib/studio/catalog";
import type { MediaModel } from "../../lib/studio/types";
import { Dialog } from "../ui/Dialog";
import "./media-model-picker.css";

export interface MediaModelOption {
  id: string;
  name: string;
  details: string[];
  keywords: string[];
}

/** Only published constraints become labels. Model names never imply abilities. */
export function mediaModelOption(model: MediaModel): MediaModelOption {
  const constraints = model.constraints;
  const details: string[] = [];
  // Privacy is the operator's published policy, not a marketing trait. Keep
  // the shared vocabulary without allowing a stale trait to strengthen it.
  const privacy = modelPrivacyBadge({ privacy: model.privacy, traits: [] });
  if (privacy?.mode === "private") details.push(t("Zero data retention"));
  else if (privacy?.mode === "anonymous") details.push(t("Anonymous mode"));
  else if (privacy) details.push(privacy.label);
  else if (model.privacy) details.push(model.privacy);
  if (model.tier) details.push(model.tier);
  const resolutions = constraints?.resolutions;
  if (resolutions?.length) details.push(resolutions.join(" / "));
  if (constraints?.durations?.length) details.push(constraints.durations.join(" / "));
  if (constraints?.audio) details.push(t("Generated audio"));
  if (model.voices?.length) {
    details.push(
      model.voices.length === 1
        ? t("1 voice")
        : t("{count} voices", { count: model.voices.length }),
    );
  }
  if (
    typeof model.costCredits === "number" &&
    Number.isFinite(model.costCredits) &&
    model.costCredits >= 0
  ) {
    details.push(
      t("~{count} credits per generation", {
        count: model.costCredits.toLocaleString(intlLocale(), { maximumSignificantDigits: 4 }),
      }),
    );
  }
  return {
    id: model.id,
    name: model.name.trim() || model.id,
    details,
    keywords: [
      model.id,
      ...(model.traits ?? []),
      ...(model.modelSets ?? []),
      ...(model.voices ?? []),
    ],
  };
}

/** Search every variant while selecting the family the existing form expects. */
export function videoFamilyOption(family: VideoFamily): MediaModelOption {
  const variants = [
    family.textModel,
    family.imageModel,
    family.referenceModel,
    family.videoModel,
  ].filter((model): model is MediaModel => Boolean(model));
  const details: string[] = [];
  if (family.textModel) details.push(t("From a prompt"));
  if (family.imageModel) details.push(t("Animate an image"));
  if (family.referenceModel) details.push(t("Reference images"));
  if (family.videoModel) details.push(t("Transform a video"));
  return {
    id: family.key,
    name: family.name,
    details,
    keywords: [
      ...videoFamilySearchTerms(family),
      ...variants.flatMap((model) => mediaModelOption(model).keywords),
    ],
  };
}

/** A catalog-sized choice deserves search and readable capabilities, not a
 * dropdown extending beyond the window. Selection stays explicit. */
export function MediaModelPicker({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder,
}: {
  options: MediaModelOption[];
  value: string | null;
  onChange: (id: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = options.find((option) => option.id === value);
  const visible = useMemo(() => {
    const words = search.trim().toLocaleLowerCase(intlLocale()).split(/\s+/).filter(Boolean);
    return options.filter((option) => {
      const haystack = [option.name, option.id, ...option.details, ...option.keywords]
        .join(" ")
        .toLocaleLowerCase(intlLocale());
      return words.every((word) => haystack.includes(word));
    });
  }, [options, search]);

  return (
    <>
      <button
        type="button"
        className="select-trigger media-model-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setSearch("");
          setOpen(true);
        }}
      >
        <span>{selected?.name ?? placeholder ?? t("Choose a model")}</span>
        <IconChevronDownSmall size={14} aria-hidden />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={ariaLabel}
        description={t("Find a model by name, capability or style.")}
        width="var(--content-max)"
        className="media-model-dialog"
        initialFocusSelector="input[type='search']"
      >
        <label className="model-picker-search">
          <IconMagnifyingGlass size={16} aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={t("Search models")}
            aria-label={t("Search models")}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>
        <p className="media-model-count" role="status">
          {visible.length === 1 ? t("1 model") : t("{count} models", { count: visible.length })}
        </p>
        <div className="media-model-list">
          {visible.map((option) => (
            <button
              key={option.id}
              type="button"
              className="media-model-option"
              aria-pressed={option.id === value}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              <span className="media-model-content">
                <span className="media-model-name">{option.name}</span>
                {option.details.length > 0 ? (
                  <span className="media-model-details">{option.details.join(" · ")}</span>
                ) : null}
                {option.id !== option.name ? (
                  <span className="media-model-id">{option.id}</span>
                ) : null}
              </span>
              {option.id === value ? <IconCheckmark1Small size={16} aria-hidden /> : null}
            </button>
          ))}
          {visible.length === 0 ? (
            <div className="media-model-empty">
              <p>
                {options.length === 0
                  ? t("No models available")
                  : t("No models match your search.")}
              </p>
              {search ? (
                <button type="button" className="button" onClick={() => setSearch("")}>
                  {t("Clear search")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
