import { useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { readArtifactBase64 } from "../../lib/studio/artifacts";
import { fetchMediaCatalog, formatCredits } from "../../lib/studio/catalog";
import { prepareEditReference } from "../../lib/studio/downscale";
import { runTryOn, tryOnModel } from "../../lib/studio/try-on";
import type { ArtifactOrigin, MediaModel, StudioArtifact } from "../../lib/studio/types";
import "../../styles/assistant-media.css";

type Slot = "person" | "garment";

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(t("This file could not be read. Choose it again.")));
    reader.readAsDataURL(file);
  });
}

/**
 * "Try it on": a photo of the person and a photo of the garment, composed
 * into one picture through `/image/multi-edit`. Nothing is spent until the
 * person taps the button under the price. Used by the chat card the assistant
 * proposes and by the phone's Studio.
 */
export function TryOnPanel({
  garmentLabel,
  origin,
  onDone,
}: {
  garmentLabel?: string;
  origin?: ArtifactOrigin;
  onDone?: (artifact: StudioArtifact) => void;
}) {
  const [model, setModel] = useState<MediaModel | null | undefined>(undefined);
  const [images, setImages] = useState<Record<Slot, string>>({ person: "", garment: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const inputs = {
    person: useRef<HTMLInputElement>(null),
    garment: useRef<HTMLInputElement>(null),
  };

  useEffect(() => {
    let disposed = false;
    fetchMediaCatalog()
      .then((catalog) => {
        if (!disposed) setModel(tryOnModel(catalog) ?? null);
      })
      .catch((reason) => {
        if (disposed) return;
        setModel(null);
        setError(messageFromError(reason));
      });
    return () => {
      disposed = true;
    };
  }, []);

  const pick = async (slot: Slot, file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    try {
      const prepared = await prepareEditReference(await readImage(file));
      setImages((current) => ({ ...current, [slot]: prepared }));
    } catch (reason) {
      setError(messageFromError(reason));
    }
  };

  const run = async () => {
    if (!model || busy || !images.person || !images.garment) return;
    setBusy(true);
    setError(undefined);
    try {
      const artifact = await runTryOn({
        model,
        person: images.person,
        garment: images.garment,
        garmentLabel,
        origin,
      });
      const base64 = await readArtifactBase64(artifact);
      setResult(`data:image/png;base64,${base64}`);
      onDone?.(artifact);
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy(false);
    }
  };

  const slots: { slot: Slot; label: string; choose: string }[] = [
    { slot: "person", label: t("Your photo"), choose: t("Choose your photo") },
    { slot: "garment", label: t("The garment"), choose: t("Choose the garment") },
  ];
  const ready = Boolean(model && images.person && images.garment);
  return (
    <div className="try-on-panel">
      <div className="try-on-slots">
        {slots.map(({ slot, label, choose }) => (
          <div key={slot} className="try-on-slot">
            <span>{label}</span>
            {images[slot] ? <img src={images[slot]} alt={label} /> : null}
            <input
              ref={inputs[slot]}
              type="file"
              accept="image/*"
              aria-label={choose}
              onChange={(event) => {
                void pick(slot, event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="assistant-media-secondary"
              disabled={busy}
              onClick={() => inputs[slot].current?.click()}
            >
              {images[slot] ? t("Change") : choose}
            </button>
          </div>
        ))}
      </div>
      {model === null && !error ? (
        <p role="status">{t("No image editing model that takes two photos is available.")}</p>
      ) : null}
      {model ? (
        <div className="assistant-media-confirm">
          <span>
            {model.costCredits === undefined
              ? t("Price unavailable. This generation uses your credits.")
              : t("Estimated price: {credits}", { credits: formatCredits(model.costCredits) })}
          </span>
          <button
            type="button"
            className="assistant-media-generate"
            disabled={!ready || busy}
            onClick={() => void run()}
          >
            {busy ? t("Trying it on") : t("Try it on")}
          </button>
        </div>
      ) : null}
      {result ? (
        <>
          <img src={result} alt={t("You, wearing the garment")} />
          <p>{t("Saved in your Studio gallery.")}</p>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
