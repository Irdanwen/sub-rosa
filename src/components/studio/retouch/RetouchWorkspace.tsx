// One retouch session, on either shell: the picture as large as the room
// allows, the instruction under it, the versions beside it. The desktop tab
// and the phone screen differ only in how the same pieces are laid out.

import { IconArrowDownCircle } from "central-icons/IconArrowDownCircle";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowRotateCounterClockwise } from "central-icons/IconArrowRotateCounterClockwise";
import { IconArrowUndoUp } from "central-icons/IconArrowUndoUp";
import { IconBrush } from "central-icons/IconBrush";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconEraser } from "central-icons/IconEraser";
import { IconExpand } from "central-icons/IconExpand";
import { IconFileDownload } from "central-icons/IconFileDownload";
import { IconSelectLasso } from "central-icons/IconSelectLasso";
import { IconShareOs } from "central-icons/IconShareOs";
import { IconSplit } from "central-icons/IconSplit";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { friendlyErrorMessage } from "../../../lib/errors";
import { t } from "../../../lib/i18n";
import { hapticImpact, hapticNotify } from "../../../lib/haptics";
import { openModalCount } from "../../../lib/modal-focus";
import {
  mobileDictationCancel,
  mobileDictationStart,
  mobileDictationStop,
  saveToPhotos,
} from "../../../lib/tauri";
import { isPrimaryShiftShortcut, isPrimaryShortcut } from "../../../lib/platform";
import { exportArtifact } from "../../../lib/studio/artifacts";
import { estimateRenderMs, renderEtaKey } from "../../../lib/studio/render-eta";
import { prepareSource } from "../../../lib/studio/retouch/canvas-io";
import {
  formatSeconds,
  shortCaption,
  versionCaption,
  versionTitle,
} from "../../../lib/studio/retouch/labels";
import { shareVersionFile } from "../../../lib/studio/retouch/jobs";
import { parentOf } from "../../../lib/studio/retouch/lineage";
import { RETOUCH_PRESETS, type RetouchPreset } from "../../../lib/studio/retouch/presets";
import {
  type RetouchReference,
  useRetouchSession,
} from "../../../lib/studio/retouch/useRetouchSession";
import { hasZone, ratioValue, type ZoneStroke } from "../../../lib/studio/retouch/zone";
import type { MediaCatalog } from "../../../lib/studio/types";
import { GalleryPicker } from "../GalleryPicker";
import { type CompareMode, RetouchCanvas, type ZoneTool } from "./RetouchCanvas";
import { RetouchComposer, RetouchModelControl, RetouchTriesControl } from "./RetouchComposer";
import { RetouchFilmstrip, useVersionSrc } from "./RetouchFilmstrip";
import { imageFilesOf } from "./RetouchPicker";
import { aspectLabel, RetouchSettingsPanel } from "./RetouchSettings";
import { RetouchVariants } from "./RetouchVariants";
import { useDismiss } from "./useDismiss";
import "./retouch.css";
import "../stage/stage.css";

interface ZoneState {
  tool: ZoneTool;
  radius: number;
  strokes: ZoneStroke[];
}

const BRUSH_SIZES = [12, 24, 48] as const;

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(t("The file could not be read.")));
    reader.readAsDataURL(file);
  });
}

/** Extending to the shape the picture already has would only re-render it. */
function sameShape(ratio: string, size: { width: number; height: number } | undefined): boolean {
  const value = ratioValue(ratio);
  if (!value || !size?.height) return false;
  return Math.abs(value - size.width / size.height) / value < 0.02;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "TEXTAREA" ||
    (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "range")
  );
}

export function RetouchWorkspace({
  catalog,
  rootId,
  layout,
  onClose,
}: {
  catalog: MediaCatalog;
  rootId: string;
  layout: "desktop" | "phone";
  onClose: () => void;
}) {
  const s = useRetouchSession(catalog, rootId);
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<RetouchReference[]>([]);
  const [compare, setCompare] = useState<CompareMode>("off");
  const [holding, setHolding] = useState(false);
  const [zone, setZone] = useState<ZoneState | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [finishesOpen, setFinishesOpen] = useState(false);
  const finishesRef = useRef<HTMLDivElement>(null);
  const closeFinishes = useCallback(() => setFinishesOpen(false), []);
  useDismiss(finishesRef, finishesOpen, closeFinishes);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const phone = layout === "phone";

  const cursor = s.cursor;
  const parent = s.session && cursor ? parentOf(s.session, cursor.id) : undefined;
  const picture = useVersionSrc(cursor);
  const [shape, setShape] = useState<{ width: number; height: number } | undefined>(undefined);
  const before = useVersionSrc(parent);
  const src = picture?.src;
  const beforeSrc = before?.src;
  const maxRefs = Math.max(0, s.caps.maxInputs - 1);
  const zoneActive = Boolean(zone);
  const zoneReady = Boolean(zone && hasZone(zone.strokes));
  const variants = zoneActive ? 1 : s.settings.variants;
  const cost = s.unitCost === undefined ? undefined : s.unitCost * variants;
  const waitHere = s.pending.find((step) => step.parentId === cursor?.id);
  const estimate = s.model ? estimateRenderMs(renderEtaKey("retouch", s.model.id)) : undefined;

  // A version made from a version that is gone keeps no reveal to play.
  const reveal = Boolean(cursor && s.revealId === cursor.id && beforeSrc);

  const addFiles = useCallback(
    async (files: File[]) => {
      const room = maxRefs - refs.length;
      if (room <= 0) {
        setNotice(
          t("This model takes {count} images at most, the one retouched included.", {
            count: maxRefs + 1,
          }),
        );
        return;
      }
      try {
        const added = await Promise.all(
          files.slice(0, room).map(async (file) => ({
            id: crypto.randomUUID(),
            dataUri: await prepareSource(await readFile(file)),
          })),
        );
        setRefs((current) => [...current, ...added].slice(0, maxRefs));
      } catch (cause) {
        setNotice(friendlyErrorMessage(cause, t("The image could not be imported.")));
      }
    },
    [maxRefs, refs.length],
  );

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    if (zone && !zoneReady) {
      setNotice(t("Paint the zone to retouch first, or leave zone mode."));
      return;
    }
    const outcome = await s.submit({ prompt: text, refs, zone: zone?.strokes });
    if (outcome === "failed") return;
    setPrompt("");
    setRefs([]);
    setZone(undefined);
    setNotice(undefined);
  }, [prompt, zone, zoneReady, refs, s]);

  // Undo, redo and the before view, while no field has the keyboard. One
  // listener for the session's life, reading the current state through a ref.
  const keys = useRef({ s, zoneOpen: zoneActive });
  keys.current = { s, zoneOpen: zoneActive };
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.defaultPrevented) return;
      const { s: session, zoneOpen } = keys.current;
      const key = event.key.toLowerCase();
      if (key === "z" && isPrimaryShiftShortcut(event)) {
        event.preventDefault();
        session.redo();
      } else if (key === "z" && isPrimaryShortcut(event)) {
        event.preventDefault();
        session.undo();
      } else if (event.key === "\\" && !event.repeat) {
        setHolding(true);
      } else if (event.key === "Escape" && zoneOpen && openModalCount() === 0) {
        // A dialog over the stage owns its Escape.
        setZone(undefined);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "\\") setHolding(false);
    };
    const release = () => setHolding(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  // Keeping and sending the version on screen, from the phone.
  const keepInPhotos = async () => {
    if (!cursor) return;
    try {
      await saveToPhotos(cursor.path, "image");
      hapticNotify("success");
      setNotice(t("Saved to Photos."));
    } catch (cause) {
      setNotice(friendlyErrorMessage(cause, t("The picture could not be saved.")));
    }
  };
  const shareVersion = async () => {
    if (!cursor) return;
    try {
      await shareVersionFile(cursor.path);
    } catch (cause) {
      setNotice(friendlyErrorMessage(cause, t("The picture could not be shared.")));
    }
  };

  // A version arriving is felt as well as seen on a phone.
  const revealed = s.revealId;
  useEffect(() => {
    if (phone && revealed) hapticNotify("success");
  }, [phone, revealed]);

  const failure = s.failures.at(-1);
  const titleCaption = cursor ? shortCaption(versionCaption(cursor)) : "";
  const elapsed = cursor?.edit?.elapsedMs;
  const applyPreset = useCallback((preset: RetouchPreset) => {
    setPrompt(preset.instruction());
    if (preset.zone) {
      setCompare("off");
      setZone((current) => current ?? { tool: "brush", radius: BRUSH_SIZES[1], strokes: [] });
    }
  }, []);

  // Dictation on a phone: speaking an instruction beats typing it.
  const [dictating, setDictating] = useState(false);
  const toggleDictation = useCallback(async () => {
    try {
      if (dictating) {
        setDictating(false);
        const result = await mobileDictationStop({ style: "standard" });
        const spoken = result.text.trim();
        if (spoken)
          setPrompt((current) => (current.trim() ? `${current.trim()} ${spoken}` : spoken));
        hapticNotify("success");
        return;
      }
      await mobileDictationStart();
      setDictating(true);
      hapticImpact("medium");
    } catch (cause) {
      setDictating(false);
      setNotice(friendlyErrorMessage(cause, t("Dictation is not available.")));
    }
  }, [dictating]);
  const dictatingRef = useRef(false);
  dictatingRef.current = dictating;
  useEffect(
    () => () => {
      if (dictatingRef.current) void mobileDictationCancel().catch(() => undefined);
    },
    [],
  );

  const onDrop = (event: DragEvent) => {
    const files = imageFilesOf(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  if (s.loaded && !s.session) {
    return (
      <div className="retouch-workspace retouch-gone" data-layout={layout}>
        <p>{t("This image is no longer in the gallery.")}</p>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t("Choose another image")}
        </button>
      </div>
    );
  }
  if (!s.loaded || !cursor) {
    return <div className="retouch-workspace stage" data-layout={layout} aria-busy="true" />;
  }

  return (
    <section
      className="retouch-workspace stage"
      data-layout={layout}
      aria-label={t("Retouch")}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <RetouchCanvas
        src={src}
        pixelSize={picture?.size}
        onPixelSize={setShape}
        beforeSrc={beforeSrc}
        alt={versionCaption(cursor) || versionTitle(cursor)}
        reveal={reveal}
        onRevealEnd={s.clearReveal}
        onHoldChange={setHolding}
        compare={holding ? "hold" : compare}
        wait={
          waitHere
            ? {
                seed: waitHere.key,
                phase: waitHere.phase,
                startedAt: waitHere.startedAt,
                estimateMs: waitHere.op === "upscale" ? undefined : estimate,
                label: waitHere.op === "upscale" ? t("Upscaling") : undefined,
              }
            : undefined
        }
        zone={
          zone
            ? {
                ...zone,
                onChange: (strokes) => setZone((current) => current && { ...current, strokes }),
              }
            : undefined
        }
      >
        <header className="retouch-title">
          <h2>{versionTitle(cursor)}</h2>
          {titleCaption ? (
            <span className="retouch-title-chip">
              {elapsed
                ? t("{caption} · {time}", { caption: titleCaption, time: formatSeconds(elapsed) })
                : titleCaption}
            </span>
          ) : null}
        </header>

        <div className="retouch-tools" role="toolbar" aria-label={t("Retouch tools")}>
          <button
            type="button"
            className="retouch-icon"
            aria-label={t("Previous version")}
            title={t("Previous version")}
            disabled={!s.canUndo}
            onClick={s.undo}
          >
            <IconArrowRotateCounterClockwise size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="retouch-icon"
            aria-label={t("Next version")}
            title={t("Next version")}
            disabled={!s.canRedo}
            onClick={s.redo}
          >
            <IconArrowRotateClockwise size={18} aria-hidden />
          </button>
          <span className="retouch-tools-gap" />
          <button
            type="button"
            className="retouch-icon"
            aria-pressed={compare === "split"}
            aria-label={t("Compare with the version before")}
            title={t("Compare with the version before")}
            disabled={!parent || zoneActive}
            onClick={() => setCompare((mode) => (mode === "split" ? "off" : "split"))}
          >
            <IconSplit size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="retouch-icon"
            aria-pressed={zoneActive}
            aria-label={t("Retouch a zone only")}
            title={t("Retouch a zone only")}
            onClick={() => {
              setCompare("off");
              setZone((current) =>
                current ? undefined : { tool: "brush", radius: BRUSH_SIZES[1], strokes: [] },
              );
            }}
          >
            <IconBrush size={18} aria-hidden />
          </button>
          <div className="retouch-finishes" ref={finishesRef}>
            <button
              type="button"
              className="retouch-icon"
              aria-label={t("Finishes")}
              title={t("Finishes")}
              aria-expanded={finishesOpen}
              onClick={() => setFinishesOpen((open) => !open)}
            >
              <IconExpand size={18} aria-hidden />
            </button>
            {finishesOpen ? (
              <div className="retouch-menu" role="menu" data-align="end">
                {([2, 4] as const).map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setFinishesOpen(false);
                      void s.upscale(scale);
                    }}
                  >
                    {t("Upscale x{scale}", { scale })}
                  </button>
                ))}
                {s.caps.aspectRatios
                  .filter((ratio) => !sameShape(ratio, shape))
                  .map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setFinishesOpen(false);
                        void s.extend(ratio);
                      }}
                    >
                      {t("Extend to {ratio}", { ratio })}
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
          {phone ? (
            <>
              <button
                type="button"
                className="retouch-icon"
                aria-label={t("Save to Photos")}
                title={t("Save to Photos")}
                onClick={() => void keepInPhotos()}
              >
                <IconArrowDownCircle size={18} aria-hidden />
              </button>
              <button
                type="button"
                className="retouch-icon"
                aria-label={t("Share")}
                title={t("Share")}
                onClick={() => void shareVersion()}
              >
                <IconShareOs size={18} aria-hidden />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="retouch-icon"
              aria-label={t("Save a copy")}
              title={t("Save a copy")}
              onClick={() => void exportArtifact(cursor).catch(() => undefined)}
            >
              <IconFileDownload size={18} aria-hidden />
            </button>
          )}
          <button
            type="button"
            className="retouch-icon"
            aria-label={t("Close the retouch")}
            title={t("Close the retouch")}
            onClick={onClose}
          >
            <IconCrossMedium size={18} aria-hidden />
          </button>
        </div>

        {zone ? (
          <div className="retouch-zone-bar" role="toolbar" aria-label={t("Zone tools")}>
            {(
              [
                ["brush", t("Brush"), IconBrush],
                ["lasso", t("Lasso"), IconSelectLasso],
                ["eraser", t("Eraser"), IconEraser],
              ] as const
            ).map(([tool, label, Icon]) => (
              <button
                key={tool}
                type="button"
                className="retouch-icon"
                aria-pressed={zone.tool === tool}
                aria-label={label}
                title={label}
                onClick={() => setZone({ ...zone, tool })}
              >
                <Icon size={18} aria-hidden />
              </button>
            ))}
            {zone.tool !== "lasso" ? (
              <fieldset className="retouch-sizes" aria-label={t("Brush size")}>
                {BRUSH_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    aria-pressed={zone.radius === size}
                    aria-label={t("{size} pixels", { size })}
                    onClick={() => setZone({ ...zone, radius: size })}
                  >
                    <span style={{ width: size / 2, height: size / 2 }} />
                  </button>
                ))}
              </fieldset>
            ) : null}
            <button
              type="button"
              className="retouch-icon"
              aria-label={t("Undo the last stroke")}
              title={t("Undo the last stroke")}
              disabled={zone.strokes.length === 0}
              onClick={() => setZone({ ...zone, strokes: zone.strokes.slice(0, -1) })}
            >
              <IconArrowUndoUp size={18} aria-hidden />
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={zone.strokes.length === 0}
              onClick={() => setZone({ ...zone, strokes: [] })}
            >
              {t("Clear")}
            </button>
            <span className="retouch-zone-hint">
              {zoneReady
                ? t("Only the painted zone will change.")
                : t("Paint over what should change.")}
            </span>
          </div>
        ) : null}

        {s.session && s.session.versions.length + s.pending.length > 1 ? (
          <RetouchFilmstrip
            session={s.session}
            cursorId={cursor.id}
            pending={s.pending}
            onSelect={s.goTo}
            orientation={phone ? "horizontal" : "vertical"}
          />
        ) : null}

        <div className="retouch-dock">
          {cursor.edit?.unmerged ? (
            <p className="retouch-notice" role="status">
              {t(
                "This zone could not be merged back: the image it came from no longer exists. The version shows the zone alone.",
              )}
            </p>
          ) : null}
          {failure ? (
            <div className="retouch-notice" role="alert" data-tone="error">
              <span>{t("A retouch failed: {reason}", { reason: failure.message })}</span>
              <button
                type="button"
                className="retouch-icon"
                aria-label={t("Dismiss")}
                onClick={() => s.dismissFailure(failure.jobId)}
              >
                <IconCrossSmall size={14} aria-hidden />
              </button>
            </div>
          ) : null}
          {s.error || notice ? (
            <div className="retouch-notice" role="alert" data-tone="error">
              <span>{s.error ?? notice}</span>
              <button
                type="button"
                className="retouch-icon"
                aria-label={t("Dismiss")}
                onClick={() => {
                  s.clearError();
                  setNotice(undefined);
                }}
              >
                <IconCrossSmall size={14} aria-hidden />
              </button>
            </div>
          ) : null}
          {s.queue.length > 0 ? (
            <div className="retouch-queue">
              {!s.queueArmed ? (
                <button type="button" className="btn btn-secondary" onClick={s.armQueue}>
                  {s.queue.length === 1
                    ? t("Send the waiting retouch")
                    : t("Send the {count} waiting retouches", { count: s.queue.length })}
                </button>
              ) : null}
              <ul aria-label={t("Next retouches")}>
                {s.queue.map((item) => (
                  <li key={item.id}>
                    <span>{t("Next: {prompt}", { prompt: shortCaption(item.prompt, 60) })}</span>
                    <button
                      type="button"
                      className="retouch-icon"
                      aria-label={t("Remove from the queue")}
                      onClick={() => s.removeQueued(item.id)}
                    >
                      <IconCrossSmall size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {settingsOpen ? (
            <RetouchSettingsPanel
              caps={s.caps}
              settings={s.settings}
              onChange={s.setSettings}
              onClose={() => setSettingsOpen(false)}
              zoneActive={zoneActive}
              lead={
                phone ? (
                  <section>
                    <h3>{t("Model")}</h3>
                    <RetouchModelControl
                      models={s.models}
                      model={s.model}
                      onModel={(modelId) => s.setSettings({ modelId })}
                    />
                    {!zoneActive ? (
                      <>
                        <h3>{t("Tries per send")}</h3>
                        <RetouchTriesControl
                          variants={s.settings.variants}
                          onVariants={(count) => s.setSettings({ variants: count })}
                        />
                      </>
                    ) : null}
                  </section>
                ) : undefined
              }
            />
          ) : null}
          <RetouchComposer
            value={prompt}
            onChange={setPrompt}
            onSubmit={() => void send()}
            rendering={Boolean(waitHere) && !zoneActive}
            zoneActive={zoneActive}
            disabled={!s.model}
            refs={refs}
            maxRefs={maxRefs}
            onRemoveRef={(id) => setRefs((current) => current.filter((ref) => ref.id !== id))}
            onAddFiles={(files) => void addFiles(files)}
            onPickGallery={() => setGalleryOpen(true)}
            models={s.models}
            model={s.model}
            onModel={(modelId) => s.setSettings({ modelId })}
            variants={s.settings.variants}
            onVariants={(count) => s.setSettings({ variants: count })}
            cost={cost}
            aspectLabel={zoneActive ? t("Zone") : aspectLabel(s.settings.aspectRatio)}
            onOpenSettings={() => setSettingsOpen((open) => !open)}
            settingsOpen={settingsOpen}
            presets={RETOUCH_PRESETS}
            onPreset={applyPreset}
            compact={phone}
            dictating={dictating}
            onDictate={phone ? () => void toggleDictation() : undefined}
          />
        </div>
      </RetouchCanvas>

      {galleryOpen ? (
        <GalleryPicker
          title={t("Add an image to the instruction")}
          description={t("It is sent with the picture, and the instruction can refer to it.")}
          onClose={() => setGalleryOpen(false)}
          onPick={(dataUri, artifact) => {
            setGalleryOpen(false);
            void prepareSource(dataUri).then((prepared) =>
              setRefs((current) =>
                [
                  ...current.filter((ref) => ref.artifactId !== artifact.id),
                  { id: artifact.id, dataUri: prepared, artifactId: artifact.id },
                ].slice(0, maxRefs),
              ),
            );
          }}
        />
      ) : null}
      <RetouchVariants
        open={Boolean(s.variantGroup)}
        variants={s.variants}
        pending={s.variantPending}
        prompt={s.variants[0]?.prompt ?? ""}
        onPick={s.pickVariant}
        onClose={s.closeVariants}
      />
    </section>
  );
}
