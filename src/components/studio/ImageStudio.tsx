// Image studio: generate (constraint-driven), edit, and upscale. Sync
// generation returns base64 directly; heavy models go through the async
// queue path (their sync call 502s at the backend's ~60 s edge cap even when
// the image rendered). Every result lands in the on-disk gallery.

import { IconImagesSparkle } from "central-icons/IconImagesSparkle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveArtifactFromBase64, readArtifactBase64 } from "../../lib/studio/artifacts";
import { estimateCostCredits, imageEditModels } from "../../lib/studio/catalog";
import { modelsOfType } from "../../lib/studio/catalog";
import { MediaError, mediaGet, mediaRaw } from "../../lib/studio/client";
import { composeImages, MAX_COMPOSE_IMAGES } from "../../lib/studio/edit-image";
import { generateImages } from "../../lib/studio/generate-image";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import { GalleryStrip } from "./GalleryStrip";
import { GenerationLayout } from "./GenerationLayout";
import {
  CostHint,
  effectiveOption,
  ModelSelect,
  PillGroup,
  SliderField,
  StudioField,
} from "./controls";

type ImageMode = "generate" | "edit" | "upscale";

export function ImageStudio({ catalog }: { catalog: MediaCatalog }) {
  const [mode, setMode] = useState<ImageMode>("generate");
  const generateModels = useMemo(() => modelsOfType(catalog, "image"), [catalog]);
  const editModels = useMemo(() => imageEditModels(catalog), [catalog]);

  const [modelId, setModelId] = useState(generateModels[0]?.id ?? "");
  const model = generateModels.find((entry) => entry.id === modelId);
  const constraints = model?.constraints;

  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [steps, setSteps] = useState(0);
  const [variants, setVariants] = useState(1);
  const [seed, setSeed] = useState("");
  const [stylePreset, setStylePreset] = useState("");
  const [styles, setStyles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [galleryEpoch, setGalleryEpoch] = useState(0);

  // Edit takes one to three source images (two or more compose into one via
  // multi-edit); upscale keeps a single source.
  const [editSources, setEditSources] = useState<string[]>([]);
  const [sourceDataUri, setSourceDataUri] = useState("");
  const [editModelId, setEditModelId] = useState(editModels[0]?.id ?? "");
  const [editPrompt, setEditPrompt] = useState("");
  const [upscaleScale, setUpscaleScale] = useState<"2" | "3" | "4">("2");
  const [upscaleEnhance, setUpscaleEnhance] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Style presets are a Venice nicety the backend may not expose: hide the
  // control when the request fails rather than surfacing an error.
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
  const costCredits = model
    ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier })
    : undefined;
  const totalCost = costCredits !== undefined ? costCredits * variants : undefined;

  const registerResults = useCallback(
    async (images: string[], usedModel: string, usedPrompt: string) => {
      for (const base64 of images) {
        await saveArtifactFromBase64(base64, "png", {
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
    const body: Record<string, unknown> = {
      model: model.id,
      prompt: prompt.trim(),
      variants,
      format: "png",
      hide_watermark: true,
    };
    if (negativePrompt.trim()) body.negative_prompt = negativePrompt.trim();
    if (effectiveAspect) body.aspect_ratio = effectiveAspect;
    if (effectiveResolution) body.resolution = effectiveResolution;
    if (maxSteps > 0 && steps > 0) body.steps = steps;
    if (seed.trim() && Number.isFinite(Number(seed))) body.seed = Number(seed);
    if (stylePreset) body.style_preset = stylePreset;
    try {
      const images = await generateImages(model.id, body);
      if (images.length === 0) {
        throw new MediaError("The backend returned no image.", { status: 200 });
      }
      await registerResults(images, model.id, prompt.trim());
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "The generation failed.");
    } finally {
      setBusy(false);
    }
  }, [
    model,
    prompt,
    busy,
    variants,
    negativePrompt,
    effectiveAspect,
    effectiveResolution,
    maxSteps,
    steps,
    seed,
    stylePreset,
    registerResults,
  ]);

  const runEdit = useCallback(async () => {
    if (editSources.length === 0 || !editPrompt.trim() || !editModelId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // One source edits that image; two or three compose into one. composeImages
      // routes to /image/edit or /image/multi-edit and handles the async queue.
      const image = await composeImages(editModelId, editPrompt.trim(), editSources);
      await registerResults([image], editModelId, editPrompt.trim());
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : "The edit failed.");
    } finally {
      setBusy(false);
    }
  }, [editSources, editPrompt, editModelId, busy, registerResults]);

  const runUpscale = useCallback(async () => {
    if (!sourceDataUri || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // Upscale wants raw base64, without the data-URI prefix edit uses.
      const rawBase64 = sourceDataUri.replace(/^data:[^,]*,/, "");
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
    } catch (upscaleError) {
      setError(upscaleError instanceof Error ? upscaleError.message : "The upscale failed.");
    } finally {
      setBusy(false);
    }
  }, [sourceDataUri, busy, upscaleScale, upscaleEnhance, registerResults]);

  const onPickFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setSourceDataUri(reader.result);
    };
    reader.readAsDataURL(file);
  }, []);

  const onAddEditFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        const dataUri = reader.result;
        setEditSources((current) => [...current, dataUri].slice(0, MAX_COMPOSE_IMAGES));
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const sendToEdit = useCallback(async (artifact: StudioArtifact) => {
    const base64 = await readArtifactBase64(artifact);
    setEditSources((current) =>
      [...current, `data:image/png;base64,${base64}`].slice(0, MAX_COMPOSE_IMAGES),
    );
    setMode("edit");
  }, []);

  const isGenerate = mode === "generate";
  const canSubmit = isGenerate
    ? Boolean(model && prompt.trim())
    : mode === "edit"
      ? Boolean(editSources.length > 0 && editPrompt.trim() && editModelId)
      : Boolean(sourceDataUri);

  const controls = (
    <>
      <SegmentedControl
        value={mode}
        onValueChange={setMode}
        aria-label="Image tool"
        options={[
          { value: "generate", label: "Generate" },
          { value: "edit", label: "Edit" },
          { value: "upscale", label: "Upscale" },
        ]}
      />
      {isGenerate ? (
        <>
          <StudioField label="Model">
            <ModelSelect
              models={generateModels}
              value={modelId || null}
              onChange={setModelId}
              ariaLabel="Image model"
            />
          </StudioField>
          <StudioField
            label="Prompt"
            hint={promptLimit ? `${prompt.length}/${promptLimit}` : undefined}
          >
            <textarea
              className="studio-textarea"
              rows={4}
              value={prompt}
              maxLength={promptLimit}
              placeholder="Describe the image you want"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </StudioField>
          <StudioField label="Negative prompt">
            <textarea
              className="studio-textarea"
              rows={2}
              value={negativePrompt}
              placeholder="What to avoid (optional)"
              onChange={(event) => setNegativePrompt(event.target.value)}
            />
          </StudioField>
          {aspectOptions.length > 0 ? (
            <StudioField label="Aspect ratio">
              <PillGroup
                options={aspectOptions.map((value) => ({ value }))}
                value={effectiveAspect}
                onChange={setAspectRatio}
                ariaLabel="Aspect ratio"
              />
            </StudioField>
          ) : null}
          {resolutionOptions.length > 0 ? (
            <StudioField label="Resolution">
              <PillGroup
                options={resolutionOptions.map((value) => ({ value }))}
                value={effectiveResolution}
                onChange={setResolution}
                ariaLabel="Resolution"
              />
            </StudioField>
          ) : null}
          {maxSteps > 1 ? (
            <SliderField
              label="Steps"
              min={1}
              max={maxSteps}
              step={1}
              value={steps > 0 ? Math.min(steps, maxSteps) : (constraints?.steps?.default ?? 1)}
              onChange={setSteps}
            />
          ) : null}
          <SliderField
            label="Variants"
            min={1}
            max={4}
            step={1}
            value={variants}
            onChange={setVariants}
          />
          {styles.length > 0 ? (
            <StudioField label="Style">
              <select
                className="studio-native-select"
                value={stylePreset}
                aria-label="Style preset"
                onChange={(event) => setStylePreset(event.target.value)}
              >
                <option value="">None</option>
                {styles.map((style) => (
                  <option key={style} value={style}>
                    {style}
                  </option>
                ))}
              </select>
            </StudioField>
          ) : null}
          <StudioField label="Seed" hint="Blank for random">
            <input
              className="studio-input"
              inputMode="numeric"
              value={seed}
              placeholder="Random"
              onChange={(event) => setSeed(event.target.value.replace(/[^0-9]/g, ""))}
            />
          </StudioField>
        </>
      ) : mode === "edit" ? (
        <>
          <StudioField
            label="Source images"
            hint={
              editSources.length > 1
                ? `Combining ${editSources.length}`
                : `Add up to ${MAX_COMPOSE_IMAGES} to combine`
            }
          >
            <div className="studio-upload">
              {editSources.length > 0 ? (
                <div className="studio-edit-sources">
                  {editSources.map((source, index) => (
                    <div key={`${index}-${source.slice(-24)}`} className="studio-edit-source">
                      <img src={source} alt={`Source ${index + 1}`} />
                      <button
                        type="button"
                        className="studio-edit-source-remove"
                        aria-label={`Remove source ${index + 1}`}
                        onClick={() =>
                          setEditSources((current) => current.filter((_, i) => i !== index))
                        }
                      >
                        <span aria-hidden>x</span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {editSources.length < MAX_COMPOSE_IMAGES ? (
                <button
                  type="button"
                  className="studio-secondary-button"
                  onClick={() => editInputRef.current?.click()}
                >
                  {editSources.length > 0 ? "Add another image" : "Choose an image"}
                </button>
              ) : null}
              <input
                ref={editInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(event) => {
                  onAddEditFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
          </StudioField>
          <StudioField label="Model">
            <ModelSelect
              models={editModels}
              value={editModelId || null}
              onChange={setEditModelId}
              ariaLabel="Edit model"
            />
          </StudioField>
          <StudioField label="Instruction">
            <textarea
              className="studio-textarea"
              rows={3}
              value={editPrompt}
              placeholder={
                editSources.length > 1 ? "Describe how to combine them" : "Describe the change"
              }
              onChange={(event) => setEditPrompt(event.target.value)}
            />
          </StudioField>
        </>
      ) : (
        <>
          <StudioField label="Source image">
            <div className="studio-upload">
              {sourceDataUri ? (
                <img src={sourceDataUri} alt="Source" className="studio-upload-preview" />
              ) : null}
              <button
                type="button"
                className="studio-secondary-button"
                onClick={() => fileInputRef.current?.click()}
              >
                {sourceDataUri ? "Replace image" : "Choose an image"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(event) => onPickFile(event.target.files?.[0])}
              />
            </div>
          </StudioField>
          <StudioField label="Scale">
            <PillGroup
              options={[{ value: "2" }, { value: "3" }, { value: "4" }]}
              value={upscaleScale}
              onChange={setUpscaleScale}
              ariaLabel="Upscale factor"
            />
          </StudioField>
          <StudioField label="Enhance" hint="AI detail pass">
            <Switch
              checked={upscaleEnhance}
              onCheckedChange={setUpscaleEnhance}
              aria-label="Enhance while upscaling"
            />
          </StudioField>
        </>
      )}
    </>
  );

  const action = (
    <button
      type="button"
      className="studio-primary-button"
      disabled={!canSubmit || busy}
      onClick={isGenerate ? generate : mode === "edit" ? runEdit : runUpscale}
    >
      {busy ? <Spinner aria-hidden /> : null}
      <span>
        {busy
          ? "Working..."
          : isGenerate
            ? "Generate"
            : mode === "edit"
              ? editSources.length > 1
                ? "Combine images"
                : "Apply edit"
              : "Upscale"}
      </span>
      {isGenerate && !busy ? <CostHint credits={totalCost} /> : null}
    </button>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {error ? <p className="studio-error">{error}</p> : null}
      {busy && isGenerate ? (
        <div className="studio-image-grid" aria-hidden>
          {Array.from({ length: variants }, (_, index) => (
            // Placeholder tiles are positional and never reorder.
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeletons
            <div key={index} className="studio-image-skeleton" />
          ))}
        </div>
      ) : null}
      <GalleryStrip
        kind="image"
        epoch={galleryEpoch}
        onArtifactsChanged={setArtifacts}
        onSendToEdit={(artifact) => void sendToEdit(artifact)}
        empty={
          !busy && artifacts.length === 0 ? (
            <EmptyState
              icon={<IconImagesSparkle size={22} />}
              title="No images yet"
              description="Describe an image and generate. Results stay in your gallery."
            />
          ) : null
        }
      />
    </GenerationLayout>
  );
}
