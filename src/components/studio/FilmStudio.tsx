// Film studio (ADR-0010, fork, desktop only): end-to-end film production
// through Videomaker Studio. Phase 2 ships the autonomous path — brief in,
// finished film in the gallery — with live progress from the Rust SSE
// watcher. Gated (director-style) reviews land in phase 3.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildRefsManifest,
  FILM_REF_ROLE_LABELS,
  FILM_REF_ROLES,
  type FilmBriefRef,
  type FilmEvent,
  type FilmProject,
  type FilmRefRole,
  type FilmStatus,
  listenFilmEvents,
  parseProjectList,
  parseStatus,
  parseUploadedRef,
} from "../../lib/films";
import { readFilmRef } from "../../lib/films/refs";
import { registerDownloadedArtifact } from "../../lib/studio/artifacts";
import {
  videomakerCreateProject,
  videomakerDeleteProject,
  videomakerExportFilm,
  videomakerGetSettings,
  videomakerImproveBrief,
  videomakerListProjects,
  videomakerProjectStatus,
  videomakerStartRun,
  videomakerUploadRef,
} from "../../lib/tauri";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import { FilmDirectorPanel } from "./FilmDirectorPanel";
import { GalleryStrip } from "./GalleryStrip";
import { PillGroup, StudioField } from "./controls";

const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const STATUS_REFRESH_DEBOUNCE_MS = 3_000;
const MAX_REFS = 4;

type ErrorLike = { message?: string };

function errorMessage(error: unknown): string {
  const message = (error as ErrorLike)?.message;
  return typeof message === "string" && message ? message : "Something went wrong.";
}

function formatDiem(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} DIEM`;
}

/** Human copy for Videomaker's project states. */
function stateLabel(project: FilmProject): string {
  if (project.finalMp4) return "Film ready";
  switch (project.state) {
    case "new":
    case "discovery":
      return "Brief";
    case "production":
      return "Producing";
    case "done":
      return "Film ready";
    case "archived":
      return "Archived";
    default:
      return project.state.replaceAll("_", " ");
  }
}

export function FilmStudio() {
  const [activated, setActivated] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<FilmProject[]>([]);
  const [statusBySlug, setStatusBySlug] = useState<Record<string, FilmStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // New film form.
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [budgetDiem, setBudgetDiem] = useState(300);
  const [directed, setDirected] = useState(false);
  const [creating, setCreating] = useState(false);
  // Reference images picked for the next film (uploaded at produce time —
  // the studio's upload endpoint needs the project to exist first).
  const [refs, setRefs] = useState<FilmBriefRef[]>([]);
  const refInputRef = useRef<HTMLInputElement | null>(null);
  // AI brief development: the improved text lands in a preview the user
  // explicitly accepts — never a silent overwrite of their draft.
  const [improving, setImproving] = useState(false);
  const [improvedBrief, setImprovedBrief] = useState<string | null>(null);
  // Refs manifest awaiting hand-off to the director chat, keyed by slug.
  const [directorSeeds, setDirectorSeeds] = useState<Record<string, string>>({});
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const refreshTimers = useRef<Record<string, number>>({});

  const refreshProjects = useCallback(async () => {
    try {
      const raw = await videomakerListProjects();
      setProjects(parseProjectList(raw));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const refreshStatus = useCallback(async (slug: string) => {
    try {
      const raw = await videomakerProjectStatus(slug);
      setStatusBySlug((current) => ({ ...current, [slug]: parseStatus(raw) }));
    } catch {
      // Transient: the watcher's next resync covers it.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await videomakerGetSettings();
        if (cancelled) return;
        setActivated(settings.activated);
        if (settings.activated) {
          await refreshProjects();
        }
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshProjects]);

  // Live progress from the Rust SSE watcher.
  useEffect(() => {
    const timers = refreshTimers.current;
    const unlisten = listenFilmEvents((event: FilmEvent) => {
      if (event.kind === "status") {
        setStatusBySlug((current) => ({
          ...current,
          [event.slug]: parseStatus(event.data),
        }));
        return;
      }
      if (event.kind === "exported") {
        const artifact = event.data as { path?: string; fileName?: string; bytes?: number };
        if (artifact?.path && artifact.fileName) {
          registerDownloadedArtifact(
            { path: artifact.path, fileName: artifact.fileName, bytes: artifact.bytes ?? 0 },
            { kind: "video", model: "videomaker", prompt: `Film: ${event.slug}` },
          );
          setGalleryEpoch((epoch) => epoch + 1);
          setNotice("A finished film was saved to the gallery.");
        }
        void refreshProjects();
        return;
      }
      if (event.kind === "gone") {
        setNotice("A film project expired on the studio and was removed.");
        void refreshProjects();
        return;
      }
      // Any other kind (scene, ledger, run, phase_gate...) means the project
      // moved: refresh its status, debounced per slug — production emits a
      // lot of events.
      const now = Date.now();
      const last = timers[event.slug] ?? 0;
      if (now - last > STATUS_REFRESH_DEBOUNCE_MS) {
        timers[event.slug] = now;
        void refreshStatus(event.slug);
        void refreshProjects();
      }
    });
    return unlisten;
  }, [refreshProjects, refreshStatus]);

  // Directed films start from the chat (the brief goes there), so only the
  // autonomous path needs the brief upfront. A budget is always required for
  // autonomy; in directed mode the produce handshake guards the spend.
  const canCreate =
    title.trim().length > 0 &&
    (directed || (brief.trim().length > 0 && budgetDiem > 0)) &&
    !creating;

  const addRefs = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      const picked = await Promise.all(
        Array.from(files).map((file) => readFilmRef(file, "character")),
      );
      setRefs((current) => [...current, ...picked].slice(0, MAX_REFS));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const updateRef = useCallback((index: number, patch: Partial<FilmBriefRef>) => {
    setRefs((current) =>
      current.map((ref, position) => (position === index ? { ...ref, ...patch } : ref)),
    );
  }, []);

  const removeRef = useCallback((index: number) => {
    setRefs((current) => current.filter((_, position) => position !== index));
  }, []);

  const improveBrief = useCallback(async () => {
    if (!brief.trim() || improving) return;
    setImproving(true);
    setError(null);
    try {
      const improved = await videomakerImproveBrief({
        brief: brief.trim(),
        title: title.trim() || undefined,
        aspectRatio,
        targetDurationSeconds: durationSeconds,
        refs: refs.map((ref) => ({
          role: ref.role,
          label: ref.label.trim() || undefined,
          dataUri: ref.previewDataUri,
        })),
      });
      setImprovedBrief(improved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImproving(false);
    }
  }, [brief, improving, title, aspectRatio, durationSeconds, refs]);

  /// Upload the picked references to a freshly created project and return the
  /// manifest block the crew reads. Throws with a project-aware message so a
  /// failed upload never silently drops a reference.
  const uploadRefs = useCallback(
    async (slug: string): Promise<string> => {
      if (refs.length === 0) return "";
      const uploaded: Array<{ role: FilmRefRole; label: string; url: string }> = [];
      for (const ref of refs) {
        const parsed = parseUploadedRef(
          await videomakerUploadRef({
            slug,
            fileName: ref.fileName,
            base64Data: ref.base64Data,
          }),
        );
        if (!parsed) {
          throw new Error(`The studio did not accept the reference image "${ref.fileName}".`);
        }
        uploaded.push({ role: ref.role, label: ref.label, url: parsed.publicUrl });
      }
      return buildRefsManifest(uploaded);
    },
    [refs],
  );

  const produceFilm = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const created = await videomakerCreateProject({
        title: title.trim(),
        aspectRatio,
        targetDurationSeconds: durationSeconds,
        autonomous: !directed,
        budgetCeilingDiem: budgetDiem > 0 ? budgetDiem : undefined,
      });
      const slug = (created as { project?: { slug?: string } }).project?.slug;
      if (!slug) throw new Error("Videomaker did not return a project.");
      let manifest = "";
      try {
        manifest = await uploadRefs(slug);
      } catch (cause) {
        // The project exists but a reference is missing: stop before the run
        // so the crew never starts without the anchors the user picked.
        throw new Error(
          `The project was created, but a reference image failed to upload (${errorMessage(cause)}). Production was not started: remove the image or produce again.`,
        );
      }
      if (directed) {
        if (manifest) {
          setDirectorSeeds((current) => ({ ...current, [slug]: `${manifest}\n\n` }));
        }
        setNotice("Project created. Open it below and give the crew your brief.");
        setExpandedSlug(slug);
      } else {
        const fullBrief = manifest ? `${brief.trim()}\n\n${manifest}` : brief.trim();
        await videomakerStartRun({
          slug,
          brief: fullBrief,
          maxCostDiem: budgetDiem,
          produce: true,
        });
        setNotice("Production started. The film downloads to the gallery when it's done.");
      }
      setTitle("");
      setBrief("");
      setRefs([]);
      setImprovedBrief(null);
      await refreshProjects();
      void refreshStatus(slug);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }, [
    canCreate,
    title,
    aspectRatio,
    durationSeconds,
    budgetDiem,
    directed,
    brief,
    uploadRefs,
    refreshProjects,
    refreshStatus,
  ]);

  const downloadFilm = useCallback(async (project: FilmProject) => {
    setBusySlug(project.slug);
    setError(null);
    try {
      const artifact = await videomakerExportFilm(project.slug);
      registerDownloadedArtifact(
        { path: artifact.path, fileName: artifact.fileName, bytes: artifact.bytes },
        { kind: "video", model: "videomaker", prompt: `Film: ${project.title}` },
      );
      setGalleryEpoch((epoch) => epoch + 1);
      setNotice(`"${project.title}" is in the gallery.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusySlug(null);
    }
  }, []);

  const deleteProject = useCallback(
    async (project: FilmProject) => {
      if (!window.confirm(`Delete "${project.title}" from the studio? This is permanent.`)) {
        return;
      }
      setBusySlug(project.slug);
      setError(null);
      try {
        await videomakerDeleteProject(project.slug);
        setStatusBySlug((current) => {
          const { [project.slug]: _dropped, ...rest } = current;
          return rest;
        });
        await refreshProjects();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusySlug(null);
      }
    },
    [refreshProjects],
  );

  const sortedProjects = useMemo(
    () =>
      [...projects].sort((a, b) =>
        (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""),
      ),
    [projects],
  );

  if (loading) {
    return (
      <div className="studio-loading">
        <Spinner aria-label="Loading film projects" />
      </div>
    );
  }

  if (!activated) {
    return (
      <EmptyState
        title="Film production is not activated"
        description="Activate film production in Settings > Film studio to produce complete short films billed in DIEM to your Carpe Diem key."
      />
    );
  }

  return (
    <div className="studio-generation film-studio">
      <div className="studio-controls">
        <div className="studio-controls-fields">
          <StudioField label="Title">
            <input
              className="studio-input"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Neon alley duel"
              aria-label="Film title"
            />
          </StudioField>
          <StudioField
            label="Direct it yourself"
            hint="Review and approve each phase (bible, assets, shotlist, storyboard) instead of a hands-off run."
          >
            <Switch
              checked={directed}
              onCheckedChange={setDirected}
              aria-label="Direct it yourself"
            />
          </StudioField>
          {directed ? null : (
            <StudioField label="Brief" hint="Story, tone, characters, locations, style references.">
              <textarea
                className="studio-textarea"
                rows={7}
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="A rain-soaked cyberpunk alley at night. Two rivals face off..."
                aria-label="Film brief"
              />
              <div className="film-brief-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!brief.trim() || improving || creating}
                  onClick={() => void improveBrief()}
                >
                  {improving ? "Improving..." : "Improve with AI"}
                </button>
                <span className="film-brief-hint">
                  Develops your draft into a full production brief
                  {refs.length > 0 ? ", anchored on your reference images" : ""}.
                </span>
              </div>
              {improvedBrief ? (
                <div className="film-brief-preview">
                  <p className="film-brief-preview-title">Improved brief</p>
                  <pre className="film-brief-preview-text">{improvedBrief}</pre>
                  <div className="studio-card-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setBrief(improvedBrief);
                        setImprovedBrief(null);
                      }}
                    >
                      Use this brief
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setImprovedBrief(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : null}
            </StudioField>
          )}
          <StudioField
            label="Reference images"
            hint="Up to 4 images the studio anchors characters, locations, or the visual style on."
          >
            <div className="film-refs">
              {refs.map((ref, index) => (
                <div key={ref.id} className="film-ref-card">
                  <img src={ref.previewDataUri} alt={ref.fileName} className="film-ref-thumb" />
                  <div className="film-ref-meta">
                    <PillGroup
                      options={FILM_REF_ROLES.map((role) => ({
                        value: role,
                        label: FILM_REF_ROLE_LABELS[role],
                      }))}
                      value={ref.role}
                      onChange={(role) => updateRef(index, { role })}
                      ariaLabel={`Role of ${ref.fileName}`}
                    />
                    <input
                      className="studio-input"
                      type="text"
                      value={ref.label}
                      placeholder="Name it for the brief (optional)"
                      onChange={(event) => updateRef(index, { label: event.target.value })}
                      aria-label={`Name of ${ref.fileName}`}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => removeRef(index)}
                    aria-label={`Remove ${ref.fileName}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {refs.length < MAX_REFS ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={creating}
                  onClick={() => refInputRef.current?.click()}
                >
                  Add an image
                </button>
              ) : null}
              <input
                ref={refInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(event) => {
                  void addRefs(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          </StudioField>
          <StudioField label="Aspect ratio">
            <PillGroup
              options={ASPECT_RATIOS.map((ratio) => ({ value: ratio }))}
              value={aspectRatio}
              onChange={setAspectRatio}
              ariaLabel="Aspect ratio"
            />
          </StudioField>
          <StudioField label="Target duration" hint={`${durationSeconds} s`}>
            <input
              className="studio-slider"
              type="range"
              min={15}
              max={300}
              step={15}
              value={durationSeconds}
              onChange={(event) => setDurationSeconds(Number(event.target.value))}
              aria-label="Target duration in seconds"
            />
          </StudioField>
          <StudioField
            label="Budget ceiling"
            hint="Hard spend cap in DIEM, enforced by the studio at every step."
          >
            <input
              className="studio-input"
              type="number"
              min={1}
              value={budgetDiem}
              onChange={(event) => setBudgetDiem(Number(event.target.value))}
              aria-label="Budget ceiling in DIEM"
            />
          </StudioField>
        </div>
        <div className="studio-controls-action">
          <button
            type="button"
            className="studio-primary-button"
            disabled={!canCreate}
            onClick={() => void produceFilm()}
          >
            {creating ? "Starting..." : "Produce the film"}
          </button>
          <p className="studio-cost">
            {directed
              ? "You approve each phase and confirm the production cost before any shot renders."
              : `Hands-off production: the studio writes the bible, shotlist, and storyboard, renders every shot, and cuts the film. Up to ${formatDiem(budgetDiem)}.`}
          </p>
        </div>
      </div>

      <div className="studio-output">
        {error ? <p className="studio-error">{error}</p> : null}
        {notice ? <p className="studio-quote">{notice}</p> : null}
        {sortedProjects.length === 0 ? (
          <EmptyState
            title="No films yet"
            description="Give the studio a brief and a budget; the finished film lands in the gallery."
          />
        ) : (
          <ul className="film-project-list">
            {sortedProjects.map((project) => {
              const status = statusBySlug[project.slug];
              const busy = busySlug === project.slug;
              return (
                <li key={project.slug} className="film-project-card">
                  <div className="film-project-head">
                    <div>
                      <h3 className="film-project-title">{project.title}</h3>
                      <p className="film-project-state" data-state={project.state}>
                        {stateLabel(project)}
                        {status?.walletEmpty ? " - Carpe Diem balance exhausted" : ""}
                      </p>
                    </div>
                    <div className="studio-card-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() =>
                          setExpandedSlug((current) =>
                            current === project.slug ? null : project.slug,
                          )
                        }
                      >
                        {expandedSlug === project.slug ? "Close" : "Direct"}
                      </button>
                      {project.finalMp4 ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() => void downloadFilm(project)}
                        >
                          {busy ? "Downloading..." : "Save to gallery"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => void deleteProject(project)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {status ? (
                    <div className="film-project-status">
                      <span>
                        {status.queue.done} done - {status.queue.running} running -{" "}
                        {status.queue.queued} queued
                        {status.queue.failed > 0 ? ` - ${status.queue.failed} failed` : ""}
                      </span>
                      <span>
                        {formatDiem(status.cost.spentDiem)} spent
                        {status.cost.ceilingDiem
                          ? ` of ${formatDiem(status.cost.ceilingDiem)}`
                          : ""}
                      </span>
                    </div>
                  ) : null}
                  {expandedSlug === project.slug ? (
                    <FilmDirectorPanel
                      project={project}
                      initialDraft={directorSeeds[project.slug]}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <GalleryStrip
          kind="video"
          epoch={galleryEpoch}
          empty="Finished films appear here and in the Video gallery."
        />
      </div>
    </div>
  );
}
