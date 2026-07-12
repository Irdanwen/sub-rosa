// Film studio (ADR-0010, fork, desktop only): end-to-end film production
// through Videomaker Studio. Phase 2 ships the autonomous path — brief in,
// finished film in the gallery — with live progress from the Rust SSE
// watcher. Gated (director-style) reviews land in phase 3.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FilmEvent,
  type FilmProject,
  type FilmStatus,
  listenFilmEvents,
  parseProjectList,
  parseStatus,
} from "../../lib/films";
import { registerDownloadedArtifact } from "../../lib/studio/artifacts";
import {
  videomakerCreateProject,
  videomakerDeleteProject,
  videomakerExportFilm,
  videomakerGetSettings,
  videomakerListProjects,
  videomakerProjectStatus,
  videomakerStartRun,
} from "../../lib/tauri";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import { FilmDirectorPanel } from "./FilmDirectorPanel";
import { GalleryStrip } from "./GalleryStrip";
import { PillGroup, StudioField } from "./controls";

const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const STATUS_REFRESH_DEBOUNCE_MS = 3_000;

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
      if (directed) {
        setNotice("Project created. Open it below and give the crew your brief.");
        setExpandedSlug(slug);
      } else {
        await videomakerStartRun({
          slug,
          brief: brief.trim(),
          maxCostDiem: budgetDiem,
          produce: true,
        });
        setNotice("Production started. The film downloads to the gallery when it's done.");
      }
      setTitle("");
      setBrief("");
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
            </StudioField>
          )}
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
                  {expandedSlug === project.slug ? <FilmDirectorPanel project={project} /> : null}
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
