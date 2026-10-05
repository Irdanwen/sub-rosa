import { useEffect, useState } from "react";
import { friendlyErrorMessage } from "../../lib/errors";
import { intlLocale, t } from "../../lib/i18n";
import {
  BIBLE_KIND_LABELS,
  BIBLE_KINDS,
  BIBLE_ROLE_LABELS,
  ROLES_BY_KIND,
  listBibleEntries,
  type BibleRole,
} from "../../lib/studio/bible";
import { pickPortraitModel, portraitPrompt } from "../../lib/studio/bible/portrait";
import { descriptorFormula, traitLints } from "../../lib/studio/prompt/lint";
import {
  defaultEditModel,
  estimateCostCredits,
  imageEditModels,
  modelsOfType,
} from "../../lib/studio/catalog";
import {
  artifactSrc,
  readArtifactBase64,
  saveArtifactFromBase64,
} from "../../lib/studio/artifacts";
import { cutSheet } from "../../lib/studio/bible/sheet";
import {
  bibleNameInUse,
  referencePromptOf,
  sheetSource,
  uniqueBibleName,
  type ProjectBibleEntry,
} from "../../lib/studio/projects";
import { rewriteTargetModel } from "../../lib/studio/studio-rewrite";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { AiRewrite } from "./AiRewrite";
import { GalleryPicker } from "./GalleryPicker";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";
import { MediaViewer } from "./MediaViewer";
import { Darkroom } from "./Darkroom";
import type { LiveRender } from "../../lib/studio/project-activity";
import { estimateRenderMs } from "../../lib/studio/render-eta";

export function ProjectBible({
  entries,
  onChange,
  artifacts,
  catalog,
  onArtifact,
  onGenerate,
  writingModelId,
  busy,
  live = [],
  now = Date.now(),
  fresh,
  referenceStyle,
}: {
  entries: ProjectBibleEntry[];
  onChange: (entries: ProjectBibleEntry[]) => void;
  artifacts: StudioArtifact[];
  catalog: MediaCatalog;
  onArtifact: (artifactId: string) => void;
  onGenerate: (entryId: string, role: BibleRole) => void;
  /** The text model the AI rewrites write with. The app's when absent. */
  writingModelId?: string;
  busy: boolean;
  /** What is being made right now, for the waits shown where it will land. */
  live?: readonly LiveRender[];
  now?: number;
  /** Files that just arrived, revealed once. */
  fresh?: ReadonlySet<string>;
  /** The film's look, so a reference is drawn the way the shots will be. */
  referenceStyle?: string;
}) {
  const [selected, setSelected] = useState(entries[0]?.id);
  const [global, setGlobal] = useState<ProjectBibleEntry[]>([]);
  const [picker, setPicker] = useState(false);
  const [role, setRole] = useState<BibleRole>("portrait");
  const [nameError, setNameError] = useState("");
  const [nameDraft, setNameDraft] = useState<{ entryId: string; value: string }>();
  const [cutting, setCutting] = useState<string>();
  const [cutError, setCutError] = useState("");
  const [viewing, setViewing] = useState<number>();
  useEffect(() => {
    void listBibleEntries()
      .then(setGlobal)
      .catch(() => undefined);
  }, []);
  const entry = entries.find((item) => item.id === selected) ?? entries[0];
  const waitsOf = (entryId: string | undefined) =>
    live.flatMap((item) =>
      item.target.kind === "bible" && item.target.entryId === entryId
        ? [{ ...item, role: item.target.role }]
        : [],
    );
  const waits = waitsOf(entry?.id);
  // The entry's pictures, in the order the video models read them.
  const viewable = (entry?.refs ?? []).flatMap((ref) => {
    const artifact = artifacts.find((item) => item.id === ref.artifactId);
    return artifact?.kind === "image"
      ? [
          {
            artifact,
            refId: ref.id,
            title: t("{name}: {role}", {
              name: entry?.name ?? "",
              role: BIBLE_ROLE_LABELS[ref.role],
            }),
          },
        ]
      : [];
  });
  const activeRole =
    entry && !ROLES_BY_KIND[entry.kind].includes(role) ? ROLES_BY_KIND[entry.kind][0] : role;
  const models = modelsOfType(catalog, "image");
  // An entry with no model of its own draws with the cheapest, the same one
  // `compileBibleReference` falls back to, so the price is shown from the start.
  const model = entry?.imageModelId
    ? models.find((item) => item.id === entry.imageModelId)
    : pickPortraitModel(catalog);
  // A sheet starts from the portrait when there is one, through an edit model,
  // so the face it repeats nine times is the face already chosen.
  const fromPortrait = entry && activeRole === "sheet" ? sheetSource(entry) : undefined;
  const editModels = imageEditModels(catalog);
  const editModel = fromPortrait
    ? (editModels.find((item) => item.id === entry?.editModelId) ?? defaultEditModel(catalog))
    : undefined;
  const drawingModel = fromPortrait ? editModel : model;
  const cost = drawingModel
    ? estimateCostCredits(drawingModel, { multiplier: catalog.priceMultiplier })
    : undefined;
  const prompt = entry
    ? (referencePromptOf(entry, activeRole) ?? portraitPrompt(entry, activeRole, referenceStyle))
    : "";
  const setPrompt = (value: string) =>
    entry && update({ imagePrompts: { ...entry.imagePrompts, [activeRole]: value } });
  /** Cut the sheet's portrait, profile and outfit out as references of their own. */
  const cutViews = async (sheetArtifactId: string) => {
    const sheet = artifacts.find((item) => item.id === sheetArtifactId);
    if (!entry || !sheet) return;
    setCutting(sheetArtifactId);
    setCutError("");
    try {
      const extension = sheet.fileName.split(".").pop()?.toLowerCase() || "png";
      const mime = extension === "jpg" ? "jpeg" : extension;
      const cuts = await cutSheet(`data:image/${mime};base64,${await readArtifactBase64(sheet)}`);
      const refs = [...entry.refs];
      for (const cut of cuts) {
        const saved = await saveArtifactFromBase64(cut.base64, "png", {
          kind: "image",
          model: sheet.model ?? "",
          prompt: t("{name}, cut from the character sheet", { name: entry.name }),
          sourceArtifactId: sheet.id,
        });
        onArtifact(saved.id);
        refs.push({
          id: crypto.randomUUID(),
          entryId: entry.id,
          artifactId: saved.id,
          role: cut.role,
          label: BIBLE_ROLE_LABELS[cut.role],
          ordinal: refs.length,
        });
      }
      update({ refs });
    } catch (cause) {
      setCutError(friendlyErrorMessage(cause, t("The character sheet could not be read.")));
    } finally {
      setCutting(undefined);
    }
  };
  const update = (patch: Partial<ProjectBibleEntry>) => {
    if (patch.name !== undefined && entry) {
      if (bibleNameInUse(entries, patch.name, entry.id)) {
        setNameError(t("Give each bible entry a different name."));
        return;
      }
      setNameError("");
    }
    if (entry)
      onChange(
        entries.map((item) =>
          item.id === entry.id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item,
        ),
      );
  };
  const add = (source?: ProjectBibleEntry) => {
    const id = crypto.randomUUID();
    const name = uniqueBibleName(entries, source?.name?.trim() || t("New character"));
    const next: ProjectBibleEntry = source
      ? {
          ...structuredClone(source),
          id,
          name,
          originId: source.id,
          refs: source.refs.map((ref) => ({ ...ref, id: crypto.randomUUID(), entryId: id })),
        }
      : {
          id,
          name,
          kind: "character",
          traits: "",
          note: "",
          refs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
    onChange([...entries, next]);
    if (source) {
      for (const artifactId of new Set(next.refs.map((ref) => ref.artifactId)))
        onArtifact(artifactId);
    }
    setSelected(id);
    setNameError("");
    setRole(ROLES_BY_KIND[next.kind][0]);
  };
  return (
    <div className="project-bible">
      <aside className="project-panel">
        <h2>{t("Project bible")}</h2>
        <p className="project-muted">{t("Changes here apply only to this project.")}</p>
        <button type="button" className="btn btn-secondary" onClick={() => add()} disabled={busy}>
          {t("Add an entry")}
        </button>
        <label className="project-field">
          {t("Copy from your library")}
          <select
            value=""
            disabled={busy}
            onChange={(event) => {
              const found = global.find((item) => item.id === event.target.value);
              if (found) add(found);
            }}
          >
            <option value="">{t("Choose an entry")}</option>
            {global.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {entries.map((item) => (
          <button
            type="button"
            key={item.id}
            disabled={busy}
            className="project-list-item"
            aria-pressed={entry?.id === item.id}
            onClick={() => {
              setSelected(item.id);
              setNameDraft(undefined);
              setNameError("");
              setRole(ROLES_BY_KIND[item.kind][0]);
            }}
          >
            <strong>
              {item.name}
              {waitsOf(item.id).length ? (
                <span className="project-live-dot" role="img" aria-label={t("In production")} />
              ) : null}
            </strong>
            <span>{BIBLE_KIND_LABELS[item.kind]}</span>
          </button>
        ))}
      </aside>
      {entry ? (
        <section className="project-panel project-bible-editor">
          <fieldset disabled={busy}>
            <label className="project-field">
              {t("Name")}
              <input
                value={nameDraft?.entryId === entry.id ? nameDraft.value : entry.name}
                aria-invalid={!!nameError}
                onChange={(event) => {
                  const name = event.target.value;
                  setNameDraft({ entryId: entry.id, value: name });
                  if (!name.trim()) {
                    setNameError(t("Give this one a name."));
                    return;
                  }
                  setNameError(
                    bibleNameInUse(entries, name, entry.id)
                      ? t("Give each bible entry a different name.")
                      : "",
                  );
                }}
                onBlur={() => {
                  if (nameDraft?.entryId !== entry.id) return;
                  if (nameDraft.value.trim() && !bibleNameInUse(entries, nameDraft.value, entry.id))
                    update({ name: nameDraft.value.trim() });
                  setNameDraft(undefined);
                }}
              />
            </label>
            {nameError && <p role="alert">{nameError}</p>}
            <label className="project-field">
              {t("Type")}
              <select
                value={entry.kind}
                onChange={(event) => {
                  const kind = event.target.value as ProjectBibleEntry["kind"];
                  update({ kind });
                  setRole(ROLES_BY_KIND[kind][0]);
                }}
              >
                {BIBLE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {BIBLE_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="project-field">
              {t("Invariant traits")}
              <textarea
                aria-label={t("Invariant traits")}
                maxLength={600}
                rows={4}
                value={entry.traits}
                placeholder={descriptorFormula(entry.kind)}
                onChange={(event) => update({ traits: event.target.value })}
              />
              <span className="project-field-hint">
                {t("Pasted unchanged into every shot this entry appears in. {count} words.", {
                  count: entry.traits.trim().split(/\s+/).filter(Boolean).length,
                })}
              </span>
              {traitLints(entry).map((lint) => (
                <span key={lint.id} className="project-field-hint project-lint">
                  {lint.message}
                </span>
              ))}
            </label>
            <label className="project-field">
              {t("Private notes")}
              <textarea
                aria-label={t("Private notes")}
                value={entry.note}
                onChange={(event) => update({ note: event.target.value })}
              />
            </label>
            <h3>{t("Reference images")}</h3>
            <div className="project-reference-grid">
              {entry.refs.map((ref, index) => {
                const artifact = artifacts.find((item) => item.id === ref.artifactId);
                return (
                  <div key={ref.id} className="project-reference">
                    {artifact?.kind === "image" ? (
                      <button
                        type="button"
                        className="project-reference-open"
                        aria-label={t("Enlarge {name}", {
                          name: BIBLE_ROLE_LABELS[ref.role],
                        })}
                        onClick={() =>
                          setViewing(viewable.findIndex((item) => item.refId === ref.id))
                        }
                      >
                        <img
                          className={fresh?.has(artifact.id) ? "project-reveal" : undefined}
                          src={artifactSrc(artifact)}
                          alt={ref.label}
                        />
                      </button>
                    ) : artifact ? (
                      // biome-ignore lint/a11y/useMediaCaption: voice references have no caption track
                      <audio
                        controls
                        preload="none"
                        src={artifactSrc(artifact)}
                        aria-label={t("Preview {name}", { name: ref.label || artifact.fileName })}
                      />
                    ) : (
                      <span>{t("Missing file")}</span>
                    )}
                    <span>{BIBLE_ROLE_LABELS[ref.role]}</span>
                    {ref.role === "sheet" && artifact?.kind === "image" ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy || cutting !== undefined}
                        onClick={() => void cutViews(ref.artifactId)}
                      >
                        {cutting === ref.artifactId
                          ? t("Cutting...")
                          : t("Cut out the portrait, profile and outfit")}
                      </button>
                    ) : null}
                    <div className="project-actions">
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => {
                          const refs = [...entry.refs];
                          [refs[index - 1], refs[index]] = [refs[index], refs[index - 1]];
                          update({ refs: refs.map((item, ordinal) => ({ ...item, ordinal })) });
                        }}
                      >
                        {t("Move up")}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          update({
                            refs: entry.refs
                              .filter((item) => item.id !== ref.id)
                              .map((item, ordinal) => ({ ...item, ordinal })),
                          })
                        }
                      >
                        {t("Remove")}
                      </button>
                    </div>
                  </div>
                );
              })}
              {waits.map((wait) => (
                <div key={wait.nodeId} className="project-reference project-reference-developing">
                  <Darkroom
                    compact
                    seed={`${entry.id}${wait.role}`}
                    phase={wait.phase}
                    elapsedMs={now - wait.startedAt}
                    estimateMs={estimateRenderMs(wait.etaKey)}
                    progress={wait.progress}
                    aspectRatio={wait.aspectRatio ?? "1:1"}
                    label={wait.phase === "queued" ? undefined : t("Drawing")}
                  />
                  <span>{BIBLE_ROLE_LABELS[wait.role]}</span>
                </div>
              ))}
            </div>
            <label className="project-field">
              {t("Reference role")}
              <select
                value={activeRole}
                onChange={(event) => setRole(event.target.value as BibleRole)}
              >
                {ROLES_BY_KIND[entry.kind].map((item) => (
                  <option key={item} value={item}>
                    {BIBLE_ROLE_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-secondary" onClick={() => setPicker(true)}>
              {t("From gallery")}
            </button>
            {cutError ? (
              <p role="alert" className="project-error">
                {cutError}
              </p>
            ) : null}
            {activeRole !== "voice" ? (
              <>
                {activeRole === "sheet" ? (
                  <p className="project-muted">
                    {fromPortrait
                      ? t(
                          "Drawn from this entry's portrait, so the face stays the same. It composes opening images and gives you a portrait and a profile to cut out. It is never sent to a video model.",
                        )
                      : t(
                          "Add or generate a portrait first to keep the same face. Without one, the sheet is drawn from the text.",
                        )}
                  </p>
                ) : null}
                {fromPortrait ? (
                  <MediaModelPicker
                    value={editModel?.id ?? ""}
                    options={editModels.map(mediaModelOption)}
                    onChange={(editModelId) => update({ editModelId })}
                    ariaLabel={t("Character sheet model")}
                  />
                ) : (
                  <MediaModelPicker
                    value={entry.imageModelId || model?.id || ""}
                    options={models.map(mediaModelOption)}
                    onChange={(imageModelId) => update({ imageModelId })}
                    ariaLabel={t("Reference image model")}
                  />
                )}
                <div className="project-field">
                  <span className="project-field-heading">{t("Image prompt")}</span>
                  <AiRewrite
                    label={t("Image prompt")}
                    value={prompt}
                    disabled={busy}
                    field={
                      <textarea
                        aria-label={t("Image prompt")}
                        rows={4}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                      />
                    }
                    onAccept={setPrompt}
                    hint={t("Written in English, the language these image models follow best.")}
                    request={() =>
                      entry.name.trim()
                        ? {
                            kind: "imagePrompt",
                            text: prompt,
                            modelId: writingModelId,
                            context: {
                              targetModel: rewriteTargetModel(drawingModel),
                              entry: { name: entry.name, kind: entry.kind, traits: entry.traits },
                              role: activeRole,
                            },
                          }
                        : undefined
                    }
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={cost === undefined}
                  onClick={() => onGenerate(entry.id, activeRole)}
                >
                  {cost === undefined
                    ? t("Price unavailable")
                    : t("Generate reference · {credits} credits", {
                        credits: cost.toLocaleString(intlLocale(), { maximumFractionDigits: 2 }),
                      })}
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onChange(entries.filter((item) => item.id !== entry.id))}
            >
              {t("Remove from project")}
            </button>
          </fieldset>
          {busy && !waits.length ? <p role="status">{t("Generating reference...")}</p> : null}
        </section>
      ) : (
        <div className="project-empty">
          <h2>{t("Give your film a consistent cast")}</h2>
          <p>
            {t(
              "Add characters, locations, props and a visual style, or copy them from your library.",
            )}
          </p>
        </div>
      )}
      {viewing !== undefined && viewable[viewing] ? (
        <MediaViewer
          items={viewable}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(undefined)}
        />
      ) : null}
      {picker && entry ? (
        <GalleryPicker
          title={
            activeRole === "voice" ? t("Choose a voice reference") : t("Choose an image reference")
          }
          description={
            activeRole === "voice"
              ? t("Pick speech you have already produced.")
              : t("Pick an image you have already produced.")
          }
          kinds={activeRole === "voice" ? ["speech"] : ["image"]}
          resolveData={false}
          onClose={() => setPicker(false)}
          onPick={(_, artifact) => {
            if (entry.refs.some((ref) => ref.artifactId === artifact.id && ref.role === activeRole))
              return;
            onArtifact(artifact.id);
            update({
              refs: [
                ...entry.refs,
                {
                  id: crypto.randomUUID(),
                  entryId: entry.id,
                  artifactId: artifact.id,
                  role: activeRole,
                  label: artifact.fileName,
                  ordinal: entry.refs.length,
                },
              ],
            });
          }}
        />
      ) : null}
    </div>
  );
}
