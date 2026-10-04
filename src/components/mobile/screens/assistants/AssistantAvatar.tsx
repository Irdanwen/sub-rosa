// An assistant's face on the phone, and the sheet that changes it. The face
// is an initial on colours derived from the assistant (stable everywhere,
// stored nowhere) until a picture is chosen; a picture is always one of the
// assistant's image references, so nothing here touches the synchronised
// schema (ADR-0058 addendum).

import { IconCamera1 } from "central-icons/IconCamera1";
import { IconImages1 } from "central-icons/IconImages1";
import { IconSparkle } from "central-icons/IconSparkle";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  adoptAvatar,
  avatarModel,
  clearAvatar,
  generateAvatars,
  monogramHues,
  monogramOf,
  photoToGallery,
} from "../../../../lib/assistant-avatar";
import { type AssistantDefinition, readAssistantReference } from "../../../../lib/assistants";
import { friendlyErrorMessage } from "../../../../lib/errors";
import { hapticImpact, hapticSelection } from "../../../../lib/haptics";
import { t } from "../../../../lib/i18n";
import { useModalFocus } from "../../../../lib/modal-focus";
import { listArtifacts } from "../../../../lib/studio/artifacts";
import { fetchMediaCatalog, formatCredits } from "../../../../lib/studio/catalog";
import type { MediaModel, StudioArtifact } from "../../../../lib/studio/types";
import { Spinner } from "../../../ui/Spinner";
import { sheetHost } from "../../sheet-host";
import { GalleryCell } from "../studio/StudioLibrary";

/** Read once per reference and kept: the same face is drawn in the list, the
 * chat header and the editor, and a picture does not change under its id. */
const imageCache = new Map<string, string>();

/** Forgets cached pictures, for tests. */
export function resetAvatarCache() {
  imageCache.clear();
}

function useAvatarImage(referenceId: string | null): string | null {
  const [image, setImage] = useState<string | null>(() =>
    referenceId ? (imageCache.get(referenceId) ?? null) : null,
  );
  useEffect(() => {
    if (!referenceId) {
      setImage(null);
      return;
    }
    const cached = imageCache.get(referenceId);
    if (cached) {
      setImage(cached);
      return;
    }
    let cancelled = false;
    setImage(null);
    readAssistantReference(referenceId)
      .then((value) => {
        imageCache.set(referenceId, value);
        if (!cancelled) setImage(value);
      })
      // A picture that cannot be read (not downloaded yet on this device)
      // leaves the initial in place, which is still the assistant's face.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [referenceId]);
  return image;
}

export function AssistantAvatar({
  assistant,
  size = 40,
}: {
  assistant: Pick<AssistantDefinition, "id" | "name" | "avatar_ref">;
  size?: number;
}) {
  const image = useAvatarImage(assistant.avatar_ref);
  const [hueA, hueB] = monogramHues(assistant);
  const style = {
    "--avatar-size": `${size}px`,
    "--avatar-hue-a": hueA,
    "--avatar-hue-b": hueB,
  } as CSSProperties;
  return (
    <span className="mobile-assistant-avatar" style={style} aria-hidden>
      {image ? <img src={image} alt="" /> : <span>{monogramOf(assistant.name) || "?"}</span>}
    </span>
  );
}

type Step =
  | { kind: "menu" }
  | { kind: "price" }
  | { kind: "gallery"; images: StudioArtifact[] | null }
  | { kind: "choose"; images: StudioArtifact[] }
  | { kind: "busy"; label: string };

/**
 * "Change the avatar": generate one, take one from the Studio gallery or from
 * Photos, or go back to the initial. Everything ends in `onChanged` with the
 * saved definition, so the caller holds the new revision.
 */
export function AvatarSheet({
  assistant,
  onChanged,
  onClose,
}: {
  /** A saved assistant: a picture is a reference, and a reference needs the
   * assistant's id. */
  assistant: AssistantDefinition;
  onChanged: (assistant: AssistantDefinition) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ kind: "menu" });
  const [error, setError] = useState<string | null>(null);
  const [pricing, setPricing] = useState<{ model: MediaModel; unitCost?: number } | null>(null);
  const busy = step.kind === "busy";
  // Closing while a paid generation runs would orphan it on screen; the
  // pictures still land in the gallery, but the sheet stays until they do.
  useModalFocus(sheetRef, { onClose: () => (busy ? undefined : onClose()) });

  useEffect(() => {
    let cancelled = false;
    fetchMediaCatalog()
      .then((catalog) => {
        if (!cancelled) setPricing(avatarModel(catalog));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const adopt = async (artifact: StudioArtifact) => {
    setError(null);
    setStep({ kind: "busy", label: t("Setting the avatar…") });
    try {
      const saved = await adoptAvatar(assistant, artifact.fileName);
      hapticImpact("light");
      onChanged(saved);
      onClose();
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("The avatar could not be changed.")));
      setStep({ kind: "menu" });
    }
  };

  const generate = async (variants: number) => {
    if (!pricing) return;
    setError(null);
    setStep({
      kind: "busy",
      label: variants > 1 ? t("Drawing two avatars…") : t("Drawing an avatar…"),
    });
    try {
      const images = await generateAvatars(assistant, pricing.model, variants);
      if (images.length === 1) await adopt(images[0]);
      else setStep({ kind: "choose", images });
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("The avatar could not be generated.")));
      setStep({ kind: "price" });
    }
  };

  const openGallery = () => {
    setError(null);
    setStep({ kind: "gallery", images: null });
    listArtifacts("image")
      .then((images) =>
        setStep((current) => (current.kind === "gallery" ? { kind: "gallery", images } : current)),
      )
      .catch((cause) => {
        setError(friendlyErrorMessage(cause, t("The gallery could not be opened.")));
        setStep({ kind: "menu" });
      });
  };

  const fromPhoto = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setStep({ kind: "busy", label: t("Setting the avatar…") });
    try {
      await adopt(await photoToGallery(file));
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("This photo could not be used.")));
      setStep({ kind: "menu" });
    }
  };

  const reset = async () => {
    setError(null);
    setStep({ kind: "busy", label: t("Setting the avatar…") });
    try {
      onChanged(await clearAvatar(assistant));
      onClose();
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("The avatar could not be changed.")));
      setStep({ kind: "menu" });
    }
  };

  const unit = pricing?.unitCost;
  const priceOf = (count: number) =>
    unit === undefined ? t("Price unknown") : formatCredits(unit * count);
  const title =
    step.kind === "price"
      ? t("Generate an avatar")
      : step.kind === "gallery"
        ? t("Choose from the gallery")
        : step.kind === "choose"
          ? t("Choose an avatar")
          : t("Change the avatar");

  return createPortal(
    <div className="mobile-sheet-backdrop">
      <button
        type="button"
        className="mobile-sheet-dismiss"
        aria-label={t("Close")}
        disabled={busy}
        onClick={onClose}
      />
      <div
        className="mobile-sheet mobile-action-sheet mobile-avatar-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy || undefined}
        ref={sheetRef}
        tabIndex={-1}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <div className="mobile-avatar-sheet-face">
          <AssistantAvatar assistant={assistant} size={64} />
        </div>
        <p className="mobile-sheet-title">{title}</p>
        {error ? (
          <p className="mobile-sheet-error" role="alert">
            {error}
          </p>
        ) : null}

        {step.kind === "menu" ? (
          <ul className="mobile-sheet-list">
            <li>
              <button
                type="button"
                className="mobile-sheet-item mobile-avatar-sheet-item"
                disabled={!pricing}
                onClick={() => {
                  hapticSelection();
                  setStep({ kind: "price" });
                }}
              >
                <IconSparkle size={20} aria-hidden />
                <span className="mobile-sheet-item-title">{t("Generate with AI")}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="mobile-sheet-item mobile-avatar-sheet-item"
                onClick={() => {
                  hapticSelection();
                  openGallery();
                }}
              >
                <IconImages1 size={20} aria-hidden />
                <span className="mobile-sheet-item-title">{t("Choose from the gallery")}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="mobile-sheet-item mobile-avatar-sheet-item"
                onClick={() => photoRef.current?.click()}
              >
                <IconCamera1 size={20} aria-hidden />
                <span className="mobile-sheet-item-title">{t("Choose a photo")}</span>
              </button>
            </li>
            {assistant.avatar_ref ? (
              <li>
                <button
                  type="button"
                  className="mobile-sheet-item mobile-action-sheet-item"
                  onClick={() => void reset()}
                >
                  <span className="mobile-sheet-item-title">{t("Back to the initial")}</span>
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}

        {step.kind === "price" && pricing ? (
          <>
            <p className="mobile-action-sheet-subtitle">
              {t(
                "Drawn from the name and description with {model}. The pictures stay in your gallery.",
                {
                  model: pricing.model.name,
                },
              )}
            </p>
            <ul className="mobile-sheet-list">
              <li>
                <button
                  type="button"
                  className="mobile-sheet-item mobile-avatar-sheet-price"
                  onClick={() => void generate(1)}
                >
                  <span className="mobile-sheet-item-title">{t("One avatar")}</span>
                  <span className="mobile-avatar-sheet-cost">{priceOf(1)}</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="mobile-sheet-item mobile-avatar-sheet-price"
                  onClick={() => void generate(2)}
                >
                  <span className="mobile-sheet-item-title">{t("Two to choose from")}</span>
                  <span className="mobile-avatar-sheet-cost">{priceOf(2)}</span>
                </button>
              </li>
            </ul>
          </>
        ) : null}

        {step.kind === "gallery" ? (
          step.images === null ? (
            <div className="mobile-avatar-sheet-busy">
              <Spinner />
            </div>
          ) : step.images.length === 0 ? (
            <p className="mobile-action-sheet-subtitle">
              {t("Your gallery has no image yet. Generate one, or choose a photo.")}
            </p>
          ) : (
            <AvatarGrid images={step.images} onPick={(image) => void adopt(image)} />
          )
        ) : null}

        {step.kind === "choose" ? (
          <AvatarGrid images={step.images} onPick={(image) => void adopt(image)} />
        ) : null}

        {step.kind === "busy" ? (
          <div className="mobile-avatar-sheet-busy" role="status">
            <Spinner />
            <span>{step.label}</span>
          </div>
        ) : null}

        <input
          ref={photoRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void fromPhoto(file);
          }}
        />
        <button
          type="button"
          className="mobile-action-sheet-cancel"
          disabled={busy}
          onClick={() =>
            step.kind === "price" || step.kind === "gallery" ? setStep({ kind: "menu" }) : onClose()
          }
        >
          {step.kind === "price" || step.kind === "gallery" ? t("Back") : t("Cancel")}
        </button>
      </div>
    </div>,
    sheetHost(),
  );
}

function AvatarGrid({
  images,
  onPick,
}: {
  images: StudioArtifact[];
  onPick: (image: StudioArtifact) => void;
}) {
  // Newest first, and only as many as a sheet can hold without becoming the
  // gallery itself.
  const shown = useMemo(
    () => [...images].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30),
    [images],
  );
  return (
    <div className="mobile-studio-grid mobile-avatar-sheet-grid">
      {shown.map((image) => (
        <GalleryCell key={image.id} artifact={image} onOpen={() => onPick(image)} />
      ))}
    </div>
  );
}
