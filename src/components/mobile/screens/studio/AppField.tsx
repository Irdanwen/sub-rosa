// One field of an app on the phone (ADR-0119): a step's setting drawn with
// the phone's own controls (a text box, a row whose choices come up as a
// sheet, a switch, a picture from the gallery), so the form reads like the
// rest of the Studio and its inputs never zoom the page.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconVideoClip } from "central-icons/IconVideoClip";
import { IconAudio } from "central-icons/IconAudio";
import { IconImages1 } from "central-icons/IconImages1";
import { useArtifactThumbnail } from "../../../../lib/artifact-media";
import { messageFromError } from "../../../../lib/errors";
import { t } from "../../../../lib/i18n";
import { acceptFor, type AssetKind, importAssetFile } from "../../../../lib/studio/import-asset";
import { isMobilePlatform } from "../../../../lib/mobile";
import { useModalFocus } from "../../../../lib/modal-focus";
import { listArtifacts } from "../../../../lib/studio/artifacts";
import type { MediaCatalog, StudioArtifact } from "../../../../lib/studio/types";
import type { ShownField } from "../../../../lib/studio/workflow/app";
import { nodeTypeLabel, paramLabel } from "../../../../lib/studio/workflow/labels";
import {
  modelParamPatch,
  modelsForParam,
  paramOptions,
} from "../../../../lib/studio/workflow/models";
import { nodeSchema } from "../../../../lib/studio/workflow/schema";
import { ActionSheet, type SheetAction } from "../../ActionSheet";
import { sheetHost } from "../../sheet-host";
import { GalleryPickerSheet } from "../assistants/AssistantReferencesScreen";
import { formatClipLength } from "./StudioLibrary";
import { formatRenderOption, SelectRow, StudioSetting, StudioToggle } from "./StudioControls";

export function AppField({
  shown,
  catalog,
  onMerge,
  onImported,
}: {
  shown: ShownField;
  catalog: MediaCatalog;
  onMerge: (partial: Record<string, unknown>) => void;
  /** A device file joined the gallery: the Studio's own listing should follow. */
  onImported?: () => void;
}) {
  const { field, node, param } = shown;
  const label = field.label || node.label || `${nodeTypeLabel(node.type)} · ${paramLabel(param)}`;
  const value = node.params[param.name];

  if (param.type === "artifact")
    return (
      <MediaField
        label={label}
        kind={
          node.params.assetKind === "video"
            ? "video"
            : node.params.assetKind === "audio"
              ? "audio"
              : "image"
        }
        artifactId={typeof value === "string" ? value : ""}
        onPick={(artifact) =>
          onMerge({ artifactId: artifact.id, assetLabel: artifact.prompt || artifact.fileName })
        }
        onImported={onImported}
      />
    );
  if (param.type === "boolean")
    return (
      <StudioToggle
        label={label}
        checked={value === true}
        onChange={(next) => onMerge({ [param.name]: next })}
      />
    );
  if (param.type === "model") {
    const models = modelsForParam(catalog, param);
    const id = typeof value === "string" ? value : "";
    return (
      <SelectRow
        label={label}
        value={id}
        options={models.map((model) => model.id)}
        format={(option) => models.find((model) => model.id === option)?.name ?? option}
        onChange={(next) =>
          onMerge(
            modelParamPatch(
              nodeSchema(node.type),
              node.params,
              param,
              models.find((model) => model.id === next),
            ),
          )
        }
      />
    );
  }
  const options = paramOptions(param, node.params, catalog);
  if (param.type === "enum" || options.length > 0)
    return (
      <SelectRow
        label={label}
        value={typeof value === "string" ? value : String(value ?? options[0] ?? "")}
        options={options}
        format={formatRenderOption}
        onChange={(next) => onMerge({ [param.name]: next })}
      />
    );
  if (param.type === "number")
    return (
      <StudioSetting label={label}>
        <input
          className="mobile-app-input"
          type="number"
          inputMode="decimal"
          min={param.min}
          max={param.max}
          step={param.step}
          value={typeof value === "number" ? value : ""}
          aria-label={label}
          onChange={(event) =>
            onMerge({
              [param.name]: event.target.value === "" ? undefined : Number(event.target.value),
            })
          }
        />
      </StudioSetting>
    );
  return (
    <StudioSetting label={label}>
      <textarea
        className="mobile-studio-prompt"
        rows={param.type === "text" ? 3 : 1}
        value={typeof value === "string" ? value : ""}
        aria-label={label}
        onChange={(event) => onMerge({ [param.name]: event.target.value })}
      />
    </StudioSetting>
  );
}

/** What a field of each kind is called, and what it offers. */
const WORDS: Record<
  AssetKind,
  {
    choose: () => string;
    another: () => string;
    empty: () => string;
    library: () => string;
    camera?: () => string;
  }
> = {
  image: {
    choose: () => t("Choose a picture"),
    another: () => t("Choose another picture"),
    empty: () => t("No picture yet: pick one from your photo library, or take one."),
    library: () => t("Photo library"),
    camera: () => t("Take a photo"),
  },
  video: {
    choose: () => t("Choose a clip"),
    another: () => t("Choose another clip"),
    empty: () => t("No clip yet: pick one from your photo library, or record one."),
    library: () => t("Photo library or Files"),
    camera: () => t("Record a clip"),
  },
  audio: {
    choose: () => t("Choose a track"),
    another: () => t("Choose another track"),
    empty: () => t("No track yet: pick one from Files."),
    library: () => t("Files"),
  },
};

/** A gallery item for a step that takes one, from wherever the person has
 * it: their photo library or files, their camera, or the Studio's gallery.
 * A device file joins the gallery first (import-asset.ts), since that is
 * where the engine reads assets from. */
function MediaField({
  label,
  kind,
  artifactId,
  onPick,
  onImported,
}: {
  label: string;
  kind: AssetKind;
  artifactId: string;
  onPick: (artifact: StudioArtifact) => void;
  onImported?: () => void;
}) {
  const [items, setItems] = useState<StudioArtifact[]>([]);
  const [sheet, setSheet] = useState<"sources" | "gallery" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const kinds = kind === "audio" ? (["music", "speech", "sfx"] as const) : ([kind] as const);
    Promise.all(kinds.map((entry) => listArtifacts(entry)))
      .then((lists) => setItems(lists.flat()))
      .catch(() => setItems([]));
  }, [kind]);
  const chosen = items.find((item) => item.id === artifactId);
  const thumbnail = useArtifactThumbnail(chosen ?? null);
  const words = WORDS[kind];

  const take = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    setBusy(true);
    try {
      const artifact = await importAssetFile(file, kind);
      setItems((known) => [artifact, ...known.filter((item) => item.id !== artifact.id)]);
      onPick(artifact);
      onImported?.();
    } catch (failure) {
      setError(messageFromError(failure));
    } finally {
      setBusy(false);
    }
  };
  const sources: SheetAction[] = [
    { label: words.library(), onAction: () => libraryRef.current?.click() },
    ...(words.camera && isMobilePlatform()
      ? [{ label: words.camera(), onAction: () => cameraRef.current?.click() }]
      : []),
    { label: t("From the Studio gallery"), onAction: () => setSheet("gallery") },
  ];
  const Icon = kind === "video" ? IconVideoClip : kind === "audio" ? IconAudio : IconImages1;
  const seconds = chosen?.durationMs ? chosen.durationMs / 1000 : thumbnail?.durationSeconds;

  return (
    <StudioSetting label={label}>
      <button
        type="button"
        className="mobile-app-picture mobile-app-media"
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={() => setSheet("sources")}
      >
        {thumbnail ? (
          <img src={thumbnail.src} alt="" />
        ) : (
          <span className="mobile-app-media-icon" aria-hidden>
            <Icon size={18} />
          </span>
        )}
        <span className="mobile-app-media-text">
          <span className="mobile-app-media-name">
            {busy ? t("Importing…") : chosen ? chosen.prompt || chosen.fileName : words.choose()}
          </span>
          {chosen ? (
            <span className="mobile-app-media-meta">
              {kind !== "image" && seconds ? formatClipLength(seconds) : words.another()}
            </span>
          ) : null}
        </span>
      </button>
      {!chosen && !busy && items.length === 0 ? (
        <p className="mobile-app-media-hint">{words.empty()}</p>
      ) : null}
      {error ? (
        <p className="mobile-dictation-error" role="alert">
          {error}
        </p>
      ) : null}
      <input
        ref={libraryRef}
        type="file"
        accept={acceptFor(kind)}
        hidden
        aria-label={words.library()}
        onChange={(event) => {
          void take(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      {words.camera ? (
        <input
          ref={cameraRef}
          type="file"
          accept={kind === "image" ? "image/*" : "video/*"}
          capture="environment"
          hidden
          aria-label={words.camera()}
          onChange={(event) => {
            void take(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      ) : null}
      {sheet === "sources" ? (
        <ActionSheet
          title={label}
          actions={sources}
          // The sheet closes itself after an action; an action that opened the
          // gallery must not be closed with it.
          onClose={() => setSheet((open) => (open === "sources" ? null : open))}
        />
      ) : null}
      {sheet === "gallery" && kind === "image" ? (
        <GalleryPickerSheet
          onPick={(image) => {
            setSheet(null);
            onPick(image);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "gallery" && kind !== "image" ? (
        <MediaGallerySheet
          title={label}
          kind={kind}
          items={items}
          onPick={(item) => {
            setSheet(null);
            onPick(item);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </StudioSetting>
  );
}

/** The gallery's clips or tracks, each with its poster and length, to pick
 * one from. */
function MediaGallerySheet({
  title,
  kind,
  items,
  onPick,
  onClose,
}: {
  title: string;
  kind: "video" | "audio";
  items: StudioArtifact[];
  onPick: (item: StudioArtifact) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(sheetRef, { onClose });
  return createPortal(
    <div className="mobile-sheet-backdrop">
      <button
        type="button"
        className="mobile-sheet-dismiss"
        aria-label={t("Close")}
        onClick={onClose}
      />
      <div
        className="mobile-sheet mobile-action-sheet mobile-avatar-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <p className="mobile-sheet-title">{title}</p>
        {items.length === 0 ? (
          <p className="mobile-action-sheet-subtitle">
            {kind === "video"
              ? t("Your gallery has no clips yet.")
              : t("Your gallery has no tracks yet.")}
          </p>
        ) : (
          <ul className="mobile-app-media-list">
            {items.map((item) => (
              <li key={item.id}>
                <MediaRow item={item} onPick={() => onPick(item)} />
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="mobile-action-sheet-cancel" onClick={onClose}>
          {t("Cancel")}
        </button>
      </div>
    </div>,
    sheetHost(),
  );
}

function MediaRow({ item, onPick }: { item: StudioArtifact; onPick: () => void }) {
  const thumbnail = useArtifactThumbnail(item);
  const seconds = item.durationMs ? item.durationMs / 1000 : thumbnail?.durationSeconds;
  return (
    <button type="button" className="mobile-app-media-row" onClick={onPick}>
      {thumbnail ? (
        <img src={thumbnail.src} alt="" />
      ) : (
        <span className="mobile-app-media-icon" aria-hidden>
          {item.kind === "video" ? <IconVideoClip size={18} /> : <IconAudio size={18} />}
        </span>
      )}
      <span className="mobile-app-media-text">
        <span className="mobile-app-media-name">{item.prompt || item.fileName}</span>
        {seconds ? (
          <span className="mobile-app-media-meta">{formatClipLength(seconds)}</span>
        ) : null}
      </span>
    </button>
  );
}
