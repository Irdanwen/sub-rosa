import { t } from "../../../../lib/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { hapticNotify } from "../../../../lib/haptics";
import { saveArtifactFromBase64 } from "../../../../lib/studio/artifacts";
import {
  estimateCostCredits,
  formatCredits,
  modelsOfType,
  supportsBackgroundRemoval,
} from "../../../../lib/studio/catalog";
import { mediaGet } from "../../../../lib/studio/client";
import { removeBackground, upscaleImage } from "../../../../lib/studio/edit-image";
import { enhanceImagePrompt } from "../../../../lib/studio/enhance-prompt";
import { compareBodies, generateImages } from "../../../../lib/studio/generate-image";
import type { MediaCatalog, StudioArtifact } from "../../../../lib/studio/types";
import { Spinner } from "../../../ui/Spinner";
import { ModelSheet } from "../../ModelSheet";
import {
  formatRenderOption,
  ModelPickerButton,
  modelSubtitle,
  MoreOptions,
  pickEffective,
  rawBase64,
  SelectRow,
  SettingsCard,
  SliderSetting,
  StudioSetting,
  StudioToggle,
} from "./StudioControls";
import { RetouchLauncher } from "./RetouchLauncher";
import { ReferencePicker } from "./StudioLightbox";

/** Which of the four image sub-modes the form is in. */
export type ImageMode = "generate" | "edit" | "upscale" | "cutout";

/**
 * Making a picture: generate, retouch, upscale, cut out.
 *
 * "edit" is the retouch: on a phone it starts from the photo library or the
 * camera and opens the retouch screen, which does everything the old one-shot
 * edit did (combining up to three images included) and keeps every version.
 */
// --- Image ------------------------------------------------------------------

export function ImagePanel({
  catalog,
  mode,
  onModeChange,
  galleryImages,
  onGenerated,
}: {
  catalog: MediaCatalog;
  mode: ImageMode;
  onModeChange: (mode: ImageMode) => void;
  galleryImages: StudioArtifact[];
  onGenerated: () => void;
}) {
  const generateModels = useMemo(() => modelsOfType(catalog, "image"), [catalog]);
  const cutoutAvailable = supportsBackgroundRemoval(catalog);
  const models = generateModels;
  const [generateModelId, setGenerateModelId] = useState(generateModels[0]?.id ?? "");
  const model = models.find((entry) => entry.id === generateModelId) ?? models[0];
  const [prompt, setPrompt] = useState("");
  // Generate-only settings, at parity with the desktop image studio. They are
  // constraint-driven: aspect/resolution/steps only show when the model exposes
  // them, and `variants` fans out into that many images (heavy models render
  // one queue job per variant — see generate-image.ts).
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [steps, setSteps] = useState(0);
  const [variants, setVariants] = useState(1);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Side-by-side comparison: extra models that render the same prompt, one
  // image each, next to the main model's output.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  // Output and prompt niceties, at parity with the desktop image studio.
  const [stylePreset, setStylePreset] = useState("");
  const [styles, setStyles] = useState<string[]>([]);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [format, setFormat] = useState<"png" | "webp" | "jpeg">("png");
  const [hideWatermark, setHideWatermark] = useState(true);
  const [embedExif, setEmbedExif] = useState(false);
  const [improvePrompt, setImprovePrompt] = useState(false);
  // Upscale and cutout share one single-image source.
  const [upscaleRefs, setUpscaleRefs] = useState<string[]>([]);
  const [scale, setScale] = useState<2 | 3 | 4>(2);

  // Style presets are a Venice nicety the backend may not expose: hide the
  // picker when the request fails rather than surfacing an error.
  useEffect(() => {
    let cancelled = false;
    mediaGet<{ data?: string[] }>("/image/styles")
      .then((response) => {
        if (!cancelled && Array.isArray(response?.data)) setStyles(response.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The cutout mode disappears when the backend loses the endpoint; leave no
  // orphaned selection.
  useEffect(() => {
    if (!cutoutAvailable && mode === "cutout") onModeChange("generate");
  }, [cutoutAvailable, mode, onModeChange]);

  const constraints = mode === "generate" ? model?.constraints : undefined;
  const aspectOptions = constraints?.aspectRatios ?? [];
  const resolutionOptions = constraints?.resolutions ?? [];
  const maxSteps = constraints?.steps?.max ?? 0;
  const defaultSteps = constraints?.steps?.default ?? 1;
  const effectiveAspect = pickEffective(aspectOptions, aspectRatio);
  const effectiveResolution = pickEffective(resolutionOptions, resolution);
  const compareModels = useMemo(
    () =>
      compareIds
        .filter((id) => id !== model?.id)
        .map((id) => generateModels.find((entry) => entry.id === id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    [compareIds, model, generateModels],
  );
  const comparing = mode === "generate" && compareModels.length > 0;
  const baseCost = model
    ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier })
    : undefined;
  // Generate is billed per variant (or per compared model); edit/upscale are
  // single-shot.
  const cost = comparing
    ? [model, ...compareModels].reduce<number | undefined>((sum, entry) => {
        if (!entry) return sum;
        const each = estimateCostCredits(entry, { multiplier: catalog.priceMultiplier });
        if (each === undefined) return sum;
        return (sum ?? 0) + each;
      }, undefined)
    : baseCost !== undefined && mode === "generate"
      ? baseCost * variants
      : baseCost;

  const generate = useCallback(async () => {
    if (!model || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Optional AI pass that expands the prompt before generation. Best
      // effort: a failure falls back to the prompt as typed.
      const usedPrompt =
        mode === "generate" && improvePrompt
          ? await enhanceImagePrompt(prompt.trim(), catalog)
          : prompt.trim();
      if (comparing) {
        // Comparison run: the same prompt across every selected model, one
        // image each; per-model settings limited to what each supports.
        const runs = compareBodies([model, ...compareModels], usedPrompt, {
          negativePrompt,
          seed: seed.trim() && Number.isFinite(Number(seed)) ? Number(seed) : undefined,
          aspectRatio: effectiveAspect || undefined,
        });
        const settled = await Promise.allSettled(
          runs.map(async ({ model: target, body }) => {
            const images = await generateImages(target.id, body);
            if (images.length === 0) throw new Error("The backend returned no image.");
            for (const base64 of images) {
              await saveArtifactFromBase64(base64, "png", {
                kind: "image",
                model: target.id,
                prompt: usedPrompt,
              });
            }
          }),
        );
        const failures = settled.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length === settled.length) throw failures[0].reason;
        if (failures.length > 0) {
          setError(t("Some models failed; the rest landed in the gallery."));
        }
        hapticNotify("success");
        onGenerated();
        return;
      }
      {
        const body: Record<string, unknown> = {
          model: model.id,
          prompt: usedPrompt,
          variants,
          format,
          hide_watermark: hideWatermark,
          safe_mode: false,
        };
        if (embedExif) body.embed_exif_metadata = true;
        if (stylePreset) body.style_preset = stylePreset;
        if (negativePrompt.trim()) body.negative_prompt = negativePrompt.trim();
        if (effectiveAspect) body.aspect_ratio = effectiveAspect;
        if (effectiveResolution) body.resolution = effectiveResolution;
        if (maxSteps > 0 && steps > 0) body.steps = steps;
        if (seed.trim() && Number.isFinite(Number(seed))) body.seed = Number(seed);
        const images = await generateImages(model.id, body);
        if (images.length === 0) throw new Error("The backend returned no image.");
        for (const base64 of images) {
          await saveArtifactFromBase64(base64, format, {
            kind: "image",
            model: model.id,
            prompt: usedPrompt,
          });
        }
      }
      hapticNotify("success");
      onGenerated();
    } catch (err) {
      hapticNotify("error");
      setError(err instanceof Error ? t(err.message) : t("The generation failed."));
    } finally {
      setBusy(false);
    }
  }, [
    model,
    prompt,
    busy,
    mode,
    comparing,
    compareModels,
    catalog,
    improvePrompt,
    format,
    hideWatermark,
    embedExif,
    stylePreset,
    onGenerated,
    variants,
    negativePrompt,
    effectiveAspect,
    effectiveResolution,
    maxSteps,
    steps,
    seed,
  ]);

  const upscale = useCallback(async () => {
    if (upscaleRefs.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await upscaleImage(rawBase64(upscaleRefs[0]), scale);
      await saveArtifactFromBase64(result, "png", {
        kind: "image",
        model: "upscale",
        prompt: `Upscaled image (x${scale})`,
      });
      hapticNotify("success");
      setUpscaleRefs([]);
      onGenerated();
    } catch (err) {
      hapticNotify("error");
      setError(err instanceof Error ? t(err.message) : t("The upscale failed."));
    } finally {
      setBusy(false);
    }
  }, [upscaleRefs, scale, busy, onGenerated]);

  const cutout = useCallback(async () => {
    if (upscaleRefs.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await removeBackground(upscaleRefs[0]);
      await saveArtifactFromBase64(result, "png", {
        kind: "image",
        model: "background-remover",
        prompt: t("Background removed"),
      });
      hapticNotify("success");
      setUpscaleRefs([]);
      onGenerated();
    } catch (err) {
      hapticNotify("error");
      setError(err instanceof Error ? t(err.message) : t("The cutout failed."));
    } finally {
      setBusy(false);
    }
  }, [upscaleRefs, busy, onGenerated]);

  const modes: ImageMode[] = cutoutAvailable
    ? ["generate", "edit", "upscale", "cutout"]
    : ["generate", "edit", "upscale"];

  return (
    <div className="mobile-studio-form">
      <div className="mobile-segmented" role="tablist" aria-label={t("Image mode")}>
        {modes.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className="mobile-segmented-item"
            data-active={mode === entry ? "true" : undefined}
            onClick={() => onModeChange(entry)}
          >
            {entry === "generate"
              ? t("Generate")
              : entry === "edit"
                ? t("Touch up")
                : entry === "upscale"
                  ? t("Upscale")
                  : t("Cutout")}
          </button>
        ))}
      </div>

      {mode === "cutout" ? (
        <>
          <ReferencePicker
            references={upscaleRefs}
            onChange={(refs) => setUpscaleRefs(refs.slice(-1))}
            galleryImages={galleryImages}
            hint={
              upscaleRefs.length === 0
                ? t("Pick an image; the background lifts out into a transparent PNG.")
                : undefined
            }
          />
          <button
            type="button"
            className="mobile-studio-generate"
            disabled={upscaleRefs.length === 0 || busy}
            onClick={() => void cutout()}
          >
            {busy ? <Spinner /> : t("Remove background")}
          </button>
        </>
      ) : mode === "upscale" ? (
        <>
          <ReferencePicker
            references={upscaleRefs}
            onChange={(refs) => setUpscaleRefs(refs.slice(-1))}
            galleryImages={galleryImages}
            hint={
              upscaleRefs.length === 0
                ? t("Pick an image to enlarge (at least 256 by 256 pixels).")
                : undefined
            }
          />
          <div className="mobile-pill-row" role="radiogroup" aria-label={t("Upscale factor")}>
            {([2, 3, 4] as const).map((factor) => (
              <button
                key={factor}
                type="button"
                className="mobile-pill"
                data-active={scale === factor ? "true" : undefined}
                onClick={() => setScale(factor)}
              >
                {`x${factor}`}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mobile-studio-generate"
            disabled={upscaleRefs.length === 0 || busy}
            onClick={() => void upscale()}
          >
            {busy ? <Spinner /> : t("Upscale x{scale}", { scale })}
          </button>
        </>
      ) : mode === "edit" ? (
        <RetouchLauncher galleryImages={galleryImages} />
      ) : (
        <>
          <ModelPickerButton
            label={t("Image model")}
            value={model?.name ?? ""}
            onOpen={() => setPickerOpen(true)}
          />
          <textarea
            className="mobile-studio-prompt"
            value={prompt}
            rows={3}
            placeholder={t("Describe the image to generate")}
            onChange={(event) => setPrompt(event.target.value)}
          />
          {mode === "generate" ? (
            <>
              {aspectOptions.length > 0 || resolutionOptions.length > 0 ? (
                <SettingsCard>
                  {aspectOptions.length > 0 ? (
                    <SelectRow
                      label={t("Aspect ratio")}
                      value={effectiveAspect}
                      options={aspectOptions}
                      onChange={setAspectRatio}
                      format={formatRenderOption}
                    />
                  ) : null}
                  {resolutionOptions.length > 0 ? (
                    <SelectRow
                      label={t("Resolution")}
                      value={effectiveResolution}
                      options={resolutionOptions}
                      onChange={setResolution}
                    />
                  ) : null}
                </SettingsCard>
              ) : null}
              <MoreOptions>
                <textarea
                  className="mobile-studio-prompt"
                  value={negativePrompt}
                  rows={2}
                  placeholder={t("Negative prompt (optional)")}
                  aria-label={t("Negative prompt")}
                  onChange={(event) => setNegativePrompt(event.target.value)}
                />
                {maxSteps > 1 ? (
                  <SliderSetting
                    label={t("Steps")}
                    min={1}
                    max={maxSteps}
                    value={steps > 0 ? Math.min(steps, maxSteps) : defaultSteps}
                    onChange={setSteps}
                  />
                ) : null}
                {!comparing ? (
                  <SliderSetting
                    label={t("Variants")}
                    min={1}
                    max={4}
                    value={variants}
                    onChange={setVariants}
                  />
                ) : null}
                <StudioSetting
                  label={t("Compare models")}
                  hint={
                    comparing
                      ? t("{count} side by side", { count: compareModels.length + 1 })
                      : t("Optional")
                  }
                >
                  <div className="mobile-reference-actions">
                    {compareModels.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="mobile-chip-button"
                        aria-label={t("Stop comparing with {model}", { model: entry.name })}
                        onClick={() =>
                          setCompareIds((current) => current.filter((id) => id !== entry.id))
                        }
                      >
                        {entry.name} x
                      </button>
                    ))}
                    <button
                      type="button"
                      className="mobile-chip-button"
                      onClick={() => setComparePickerOpen(true)}
                    >
                      {t("Add a model")}
                    </button>
                  </div>
                </StudioSetting>
                <StudioSetting label={t("Seed")} hint={t("Blank for random")}>
                  <input
                    className="mobile-studio-input"
                    inputMode="numeric"
                    value={seed}
                    placeholder={t("Random")}
                    aria-label={t("Seed")}
                    onChange={(event) => setSeed(event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </StudioSetting>
                {styles.length > 0 ? (
                  <ModelPickerButton
                    label={t("Style")}
                    value={stylePreset || t("None")}
                    onOpen={() => setStylePickerOpen(true)}
                  />
                ) : null}
                <StudioToggle
                  label={t("Improve prompt with AI")}
                  checked={improvePrompt}
                  onChange={setImprovePrompt}
                />
                <SettingsCard>
                  <SelectRow
                    label={t("Image format")}
                    value={format}
                    options={["png", "webp", "jpeg"]}
                    onChange={(next) => setFormat(next as typeof format)}
                    format={(option) => option.toUpperCase()}
                  />
                </SettingsCard>
                <StudioToggle
                  label={t("Hide watermark")}
                  checked={hideWatermark}
                  onChange={setHideWatermark}
                />
                <StudioToggle
                  label={t("Embed prompt in metadata")}
                  checked={embedExif}
                  onChange={setEmbedExif}
                />
              </MoreOptions>
            </>
          ) : null}
          <div className="mobile-studio-generate-bar">
            <button
              type="button"
              className="mobile-studio-generate"
              disabled={!model || !prompt.trim() || busy}
              onClick={() => void generate()}
            >
              {busy ? <Spinner /> : t("Generate")}
              {!busy && cost !== undefined ? (
                <span className="mobile-studio-cost">{formatCredits(cost)}</span>
              ) : null}
            </button>
            {busy ? null : !model ? (
              <p className="mobile-studio-generate-hint">{t("Choose an image model first.")}</p>
            ) : !prompt.trim() ? (
              <p className="mobile-studio-generate-hint">
                {t("Describe the image to generate it.")}
              </p>
            ) : null}
          </div>
        </>
      )}
      {error ? <p className="mobile-dictation-error">{error}</p> : null}
      {pickerOpen ? (
        <ModelSheet
          title={t("Image model")}
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: modelSubtitle(entry),
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) setGenerateModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {comparePickerOpen ? (
        <ModelSheet
          title={t("Compare with")}
          entries={generateModels
            .filter((entry) => entry.id !== model?.id && !compareIds.includes(entry.id))
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              subtitle: modelSubtitle(entry),
            }))}
          selectedId=""
          onSelect={(id) => {
            if (id) setCompareIds((current) => [...current, id]);
            setComparePickerOpen(false);
          }}
          onClose={() => setComparePickerOpen(false)}
        />
      ) : null}
      {stylePickerOpen ? (
        <ModelSheet
          title={t("Style")}
          entries={styles.map((entry) => ({ id: entry, name: entry, subtitle: "" }))}
          selectedId={stylePreset}
          defaultOption={{ label: t("None"), subtitle: t("No style preset") }}
          onSelect={(id) => {
            setStylePreset(id);
            setStylePickerOpen(false);
          }}
          onClose={() => setStylePickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
