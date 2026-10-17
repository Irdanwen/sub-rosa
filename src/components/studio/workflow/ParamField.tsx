// One setting of a node, drawn from its declarative schema: model and option
// pickers, prompts, switches, numbers, gallery and note pickers.

import { keyed } from "../../../lib/keyed";
import { t } from "../../../lib/i18n";
import { useMemo, useRef, useState } from "react";
import type { ArtifactKind, MediaCatalog } from "../../../lib/studio/types";
import { IconConnectors1 } from "central-icons/IconConnectors1";
import {
  canFeedParam,
  FED_PARAMS_KEY,
  fedParams,
  MAX_LIST_ITEMS,
} from "../../../lib/studio/workflow/schema";
import {
  effectiveParamValue,
  INPUT_MARKER,
  modelParamPatch,
  modelsForParam,
  nodeSchema,
  paramOptions,
  type ParamSchema,
  type WorkflowNode,
} from "../../../lib/studio/workflow";
import { Switch } from "../../ui/Switch";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { pictureItems } from "../../../lib/studio/workflow/lists";
import { enumLabel, paramLabel } from "../../../lib/studio/workflow/labels";
import { AssetPreview } from "../AssetPreview";
import { GalleryPicker } from "../GalleryPicker";
import { NotePicker } from "../NotePicker";
import { type ArtifactIndex, stringOr } from "./flow";
import { ZonePicker } from "./ZonePicker";

/** Gallery buckets an asset node's picker should offer for its chosen kind. */
function assetPickerKinds(node: WorkflowNode): ArtifactKind[] {
  const kind = node.params.assetKind;
  if (kind === "video") return ["video"];
  if (kind === "audio") return ["music", "speech", "sfx"];
  return ["image"];
}

export function ParamControl({
  node,
  param,
  catalog,
  artifacts,
  textSources,
  constraintEpoch,
  onMerge,
  zoneSource,
}: {
  node: WorkflowNode;
  param: ParamSchema;
  catalog: MediaCatalog;
  artifacts: ArtifactIndex;
  /** The nodes feeding this node's text input, named. Empty when nothing is
   * wired to it, which is when `{{input}}` means nothing. */
  textSources: string[];
  /** Bumped when a rejection taught us a model's options, so they re-derive. */
  constraintEpoch: number;
  onMerge: (partial: Record<string, unknown>) => void;
  /** Zone settings only: the picture the zone is drawn on. */
  zoneSource?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The prompt field, so the marker lands at the caret rather than the end. */
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const value = node.params[param.name];
  const label = paramLabel(param);
  const schema = nodeSchema(node.type);
  const modelId = typeof node.params.model === "string" ? node.params.model : "";
  const options = useMemo(
    () => paramOptions(param, node.params, catalog),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the options
    // depend on the model and on what a rejection has taught us since, which
    // the epoch stands for; re-deriving on every params change would run a
    // localStorage read per keystroke.
    [param, modelId, catalog, constraintEpoch],
  );
  if (param.type === "zone") {
    return (
      <ZonePicker
        value={value}
        source={zoneSource}
        label={label}
        onChange={(zone) => onMerge({ [param.name]: zone })}
      />
    );
  }
  if (param.type === "model") {
    const models = modelsForParam(catalog, param);
    return (
      <select
        className="studio-native-select nodrag"
        value={typeof value === "string" ? value : ""}
        aria-label={label}
        onChange={(event) =>
          onMerge(
            modelParamPatch(
              schema,
              node.params,
              param,
              models.find((model) => model.id === event.target.value),
            ),
          )
        }
      >
        <option value="">{t("Choose a model")}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    );
  }
  if (param.modelOptions && options.length > 0) {
    // The value shown is the one that will be sent: the request builder picks
    // the first option when the stored one is not on offer, and an editor that
    // showed something else would be lying about the render.
    return (
      <select
        className="studio-native-select nodrag"
        value={effectiveParamValue(options, value)}
        aria-label={label}
        onChange={(event) => onMerge({ [param.name]: event.target.value })}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {enumLabel(param.name, option)}
          </option>
        ))}
      </select>
    );
  }
  if (param.type === "artifact") {
    const label = stringOr(node.params.assetLabel, "");
    const artifactId = stringOr(node.params[param.name], "");
    return (
      <>
        {artifactId ? (
          <AssetPreview
            artifact={artifacts.byId.get(artifactId)}
            loaded={artifacts.loaded}
            className="studio-node-asset"
          />
        ) : null}
        <button
          type="button"
          className="studio-node-picker nodrag"
          onClick={() => setPickerOpen(true)}
        >
          {label || t("Choose from the gallery")}
        </button>
        {pickerOpen ? (
          <GalleryPicker
            kinds={assetPickerKinds(node)}
            resolveData={false}
            title={t("Pick an asset")}
            description={t("This item feeds every node the asset connects to.")}
            onPick={(_, artifact) => {
              // Filed straight into the index: the preview appears with the
              // pick rather than after the next gallery listing.
              artifacts.remember(artifact);
              onMerge({
                [param.name]: artifact.id,
                assetLabel: artifact.prompt || artifact.fileName,
              });
            }}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </>
    );
  }
  if (param.type === "artifacts") {
    const chosen = pictureItems(node.params[param.name]);
    const full = chosen.length >= MAX_LIST_ITEMS;
    return (
      <div className="studio-node-list-picks">
        {chosen.length > 0 ? (
          <ul>
            {keyed(chosen, (artifactId) => artifactId).map(({ key, value: artifactId }, index) => (
              <li key={key}>
                <AssetPreview
                  artifact={artifacts.byId.get(artifactId)}
                  loaded={artifacts.loaded}
                  className="studio-node-asset"
                />
                <button
                  type="button"
                  className="studio-icon-button nodrag"
                  aria-label={t("Remove picture {number}", { number: index + 1 })}
                  onClick={() => onMerge({ [param.name]: chosen.filter((_, at) => at !== index) })}
                >
                  <IconCrossSmall size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <button
          type="button"
          className="studio-node-picker nodrag"
          disabled={full}
          onClick={() => setPickerOpen(true)}
        >
          {full
            ? t("A list holds {count} pictures at most.", { count: MAX_LIST_ITEMS })
            : t("Add a picture from the gallery")}
        </button>
        {pickerOpen ? (
          <GalleryPicker
            kinds={["image"]}
            resolveData={false}
            title={t("Add a picture")}
            description={t("Each step this list feeds runs once per picture.")}
            onPick={(_, artifact) => {
              artifacts.remember(artifact);
              onMerge({ [param.name]: [...chosen, artifact.id] });
            }}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
    );
  }
  if (param.type === "note") {
    const label = stringOr(node.params.noteTitle, "");
    return (
      <>
        <button
          type="button"
          className="studio-node-picker nodrag"
          onClick={() => setPickerOpen(true)}
        >
          {label || t("Choose a note")}
        </button>
        {pickerOpen ? (
          <NotePicker
            onPick={(note) =>
              onMerge({ [param.name]: note.id, noteTitle: note.title || "Untitled note" })
            }
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </>
    );
  }
  if (param.type === "text") {
    const text = typeof value === "string" ? value : "";
    // Only where the marker means something: a node nothing upstream feeds has
    // no input to place. Where it does, the engine appends that text after the
    // prompt unless the marker says otherwise, so this is about *placing* it,
    // which the tooltip says rather than leaving to be discovered.
    const offerMarker = param.acceptsInputMarker === true && textSources.length > 0;
    const placed = text.includes(INPUT_MARKER);
    return (
      <div className="studio-node-prompt">
        <textarea
          ref={promptRef}
          className="studio-textarea nodrag nowheel"
          rows={2}
          value={text}
          placeholder={label}
          aria-label={label}
          onChange={(event) => onMerge({ [param.name]: event.target.value })}
        />
        {offerMarker ? (
          <button
            type="button"
            className="btn btn-secondary studio-marker-button nodrag"
            disabled={placed}
            title={
              placed
                ? t("This prompt already says where its upstream text goes.")
                : textSources.length === 1
                  ? t(
                      'Puts the text from "{name}" here. Without the marker it is added after the prompt.',
                      { name: textSources[0] },
                    )
                  : t(
                      "Puts the text from the {count} connected inputs here. Without the marker it is added after the prompt.",
                      { count: textSources.length },
                    )
            }
            // Keeps the caret: the insertion point is wherever the user last
            // was in the prompt, and a button that stole focus would lose it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const field = promptRef.current;
              const from = field?.selectionStart ?? text.length;
              const to = field?.selectionEnd ?? from;
              const next = `${text.slice(0, from)}${INPUT_MARKER}${text.slice(to)}`;
              onMerge({ [param.name]: next });
              const caret = from + INPUT_MARKER.length;
              requestAnimationFrame(() => {
                field?.focus();
                field?.setSelectionRange(caret, caret);
              });
            }}
          >
            {t("Insert {INPUT_MARKER}", { INPUT_MARKER })}
          </button>
        ) : null}
      </div>
    );
  }
  if (param.type === "boolean") {
    return (
      <div className="studio-node-switch nodrag">
        <span className="studio-node-kind">{label}</span>
        <Switch
          checked={value === true}
          onCheckedChange={(checked) => onMerge({ [param.name]: checked })}
          aria-label={label}
        />
      </div>
    );
  }
  if (param.type === "enum") {
    return (
      <select
        className="studio-native-select nodrag"
        value={typeof value === "string" ? value : String(param.default ?? "")}
        aria-label={label}
        onChange={(event) => {
          // Switching an asset's kind invalidates the picked item.
          if (node.type === "asset" && param.name === "assetKind") {
            onMerge({ assetKind: event.target.value, artifactId: "", assetLabel: "" });
            return;
          }
          onMerge({ [param.name]: event.target.value });
        }}
      >
        {(param.enumValues ?? []).map((option) => (
          <option key={option} value={option}>
            {enumLabel(param.name, option)}
          </option>
        ))}
      </select>
    );
  }
  if (param.type === "number") {
    return (
      <input
        className="studio-input nodrag"
        type="number"
        min={param.min}
        max={param.max}
        step={param.step}
        value={typeof value === "number" ? value : ""}
        placeholder={label}
        aria-label={label}
        onChange={(event) =>
          onMerge({
            [param.name]: event.target.value === "" ? undefined : Number(event.target.value),
          })
        }
      />
    );
  }
  return (
    <input
      className="studio-input nodrag"
      value={typeof value === "string" ? value : ""}
      placeholder={label}
      aria-label={label}
      onChange={(event) => onMerge({ [param.name]: event.target.value })}
    />
  );
}

type ParamFieldProps = Parameters<typeof ParamControl>[0];

/** Steps whose settings are never taken from a connection. */
const UNFED_STEPS = new Set(["textInput", "note", "textList", "imageList", "splitText"]);

/** A setting, with the choice to take it from a connection instead (words
 * and closed choices only, see `canFeedParam`). Taken from one, the field
 * gives way to a note saying so, and the step grows the input it arrives on. */
export function ParamField(props: ParamFieldProps) {
  const { node, param, onMerge } = props;
  // A text input's words are the source itself; a note never runs; a
  // list's items are counted before the run (a split text takes them from
  // a connection instead).
  const feedable = canFeedParam(param) && !UNFED_STEPS.has(node.type);
  if (!feedable) return <ParamControl {...props} />;
  const fed = fedParams(node.params);
  const isFed = fed.includes(param.name);
  const toggle = () =>
    onMerge({
      [FED_PARAMS_KEY]: isFed ? fed.filter((name) => name !== param.name) : [...fed, param.name],
    });
  const label = paramLabel(param);
  return (
    <div className="studio-param-feedable">
      {isFed ? (
        <p className="studio-param-fed">
          {t("{setting}: from its connection", { setting: label })}
        </p>
      ) : (
        <ParamControl {...props} />
      )}
      <button
        type="button"
        className="studio-icon-button nodrag"
        aria-pressed={isFed}
        aria-label={
          isFed
            ? t("Set {setting} here again", { setting: label })
            : t("Take {setting} from a connection", { setting: label })
        }
        title={
          isFed
            ? t("Set {setting} here again", { setting: label })
            : t("Take {setting} from a connection", { setting: label })
        }
        onClick={toggle}
      >
        <IconConnectors1 size={14} />
      </button>
    </div>
  );
}
