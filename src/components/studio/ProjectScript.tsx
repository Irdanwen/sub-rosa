import { type ReactNode, useId } from "react";
import { t } from "../../lib/i18n";
import { musicModels, modelsOfType } from "../../lib/studio/catalog";
import type { ProjectDocument, StudioProject } from "../../lib/studio/projects";
import type { MediaCatalog } from "../../lib/studio/types";
import type { VeniceModelDto } from "../../lib/tauri";
import { Switch } from "../ui/Switch";
import { AiRewrite } from "./AiRewrite";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";
import { ProjectDirection } from "./ProjectDirection";

/** A labelled model choice that can always go back to the app's own pick. */
export function ModelField({
  label,
  automatic,
  value,
  children,
  onReset,
}: {
  label: string;
  /** What the app picks when nothing is chosen, said in the reset link. */
  automatic: string;
  value: string;
  children: ReactNode;
  onReset: () => void;
}) {
  return (
    <div className="project-field">
      <span className="project-field-heading">
        {label}
        {value ? (
          <button type="button" className="project-field-reset" onClick={onReset}>
            {t("Use automatic")}
          </button>
        ) : null}
      </span>
      {children}
      {value ? null : <span className="project-field-hint">{automatic}</span>}
    </div>
  );
}

export function ProjectScript({
  project,
  catalog,
  busy,
  reading,
  writingModelId,
  readingModels,
  defaultReadingModel,
  readingModelsError,
  onRetryModels,
  editDocument,
  onPickNotes,
  onRead,
}: {
  project: StudioProject;
  catalog: MediaCatalog;
  busy: boolean;
  reading: boolean;
  writingModelId?: string;
  readingModels: VeniceModelDto[];
  defaultReadingModel: string;
  readingModelsError: boolean;
  onRetryModels: () => void;
  editDocument: (change: (previous: ProjectDocument) => ProjectDocument) => void;
  onPickNotes: () => void;
  onRead: () => void;
}) {
  const scoreSwitch = useId();
  const { document } = project;
  const settings = document.settings;
  const setSettings = (patch: Partial<ProjectDocument["settings"]>) =>
    editDocument((previous) => ({ ...previous, settings: { ...previous.settings, ...patch } }));
  const entries = document.bible.map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    traits: entry.traits,
  }));
  return (
    <div className="project-script">
      <section className="project-panel">
        <h2>{t("Script")}</h2>
        <AiRewrite
          label={t("Script")}
          value={document.script}
          disabled={busy || reading}
          onAccept={(script) => editDocument((previous) => ({ ...previous, script }))}
          field={
            <textarea
              aria-label={t("Film script")}
              rows={18}
              value={document.script}
              disabled={busy || reading}
              onChange={(event) =>
                editDocument((previous) => ({ ...previous, script: event.target.value }))
              }
              placeholder={t("Describe your film, its characters and what happens.")}
            />
          }
          intents={[
            { value: "filmable", label: t("Make it filmable") },
            { value: "develop", label: t("Develop an idea") },
            { value: "tighten", label: t("Tighten") },
            { value: "custom", label: t("Your own instruction") },
          ]}
          hint={t(
            "Scenes, visible actions and the same names throughout: that is what Break into shots reads best.",
          )}
          request={(intent, instruction) => {
            // An empty scenario is developed from the sentence typed in its
            // place: that sentence is the material, not an instruction.
            const idea =
              !document.script.trim() && intent === "develop" ? instruction?.trim() : undefined;
            if (!document.script.trim() && !idea) return undefined;
            return {
              kind: "scenario",
              text: idea ?? document.script,
              intent,
              instruction: idea ? undefined : instruction,
              modelId: writingModelId,
              context: { aspectRatio: settings.aspectRatio, entries },
            };
          }}
        />
        <div className="project-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || reading}
            onClick={onPickNotes}
          >
            {t("From your notes")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || reading || !document.script.trim() || document.shots.length > 0}
            onClick={onRead}
          >
            {reading ? t("Reading your script...") : t("Break into shots")}
          </button>
        </div>
        {document.readingNoteId && !reading ? (
          <p className="project-muted">
            {t(
              "Your script and completed reading steps are saved. You can try again with another model.",
            )}
          </p>
        ) : null}
        {document.shots.length ? (
          <p className="project-muted">
            {t("Your shot list is editable in Shots. Script changes do not overwrite your work.")}
          </p>
        ) : null}
      </section>
      <aside className="project-panel project-settings">
        <h2>{t("Project settings")}</h2>
        <section aria-labelledby={`${scoreSwitch}-writing`}>
          <h3 id={`${scoreSwitch}-writing`}>{t("Story")}</h3>
          <label className="project-field">
            {t("Script breakdown model")}
            <select
              value={settings.readingModelId ?? ""}
              disabled={reading || busy}
              onChange={(event) => setSettings({ readingModelId: event.target.value })}
            >
              <option value="">
                {t("App text model: {model}", { model: defaultReadingModel || t("Default") })}
              </option>
              {settings.readingModelId &&
              !readingModels.some((model) => model.id === settings.readingModelId) ? (
                <option value={settings.readingModelId}>
                  {t("Unavailable model: {model}", { model: settings.readingModelId })}
                </option>
              ) : null}
              {readingModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          {readingModelsError ? (
            <button type="button" className="btn btn-ghost" onClick={onRetryModels}>
              {t("Retry loading text models")}
            </button>
          ) : null}
        </section>
        <ProjectDirection document={document} editDocument={editDocument} />
        <section aria-labelledby={`${scoreSwitch}-picture`}>
          <h3 id={`${scoreSwitch}-picture`}>{t("Picture")}</h3>
          <label className="project-field">
            {t("Aspect ratio")}
            <select
              value={settings.aspectRatio}
              onChange={(event) => setSettings({ aspectRatio: event.target.value })}
            >
              {["16:9", "9:16", "1:1", "4:3", "21:9"].map((ratio) => (
                <option key={ratio}>{ratio}</option>
              ))}
            </select>
          </label>
          <ModelField
            label={t("Default video model")}
            automatic={t("The least expensive model that fits each shot.")}
            value={settings.videoModelId}
            onReset={() => setSettings({ videoModelId: "" })}
          >
            <MediaModelPicker
              value={settings.videoModelId}
              options={catalog.models
                .filter(
                  (model) =>
                    !model.offline &&
                    ["video", "imageToVideo", "referenceToVideo"].includes(model.mediaType),
                )
                .map(mediaModelOption)}
              ariaLabel={t("Default video model")}
              placeholder={t("Automatic")}
              onChange={(videoModelId) => setSettings({ videoModelId })}
            />
          </ModelField>
        </section>
        <section aria-labelledby={`${scoreSwitch}-sound`}>
          <h3 id={`${scoreSwitch}-sound`}>{t("Sound")}</h3>
          <ModelField
            label={t("Dialogue model")}
            automatic={t("The model with the most voices.")}
            value={settings.ttsModelId}
            onReset={() => setSettings({ ttsModelId: "" })}
          >
            <MediaModelPicker
              value={settings.ttsModelId}
              options={modelsOfType(catalog, "tts").map(mediaModelOption)}
              ariaLabel={t("Dialogue model")}
              placeholder={t("Automatic")}
              onChange={(ttsModelId) => setSettings({ ttsModelId })}
            />
          </ModelField>
          <div className="project-field project-field-inline">
            <span id={scoreSwitch}>{t("Generate a musical score")}</span>
            <Switch
              aria-labelledby={scoreSwitch}
              checked={settings.withScore}
              onCheckedChange={(withScore) => setSettings({ withScore })}
            />
          </div>
          {settings.withScore ? (
            <ModelField
              label={t("Music model")}
              automatic={t("The model that writes the longest pieces.")}
              value={settings.musicModelId}
              onReset={() => setSettings({ musicModelId: "" })}
            >
              <MediaModelPicker
                value={settings.musicModelId}
                options={musicModels(catalog).map(mediaModelOption)}
                ariaLabel={t("Music model")}
                placeholder={t("Automatic")}
                onChange={(musicModelId) => setSettings({ musicModelId })}
              />
            </ModelField>
          ) : null}
        </section>
        <section aria-labelledby={`${scoreSwitch}-budget`}>
          <h3 id={`${scoreSwitch}-budget`}>{t("Budget")}</h3>
          <label className="project-field">
            {t("Spend ceiling")}
            <input
              type="number"
              min={0}
              value={settings.budget}
              onChange={(event) => {
                const budget = Number(event.target.value);
                if (Number.isFinite(budget)) setSettings({ budget });
              }}
            />
          </label>
        </section>
      </aside>
    </div>
  );
}
