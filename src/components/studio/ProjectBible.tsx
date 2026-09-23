import { useEffect, useState } from "react";
import { intlLocale, t } from "../../lib/i18n";
import {
  BIBLE_KIND_LABELS,
  BIBLE_KINDS,
  BIBLE_ROLE_LABELS,
  ROLES_BY_KIND,
  listBibleEntries,
  type BibleRole,
} from "../../lib/studio/bible";
import { portraitPrompt } from "../../lib/studio/bible/portrait";
import { estimateCostCredits, modelsOfType } from "../../lib/studio/catalog";
import { artifactSrc } from "../../lib/studio/artifacts";
import type { ProjectBibleEntry } from "../../lib/studio/projects";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { GalleryPicker } from "./GalleryPicker";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";

export function ProjectBible({
  entries,
  onChange,
  artifacts,
  catalog,
  onArtifact,
  onGenerate,
  busy,
}: {
  entries: ProjectBibleEntry[];
  onChange: (entries: ProjectBibleEntry[]) => void;
  artifacts: StudioArtifact[];
  catalog: MediaCatalog;
  onArtifact: (artifactId: string) => void;
  onGenerate: (entryId: string, role: BibleRole) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState(entries[0]?.id);
  const [global, setGlobal] = useState<ProjectBibleEntry[]>([]);
  const [picker, setPicker] = useState(false);
  const [role, setRole] = useState<BibleRole>("portrait");
  useEffect(() => {
    void listBibleEntries()
      .then(setGlobal)
      .catch(() => undefined);
  }, []);
  const entry = entries.find((item) => item.id === selected) ?? entries[0];
  const activeRole =
    entry && !ROLES_BY_KIND[entry.kind].includes(role) ? ROLES_BY_KIND[entry.kind][0] : role;
  const models = modelsOfType(catalog, "image");
  const model = models.find((item) => item.id === entry?.imageModelId);
  const cost = model
    ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier })
    : undefined;
  const update = (patch: Partial<ProjectBibleEntry>) => {
    if (entry)
      onChange(
        entries.map((item) =>
          item.id === entry.id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item,
        ),
      );
  };
  const add = (source?: ProjectBibleEntry) => {
    const id = crypto.randomUUID();
    const next: ProjectBibleEntry = source
      ? {
          ...structuredClone(source),
          id,
          originId: source.id,
          refs: source.refs.map((ref) => ({ ...ref, id: crypto.randomUUID(), entryId: id })),
        }
      : {
          id,
          name: t("New character"),
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
              setRole(ROLES_BY_KIND[item.kind][0]);
            }}
          >
            <strong>{item.name}</strong>
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
                value={entry.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </label>
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
                rows={3}
                value={entry.traits}
                onChange={(event) => update({ traits: event.target.value })}
              />
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
                      <img src={artifactSrc(artifact)} alt={ref.label} />
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
            {activeRole !== "voice" ? (
              <>
                <MediaModelPicker
                  value={entry.imageModelId ?? ""}
                  options={models.map(mediaModelOption)}
                  onChange={(imageModelId) => update({ imageModelId })}
                  ariaLabel={t("Reference image model")}
                />
                <label className="project-field">
                  {t("Image prompt")}
                  <textarea
                    aria-label={t("Image prompt")}
                    rows={4}
                    value={entry.imagePrompt ?? portraitPrompt(entry, activeRole)}
                    onChange={(event) => update({ imagePrompt: event.target.value })}
                  />
                </label>
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
          {busy ? <p role="status">{t("Generating reference...")}</p> : null}
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
