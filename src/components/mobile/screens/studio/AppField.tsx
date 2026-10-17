// One field of an app on the phone (ADR-0119): a step's setting drawn with
// the phone's own controls (a text box, a row whose choices come up as a
// sheet, a switch, a picture from the gallery), so the form reads like the
// rest of the Studio and its inputs never zoom the page.

import { useEffect, useState } from "react";
import { useArtifactThumbnail } from "../../../../lib/artifact-media";
import { t } from "../../../../lib/i18n";
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
import { GalleryPickerSheet } from "../assistants/AssistantReferencesScreen";
import { formatRenderOption, SelectRow, StudioSetting, StudioToggle } from "./StudioControls";

export function AppField({
  shown,
  catalog,
  onMerge,
}: {
  shown: ShownField;
  catalog: MediaCatalog;
  onMerge: (partial: Record<string, unknown>) => void;
}) {
  const { field, node, param } = shown;
  const label = field.label || node.label || `${nodeTypeLabel(node.type)} · ${paramLabel(param)}`;
  const value = node.params[param.name];

  if (param.type === "artifact")
    return (
      <PictureField
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

/** A gallery item for a step that takes one: a picture from the gallery's
 * grid, a clip or a track from its list. */
function PictureField({
  label,
  kind,
  artifactId,
  onPick,
}: {
  label: string;
  kind: "image" | "video" | "audio";
  artifactId: string;
  onPick: (artifact: StudioArtifact) => void;
}) {
  const [items, setItems] = useState<StudioArtifact[]>([]);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const kinds = kind === "audio" ? (["music", "speech", "sfx"] as const) : ([kind] as const);
    Promise.all(kinds.map((entry) => listArtifacts(entry)))
      .then((lists) => setItems(lists.flat()))
      .catch(() => setItems([]));
  }, [kind]);
  const chosen = items.find((item) => item.id === artifactId);
  const thumbnail = useArtifactThumbnail(kind === "image" && chosen ? chosen : null);
  if (kind !== "image")
    return (
      <SelectRow
        label={label}
        value={artifactId}
        options={items.map((item) => item.id)}
        format={(id) => {
          const item = items.find((entry) => entry.id === id);
          return item ? item.prompt || item.fileName : t("Choose");
        }}
        onChange={(id) => {
          const item = items.find((entry) => entry.id === id);
          if (item) onPick(item);
        }}
      />
    );
  return (
    <StudioSetting label={label}>
      <button type="button" className="mobile-app-picture" onClick={() => setPicking(true)}>
        {thumbnail ? <img src={thumbnail.src} alt="" /> : null}
        <span>{chosen ? t("Choose another picture") : t("Choose a picture")}</span>
      </button>
      {picking ? (
        <GalleryPickerSheet
          onPick={(image) => {
            setPicking(false);
            onPick(image);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </StudioSetting>
  );
}
