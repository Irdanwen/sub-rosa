// Image on the desk (ADR-0110): make a picture, upscale one, cut one out.
// Retouching and composing are tools of this tab too, with rooms of their
// own (RetouchStudio, ComposeStudio); StudioView switches to them. Sync
// generation returns base64 directly; heavy models go through the async queue
// (see generate-image.ts). Every result lands in the on-disk gallery.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactDataUrl, useArtifactThumbnail } from "../../lib/artifact-media";
import { t } from "../../lib/i18n";
import { saveArtifactFromBase64 } from "../../lib/studio/artifacts";
import {
  defaultImageModel,
  estimateCostCredits,
  imageGenerationModels,
  PREFERRED_IMAGE_MODELS,
  rememberImageModel,
} from "../../lib/studio/catalog";
import { MediaError, mediaGet, mediaRaw } from "../../lib/studio/client";
import { removeBackground } from "../../lib/studio/edit-image";
import { enhanceImagePrompt } from "../../lib/studio/enhance-prompt";
import { compareBodies, generateImages } from "../../lib/studio/generate-image";
import { modelSubtitle } from "../../lib/studio/model-subtitle";
import { takeImagePrompt } from "../../lib/studio/prompt-handoff";
import { estimateRenderMs, rememberRenderMs, renderEtaKey } from "../../lib/studio/render-eta";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { Filmstrip } from "./desk/Filmstrip";
import { StudioDesk } from "./desk/StudioDesk";
import { GalleryPicker } from "./GalleryPicker";
import { effectiveOption, PillGroup, SliderField, StudioField } from "./controls";
import { Dock, DockComposer } from "./stage/Dock";
import { DockSelectChip } from "./stage/DockChip";
import { ModelPickerChip } from "./stage/ModelPicker";
import { type StageResult, StageScene } from "./stage/Scene";
import type { StageWait } from "./stage/Veil";

/** The tools of the Image tab. Retouch and compose open rooms of their own. */
export type ImageTool = "create" | "retouch" | "compose" | "upscale" | "cutout";
type ImageFormat = "png" | "webp" | "jpeg";

/** "16:9" reads as it is; a resolution reads in capitals ("2K"). */
function formatOption(option: string) {
  return option.toUpperCase();
}

export function ImageStudio({
  catalog,
  tool,
  tools,
  onWorking,
  onOpenGallery,
}: {
  catalog: MediaCatalog;
  tool: "create" | "upscale" | "cutout";
  /** The tool switch, drawn above the scene. */
  tools: React.ReactNode;
  /** How many renders this desk has in flight: a synchronous image writes no
   * job row, so the header learns of it from here. */
  onWorking?: (count: number) => void;
  onOpenGallery?: () => void;
}) {
  const generateModels = useMemo(() => imageGenerationModels(catalog), [catalog]);
  const [modelId, setModelId] = useState(() => defaultImageModel(catalog)?.id ?? "");
  const model = generateModels.find((entry) => entry.id === modelId);
  const constraints = model?.constraints;
  /** The model this app recommends, pinned first in the picker. */
  const recommendedId = PREFERRED_IMAGE_MODELS.find((id) =>
    generateModels.some((entry) => entry.id === id),
  );

  // Opens with what the chat handed over, when it handed something over.
  const [prompt, setPrompt] = useState(() => takeImagePrompt() ?? "");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [steps, setSteps] = useState(0);
  const [variants, setVariants] = useState(1);
  // Side-by-side comparison: extra models that render the same prompt, one
  // image each, next to the main model's output.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [seed, setSeed] = useState("");
  const [stylePreset, setStylePreset] = useState("");
  const [styles, setStyles] = useState<string[]>([]);
  const [format, setFormat] = useState<ImageFormat>("png");
  const [hideWatermark, setHideWatermark] = useState(true);
  const [embedExif, setEmbedExif] = useState(false);
  const [improvePrompt, setImprovePrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [galleryEpoch, setGalleryEpoch] = useState(0);

  // Upscale and cutout share one source image.
  const [source, setSource] = useState("");
  const [upscaleScale, setUpscaleScale] = useState("2");
  const [upscaleEnhance, setUpscaleEnhance] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);

  /** The render in progress, for the veil over the scene. */
  const [wait, setWait] = useState<StageWait | undefined>(undefined);
  /** What was last made here, and whether its wipe has played. */
  const [lastResult, setLastResult] = useState<StageResult | undefined>(undefined);
  const [reveal, setReveal] = useState(false);

  // Style presets are a nicety the backend may not expose: hide the control
  // when the request fails rather than surfacing an error.
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

  const aspectOptions = constraints?.aspectRatios ?? [];
  const resolutionOptions = constraints?.resolutions ?? [];
  const maxSteps = constraints?.steps?.max ?? 0;
  const promptLimit = constraints?.promptCharacterLimit;
  const effectiveAspect = effectiveOption(aspectOptions, aspectRatio);
  const effectiveResolution = effectiveOption(resolutionOptions, resolution);
  const compareModels = useMemo(
    () =>
      compareIds
        .filter((id) => id !== modelId)
        .map((id) => generateModels.find((entry) => entry.id === id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    [compareIds, modelId, generateModels],
  );
  const comparing = compareModels.length > 0;
  const costCredits = model
    ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier })
    : undefined;
  const totalCost = comparing
    ? [model, ...compareModels].reduce<number | undefined>((sum, entry) => {
        if (!entry) return sum;
        const each = estimateCostCredits(entry, { multiplier: catalog.priceMultiplier });
        if (each === undefined) return sum;
        return (sum ?? 0) + each;
      }, undefined)
    : costCredits !== undefined
      ? costCredits * variants
      : undefined;
  const inFlight = busy
    ? tool === "create"
      ? comparing
        ? compareModels.length + 1
        : variants
      : 1
    : 0;
  useEffect(() => {
    onWorking?.(inFlight);
  }, [inFlight, onWorking]);
  useEffect(() => () => onWorking?.(0), [onWorking]);

  /** Start the clock: the veil shows it, and the estimate is this machine's
   * median for this kind of render. */
  const beginWait = useCallback((key: string, seedText: string, label?: string) => {
    const startedAt = Date.now();
    setWait({
      seed: seedText,
      phase: "processing",
      startedAt,
      estimateMs: estimateRenderMs(key),
      label,
    });
    return { key, startedAt };
  }, []);
  /** A result landed: remember how long it took, put it on the scene, wipe. */
  const landResult = useCallback((timer: { key: string; startedAt: number }, src: string) => {
    rememberRenderMs(timer.key, Date.now() - timer.startedAt);
    setLastResult({ kind: "image", src });
    setReveal(true);
  }, []);

  const registerResults = useCallback(
    async (images: string[], usedModel: string, usedPrompt: string, extension = "png") => {
      for (const base64 of images) {
        await saveArtifactFromBase64(base64, extension, {
          kind: "image",
          model: usedModel,
          prompt: usedPrompt,
        });
      }
      setGalleryEpoch((epoch) => epoch + 1);
    },
    [],
  );

  const generate = useCallback(async () => {
    if (!model || !prompt.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    const timer = beginWait(renderEtaKey("image", model.id), `${model.id}${prompt}`);
    try {
      // Optional AI pass that expands the prompt before generation. Best
      // effort: a failure falls back to the prompt as typed.
      const usedPrompt = improvePrompt
        ? await enhanceImagePrompt(prompt.trim(), catalog)
        : prompt.trim();
      if (comparing) {
        // Comparison run: the same prompt across every selected model, one
        // image each; per-model settings are limited to what each supports.
        const runs = compareBodies([model, ...compareModels], usedPrompt, {
          negativePrompt,
          seed: seed.trim() && Number.isFinite(Number(seed)) ? Number(seed) : undefined,
          aspectRatio: effectiveAspect || undefined,
        });
        const settled = await Promise.allSettled(
          runs.map(async ({ model: target, body }) => {
            const images = await generateImages(target.id, body);
            if (images.length === 0) {
              throw new MediaError("The backend returned no image.", { status: 200 });
            }
            await registerResults(images, target.id, usedPrompt);
            return images[0];
          }),
        );
        const first = settled.find(
          (result): result is PromiseFulfilledResult<string> => result.status === "fulfilled",
        );
        if (first) landResult(timer, `data:image/png;base64,${first.value}`);
        const failed = settled
          .map((result, index) => (result.status === "rejected" ? runs[index].model : undefined))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
        if (failed.length === settled.length) {
          const firstFailure = settled.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          throw (
            firstFailure?.reason ?? new MediaError(t("The generation failed."), { status: 200 })
          );
        }
        if (failed.length > 0) {
          setError(
            t("Some models failed: {models}.", {
              models: failed.map((entry) => entry.name).join(", "),
            }),
          );
        }
        return;
      }
      const body: Record<string, unknown> = {
        model: model.id,
        prompt: usedPrompt,
        variants,
        format,
        hide_watermark: hideWatermark,
        safe_mode: false,
      };
      if (embedExif) body.embed_exif_metadata = true;
      if (negativePrompt.trim()) body.negative_prompt = negativePrompt.trim();
      if (effectiveAspect) body.aspect_ratio = effectiveAspect;
      if (effectiveResolution) body.resolution = effectiveResolution;
      if (maxSteps > 0 && steps > 0) body.steps = steps;
      if (seed.trim() && Number.isFinite(Number(seed))) body.seed = Number(seed);
      if (stylePreset) body.style_preset = stylePreset;
      const images = await generateImages(model.id, body);
      if (images.length === 0) {
        throw new MediaError("The backend returned no image.", { status: 200 });
      }
      await registerResults(images, model.id, usedPrompt, format);
      landResult(timer, `data:image/${format};base64,${images[0]}`);
    } catch (generateError) {
      setError(
        generateError instanceof Error ? generateError.message : t("The generation failed."),
      );
    } finally {
      setWait(undefined);
      setBusy(false);
    }
  }, [
    model,
    prompt,
    busy,
    comparing,
    compareModels,
    catalog,
    improvePrompt,
    format,
    hideWatermark,
    embedExif,
    variants,
    negativePrompt,
    effectiveAspect,
    effectiveResolution,
    maxSteps,
    steps,
    seed,
    stylePreset,
    registerResults,
    beginWait,
    landResult,
  ]);

  const runUpscale = useCallback(async () => {
    if (!source || busy) return;
    setBusy(true);
    setError(undefined);
    const timer = beginWait(
      renderEtaKey("upscale", `x${upscaleScale}`),
      source.slice(-64),
      t("Upscaling"),
    );
    try {
      // Upscale wants raw base64, without the data-URI prefix edit uses.
      const rawBase64 = source.replace(/^data:[^,]*,/, "");
      const response = await mediaRaw("/image/upscale", {
        image: rawBase64,
        scale: Number(upscaleScale),
        enhance: upscaleEnhance,
      });
      if (!response.ok || !response.bodyBase64) {
        throw new MediaError("The upscale did not return an image.", {
          status: response.status,
        });
      }
      await registerResults([response.bodyBase64], "upscaler", "Upscale");
      landResult(timer, `data:image/png;base64,${response.bodyBase64}`);
      setSource("");
    } catch (upscaleError) {
      setError(upscaleError instanceof Error ? upscaleError.message : t("The upscale failed."));
    } finally {
      setWait(undefined);
      setBusy(false);
    }
  }, [source, busy, upscaleScale, upscaleEnhance, registerResults, beginWait, landResult]);

  const runCutout = useCallback(async () => {
    if (!source || busy) return;
    setBusy(true);
    setError(undefined);
    const timer = beginWait(
      renderEtaKey("cutout", "background-remover"),
      source.slice(-64),
      t("Removing the background"),
    );
    try {
      const image = await removeBackground(source);
      await registerResults([image], "background-remover", "Background removed");
      landResult(timer, `data:image/png;base64,${image}`);
      setSource("");
    } catch (cutoutError) {
      setError(cutoutError instanceof Error ? cutoutError.message : t("The cutout failed."));
    } finally {
      setWait(undefined);
      setBusy(false);
    }
  }, [source, busy, registerResults, beginWait, landResult]);

  const onPickFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setSource(reader.result);
    };
    reader.readAsDataURL(file);
  }, []);

  // The scene. Nothing made in this session leaves the canvas blank: the
  // newest picture in the gallery shown here would read as the answer to a
  // prompt not yet written. It comes back on request.
  const newest = artifacts[0] ?? null;
  const newestThumb = useArtifactThumbnail(tool === "create" && !lastResult ? newest : null);
  const recallNewest = useCallback(async () => {
    if (!newest) return;
    try {
      setLastResult({ kind: "image", src: await artifactDataUrl(newest) });
    } catch {
      // The gallery is one tab away; a recall that cannot read is no loss.
    }
  }, [newest]);
  const sceneResult: StageResult | undefined =
    tool !== "create" && source
      ? { kind: "image", src: source, alt: t("Picked image") }
      : lastResult;
  const idle =
    tool === "create"
      ? {
          seed: "image-generate",
          hint: t("Describe an image. It will appear here."),
          recall: newest
            ? {
                label: t("Last creation"),
                thumb: newestThumb?.src,
                onRecall: () => void recallNewest(),
              }
            : undefined,
        }
      : {
          seed: `image-${tool}`,
          hint:
            tool === "upscale" ? t("Pick an image to enlarge.") : t("Pick an image to cut out."),
        };

  const scene = (
    <StageScene
      aspect={tool === "create" ? effectiveAspect || "1:1" : "1:1"}
      result={sceneResult}
      wait={wait}
      waitLabel={t("Rendering")}
      reveal={reveal}
      onRevealEnd={() => setReveal(false)}
      idle={idle}
    />
  );

  const sourceActions = (
    <div className="stage-dock-actions studio-desk-source">
      <button
        type="button"
        className="stage-dock-action"
        onClick={() => fileInputRef.current?.click()}
      >
        {source ? t("Replace image") : t("Choose an image")}
      </button>
      <button type="button" className="stage-dock-action" onClick={() => setPicking(true)}>
        {t("From the gallery")}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          onPickFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );

  const dock =
    tool === "create" ? (
      <Dock>
        <DockComposer
          value={prompt}
          onChange={setPrompt}
          maxLength={promptLimit}
          placeholder={t("Describe the image to generate")}
          ariaLabel={t("Prompt")}
          cost={totalCost}
          canSend={Boolean(model && prompt.trim())}
          busy={busy}
          onSend={() => void generate()}
          sendLabel={t("Generate")}
          tools={
            <>
              <ModelPickerChip
                label={t("Image model")}
                selectedId={model?.id ?? ""}
                pinnedId={recommendedId}
                entries={generateModels
                  .filter((entry) => !entry.offline)
                  .map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    subtitle: modelSubtitle(entry),
                    tags: entry.id === recommendedId ? [{ label: t("Recommended") }] : undefined,
                  }))}
                onSelect={(id) => {
                  setModelId(id);
                  rememberImageModel(id);
                }}
              />
              {aspectOptions.length > 0 ? (
                <DockSelectChip
                  label={t("Aspect ratio")}
                  value={effectiveAspect}
                  options={aspectOptions}
                  onChange={setAspectRatio}
                />
              ) : null}
              {resolutionOptions.length > 0 ? (
                <DockSelectChip
                  label={t("Resolution")}
                  value={effectiveResolution}
                  options={resolutionOptions}
                  onChange={setResolution}
                  format={formatOption}
                />
              ) : null}
            </>
          }
          blocker={
            busy ? undefined : !model ? { text: t("Choose an image model first.") } : undefined
          }
        />
      </Dock>
    ) : (
      <Dock>
        <DockComposer
          canSend={Boolean(source)}
          busy={busy}
          onSend={() => void (tool === "upscale" ? runUpscale() : runCutout())}
          sendLabel={tool === "upscale" ? t("Upscale") : t("Remove background")}
          tools={
            tool === "upscale" ? (
              <DockSelectChip
                label={t("Upscale factor")}
                value={upscaleScale}
                options={["2", "3", "4"]}
                onChange={setUpscaleScale}
                format={(option) => `x${option}`}
              />
            ) : undefined
          }
          blocker={
            busy || source
              ? undefined
              : {
                  text:
                    tool === "upscale"
                      ? t("Pick an image to enlarge (at least 256 by 256 pixels).")
                      : t("Pick an image; the background lifts out into a transparent PNG."),
                }
          }
        >
          {sourceActions}
        </DockComposer>
      </Dock>
    );

  const inspector =
    tool === "create" ? (
      <>
        <StudioField label={t("Negative prompt")}>
          <textarea
            className="studio-textarea"
            rows={2}
            value={negativePrompt}
            placeholder={t("What to avoid (optional)")}
            onChange={(event) => setNegativePrompt(event.target.value)}
          />
        </StudioField>
        {!comparing ? (
          <SliderField
            label={t("Variants")}
            min={1}
            max={4}
            step={1}
            value={variants}
            onChange={setVariants}
          />
        ) : null}
        {maxSteps > 1 ? (
          <SliderField
            label={t("Steps")}
            min={1}
            max={maxSteps}
            step={1}
            value={steps > 0 ? Math.min(steps, maxSteps) : (constraints?.steps?.default ?? 1)}
            onChange={setSteps}
          />
        ) : null}
        <StudioField
          label={t("Compare models")}
          hint={
            comparing
              ? t("{count} render side by side", { count: compareModels.length + 1 })
              : t("Optional")
          }
        >
          <div className="studio-upload">
            {compareModels.length > 0 ? (
              <div className="studio-compare-chips">
                {compareModels.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="studio-compare-chip"
                    aria-label={t("Stop comparing with {model}", { model: entry.name })}
                    onClick={() =>
                      setCompareIds((current) => current.filter((id) => id !== entry.id))
                    }
                  >
                    <span>{entry.name}</span>
                    <span aria-hidden>x</span>
                  </button>
                ))}
              </div>
            ) : null}
            <Select
              value={null}
              placeholder={t("Add a model to compare")}
              ariaLabel={t("Add a model to compare")}
              onChange={(id) =>
                setCompareIds((current) => (current.includes(id) ? current : [...current, id]))
              }
              options={generateModels
                .filter((entry) => entry.id !== modelId && !compareIds.includes(entry.id))
                .map((entry) => ({ value: entry.id, label: entry.name }))}
            />
          </div>
        </StudioField>
        {styles.length > 0 ? (
          <StudioField label={t("Style")}>
            <Select
              value={stylePreset}
              placeholder={t("None")}
              ariaLabel={t("Style preset")}
              onChange={setStylePreset}
              options={[
                { value: "", label: t("None") },
                ...styles.map((style) => ({ value: style, label: style })),
              ]}
            />
          </StudioField>
        ) : null}
        <StudioField label={t("Seed")} hint={t("Blank for random")}>
          <input
            className="studio-input"
            inputMode="numeric"
            value={seed}
            placeholder={t("Random")}
            aria-label={t("Seed")}
            onChange={(event) => setSeed(event.target.value.replace(/[^0-9]/g, ""))}
          />
        </StudioField>
        <StudioField label={t("Improve prompt")} hint={t("AI expands it first")}>
          <Switch
            checked={improvePrompt}
            onCheckedChange={setImprovePrompt}
            aria-label={t("Improve the prompt before generating")}
          />
        </StudioField>
        <StudioField label={t("Format")}>
          <PillGroup
            options={[{ value: "png" }, { value: "webp" }, { value: "jpeg" }]}
            value={format}
            onChange={setFormat}
            ariaLabel={t("Image format")}
          />
        </StudioField>
        <StudioField label={t("Hide watermark")}>
          <Switch
            checked={hideWatermark}
            onCheckedChange={setHideWatermark}
            aria-label={t("Hide watermark")}
          />
        </StudioField>
        <StudioField label={t("Embed metadata")} hint={t("Prompt in EXIF")}>
          <Switch
            checked={embedExif}
            onCheckedChange={setEmbedExif}
            aria-label={t("Embed prompt metadata")}
          />
        </StudioField>
      </>
    ) : tool === "upscale" ? (
      <StudioField label={t("Enhance")} hint={t("AI detail pass")}>
        <Switch
          checked={upscaleEnhance}
          onCheckedChange={setUpscaleEnhance}
          aria-label={t("Enhance while upscaling")}
        />
      </StudioField>
    ) : undefined;

  return (
    <>
      <StudioDesk
        tools={tools}
        scene={scene}
        notice={
          error ? (
            <div className="stage-notice" data-tone="error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="stage-dock-action"
                onClick={() => setError(undefined)}
              >
                {t("Dismiss")}
              </button>
            </div>
          ) : undefined
        }
        dock={dock}
        inspector={inspector}
        strip={
          <Filmstrip
            kinds={["image"]}
            epoch={galleryEpoch}
            pending={busy && tool === "create" ? inFlight : 0}
            onArtifactsChanged={setArtifacts}
            onOpenGallery={onOpenGallery}
            onReusePrompt={(artifact) => setPrompt(artifact.prompt)}
          />
        }
      />
      {picking ? (
        <GalleryPicker
          onClose={() => setPicking(false)}
          description={t("Pick an image you have already produced.")}
          onPick={(dataUri) => setSource(dataUri)}
        />
      ) : null}
    </>
  );
}
