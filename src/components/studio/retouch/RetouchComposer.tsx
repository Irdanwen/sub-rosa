// The instruction bar that floats under the picture: what to change, the
// images to borrow from, and the few settings worth a click. Enter sends;
// typing while a retouch renders queues the next one instead of waiting.

import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconImages1 } from "central-icons/IconImages1";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconSettingsSliderHor } from "central-icons/IconSettingsSliderHor";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { t } from "../../../lib/i18n";
import { modelPrivacyBadge } from "../../../lib/model-privacy";
import { formatCredits } from "../../../lib/studio/catalog";
import type { VariantCount } from "../../../lib/studio/retouch/prefs";
import type { RetouchPreset } from "../../../lib/studio/retouch/presets";
import type { RetouchReference } from "../../../lib/studio/retouch/useRetouchSession";
import type { MediaModel } from "../../../lib/studio/types";
import { MediaModelPicker, mediaModelOption } from "../MediaModelPicker";
import { useDismiss } from "./useDismiss";

export interface RetouchComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Something renders on this version: sending queues instead. */
  rendering: boolean;
  zoneActive: boolean;
  disabled?: boolean;
  refs: RetouchReference[];
  maxRefs: number;
  onRemoveRef: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onPickGallery: () => void;
  models: MediaModel[];
  model?: MediaModel;
  onModel: (id: string) => void;
  variants: VariantCount;
  onVariants: (count: VariantCount) => void;
  /** What one send costs, variants included. */
  cost?: number;
  aspectLabel: string;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  /** One-tap retouches, offered while the field is empty. */
  presets: RetouchPreset[];
  onPreset: (preset: RetouchPreset) => void;
  /** A phone: thumb-sized, the settings in their own panel, and a mic. */
  compact?: boolean;
  /** Dictation, when this shell has it. */
  dictating?: boolean;
  onDictate?: () => void;
}

const VARIANT_CHOICES: VariantCount[] = [1, 2, 4];

export function RetouchComposer({
  value,
  onChange,
  onSubmit,
  rendering,
  zoneActive,
  disabled,
  refs,
  maxRefs,
  onRemoveRef,
  onAddFiles,
  onPickGallery,
  models,
  model,
  onModel,
  variants,
  onVariants,
  cost,
  aspectLabel,
  onOpenSettings,
  settingsOpen,
  presets,
  onPreset,
  compact,
  dictating,
  onDictate,
}: RetouchComposerProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLDivElement>(null);
  const closeAttach = useCallback(() => setAttachOpen(false), []);
  useDismiss(attachRef, attachOpen, closeAttach);
  const canSend = Boolean(value.trim()) && !disabled;
  const refsFull = refs.length >= maxRefs;

  // The field grows with the instruction, up to a few lines.
  useEffect(() => {
    const field = fieldRef.current;
    // Measured whenever the text changes, including when it is cleared.
    if (!field || value === undefined) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [value]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) onSubmit();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    onAddFiles(files);
  };

  const placeholder = zoneActive
    ? t("Describe what changes inside the zone")
    : rendering
      ? t("Type the next retouch, it will follow this one")
      : t("Describe the retouch");

  return (
    <div className="retouch-composer" data-compact={compact ? "true" : undefined}>
      {refs.length > 0 ? (
        <ul className="retouch-refs" aria-label={t("Images sent with the instruction")}>
          {refs.map((ref, index) => (
            <li key={ref.id} className="retouch-ref">
              <img src={ref.dataUri} alt="" />
              <span>{t("Image {n}", { n: index + 2 })}</span>
              <button
                type="button"
                className="retouch-ref-remove"
                aria-label={t("Remove image {n}", { n: index + 2 })}
                onClick={() => onRemoveRef(ref.id)}
              >
                <IconCrossSmall size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={fieldRef}
        className="retouch-field"
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={t("Retouch instruction")}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        disabled={disabled}
      />
      {!value.trim() && presets.length > 0 ? (
        <fieldset className="retouch-suggestions" aria-label={t("Quick retouches")}>
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="retouch-suggestion"
              onClick={() => {
                onPreset(preset);
                const field = fieldRef.current;
                if (!field) return;
                field.focus();
                // Leave the caret where the person has something to type.
                window.requestAnimationFrame(() => {
                  const end = field.value.length - (preset.caretFromEnd ?? 0);
                  field.setSelectionRange(end, end);
                });
              }}
            >
              {preset.label()}
            </button>
          ))}
        </fieldset>
      ) : null}
      <div className="retouch-bar">
        {/* The attach menu opens above its button, so it lives outside the
         * tools strip: on a phone that strip scrolls sideways and would clip it. */}
        <div className="retouch-bar-lead">
          <div className="retouch-attach" ref={attachRef}>
            <button
              type="button"
              className="retouch-icon"
              aria-label={t("Add an image to the instruction")}
              aria-expanded={attachOpen}
              disabled={refsFull || disabled}
              title={
                refsFull
                  ? t("This model takes {count} images at most, the one retouched included.", {
                      count: maxRefs + 1,
                    })
                  : undefined
              }
              onClick={() => setAttachOpen((open) => !open)}
            >
              <IconPlusMedium size={18} aria-hidden />
            </button>
            {attachOpen ? (
              <div className="retouch-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  <IconPlusMedium size={16} aria-hidden />
                  {t("Import an image")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachOpen(false);
                    onPickGallery();
                  }}
                >
                  <IconImages1 size={16} aria-hidden />
                  {t("From the gallery")}
                </button>
              </div>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                if (files.length) onAddFiles(files);
              }}
            />
          </div>
          <div className="retouch-bar-tools">
            <button
              type="button"
              className="retouch-icon"
              aria-label={t("Retouch settings")}
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              onClick={onOpenSettings}
            >
              <IconSettingsSliderHor size={18} aria-hidden />
            </button>
            {compact ? (
              onDictate ? (
                <button
                  type="button"
                  className="retouch-icon"
                  data-active={dictating ? "true" : undefined}
                  aria-pressed={Boolean(dictating)}
                  aria-label={dictating ? t("Stop dictation") : t("Dictate")}
                  onClick={onDictate}
                >
                  <IconMicrophone size={18} aria-hidden />
                </button>
              ) : null
            ) : (
              <>
                <button type="button" className="retouch-chip" onClick={onOpenSettings}>
                  {aspectLabel}
                </button>
                <RetouchModelControl models={models} model={model} onModel={onModel} />
                {!zoneActive ? (
                  <RetouchTriesControl variants={variants} onVariants={onVariants} />
                ) : null}
              </>
            )}
          </div>
        </div>
        <div className="retouch-bar-send">
          {cost !== undefined ? <span className="retouch-cost">~{formatCredits(cost)}</span> : null}
          <button
            type="button"
            className="retouch-send"
            aria-label={rendering ? t("Queue this retouch") : t("Send the retouch")}
            disabled={!canSend}
            onClick={onSubmit}
          >
            <IconArrowUp size={18} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The model, with its privacy as the catalog publishes it. */
export function RetouchModelControl({
  models,
  model,
  onModel,
}: {
  models: MediaModel[];
  model?: MediaModel;
  onModel: (id: string) => void;
}) {
  const privacy = model ? modelPrivacyBadge({ privacy: model.privacy, traits: [] }) : undefined;
  return (
    <span className="retouch-model">
      <MediaModelPicker
        options={models.filter((entry) => !entry.offline).map(mediaModelOption)}
        value={model?.id ?? null}
        onChange={onModel}
        ariaLabel={t("Retouch model")}
      />
      {privacy ? (
        <span className="retouch-badge" title={privacy.description}>
          {privacy.label}
        </span>
      ) : null}
    </span>
  );
}

/** How many tries one send makes. */
export function RetouchTriesControl({
  variants,
  onVariants,
}: {
  variants: VariantCount;
  onVariants: (count: VariantCount) => void;
}) {
  return (
    <fieldset className="retouch-variants" aria-label={t("Tries per send")}>
      {VARIANT_CHOICES.map((count) => (
        <button
          key={count}
          type="button"
          aria-pressed={variants === count}
          data-active={variants === count}
          onClick={() => onVariants(count)}
        >
          {t("x{count}", { count })}
        </button>
      ))}
    </fieldset>
  );
}
