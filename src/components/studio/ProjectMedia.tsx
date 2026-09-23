import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { artifactSrc, exportArtifact } from "../../lib/studio/artifacts";
import type { StudioArtifact } from "../../lib/studio/types";
import { projectError, type ProjectSummary } from "../../lib/studio/projects";

export function ProjectMedia({
  artifacts,
  projects,
  projectId,
  onMetadata,
  onAttach,
}: {
  artifacts: StudioArtifact[];
  projects: ProjectSummary[];
  projectId?: string;
  onMetadata: (artifact: StudioArtifact, title: string, projectIds: string[]) => Promise<void>;
  onAttach?: (artifact: StudioArtifact) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [all, setAll] = useState(!projectId);
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string; title: string }>();
  const renameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing?.id) renameInput.current?.focus();
  }, [editing?.id]);
  const visible = artifacts.filter(
    (artifact) =>
      (all || artifact.projectIds?.includes(projectId ?? "")) &&
      (!kind || artifact.kind === kind) &&
      `${artifact.title ?? ""} ${artifact.fileName} ${artifact.prompt} ${artifact.model}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const preview = artifacts.find((artifact) => artifact.id === selected);
  const save = async (artifact: StudioArtifact, title: string, projectIds: string[]) => {
    setError("");
    setSaving(true);
    try {
      await onMetadata(artifact, title, projectIds);
      setEditing(undefined);
      return true;
    } catch (cause) {
      setError(projectError(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="project-media">
      <div className="project-actions">
        <input
          className="studio-input"
          aria-label={t("Search media")}
          placeholder={t("Search media")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label={t("Media type")}
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="">{t("All media")}</option>
          <option value="video">{t("Video")}</option>
          <option value="image">{t("Image")}</option>
          <option value="speech">{t("Dialogue")}</option>
          <option value="music">{t("Music")}</option>
          <option value="sfx">{t("Sound effects")}</option>
        </select>
        {projectId ? (
          <label>
            <input
              type="checkbox"
              checked={all}
              onChange={(event) => setAll(event.target.checked)}
            />
            {t("Show all projects")}
          </label>
        ) : null}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setLayout(layout === "grid" ? "list" : "grid")}
        >
          {layout === "grid" ? t("List view") : t("Grid view")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="project-error">
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="project-media-preview">
          <button type="button" className="btn btn-ghost" onClick={() => setSelected(undefined)}>
            {t("Close preview")}
          </button>
          {preview.kind === "image" ? (
            <img src={artifactSrc(preview)} alt={preview.title || preview.prompt} />
          ) : preview.kind === "video" ? (
            // biome-ignore lint/a11y/useMediaCaption: generated gallery videos have no caption track
            <video controls autoPlay src={artifactSrc(preview)} />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: generated gallery audio has no caption track
            <audio
              controls
              src={artifactSrc(preview)}
              aria-label={t("Preview {name}", { name: preview.title || preview.fileName })}
            />
          )}
        </div>
      ) : null}
      {visible.length ? (
        <div className={`project-media-${layout}`}>
          {visible.map((artifact) => (
            <article className="project-media-card" key={artifact.id}>
              <button
                type="button"
                className="project-media-thumb"
                onClick={() => setSelected(artifact.id)}
                aria-label={t("Preview {name}", { name: artifact.title || artifact.fileName })}
              >
                {artifact.kind === "image" ? (
                  <img src={artifactSrc(artifact)} alt="" loading="lazy" />
                ) : artifact.kind === "video" ? (
                  <video src={artifactSrc(artifact)} preload="metadata" muted />
                ) : (
                  <span>{t("Audio")}</span>
                )}
              </button>
              <div className="project-media-caption">
                {editing?.id === artifact.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save(artifact, editing.title, artifact.projectIds ?? []);
                    }}
                  >
                    <input
                      ref={renameInput}
                      maxLength={500}
                      disabled={saving}
                      aria-label={t("Media name")}
                      value={editing.title}
                      onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                    />
                    <button type="submit" disabled={saving}>
                      {saving ? t("Saving...") : t("Save")}
                    </button>
                    <button type="button" onClick={() => setEditing(undefined)}>
                      {t("Cancel")}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="project-media-name"
                    disabled={saving}
                    title={t("Rename")}
                    onClick={() =>
                      setEditing({ id: artifact.id, title: artifact.title || artifact.fileName })
                    }
                  >
                    {artifact.title || artifact.fileName}
                  </button>
                )}
                <small>{artifact.model || t("Model unavailable")}</small>
                <div className="project-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      void exportArtifact(artifact).catch((cause) => setError(projectError(cause)))
                    }
                  >
                    {t("Export")}
                  </button>
                  {projectId ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={saving}
                      onClick={async () => {
                        const member = artifact.projectIds?.includes(projectId);
                        const saved = await save(
                          artifact,
                          artifact.title ?? "",
                          member
                            ? (artifact.projectIds ?? []).filter((id) => id !== projectId)
                            : [...(artifact.projectIds ?? []), projectId],
                        );
                        if (saved && !member) onAttach?.(artifact);
                      }}
                    >
                      {artifact.projectIds?.includes(projectId)
                        ? t("Remove from project")
                        : t("Add to project")}
                    </button>
                  ) : (
                    <select
                      disabled={saving}
                      aria-label={t("Add to project")}
                      value=""
                      onChange={(event) => {
                        if (event.target.value)
                          void save(artifact, artifact.title ?? "", [
                            ...new Set([...(artifact.projectIds ?? []), event.target.value]),
                          ]);
                      }}
                    >
                      <option value="">{t("Add to project")}</option>
                      {projects
                        .filter((project) => !project.archived)
                        .map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="project-empty">
          <h2>{t("No matching media")}</h2>
          <p>{t("Generate a take or add existing media from your library.")}</p>
        </div>
      )}
    </section>
  );
}
