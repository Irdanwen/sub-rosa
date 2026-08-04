// Film studio (ADR-0010, fork, desktop only): end-to-end film production
// through Videomaker Studio. Phase 2 ships the autonomous path — brief in,
// finished film in the gallery — with live progress from the Rust SSE
// watcher. Gated (director-style) reviews land in phase 3.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildRefsManifest,
  FILM_MODEL_SET_LABELS,
  FILM_MODEL_SETS,
  FILM_REF_ROLE_LABELS,
  FILM_REF_ROLES,
  type FilmBriefRef,
  type FilmModelSet,
  type FilmEvent,
  type FilmProject,
  type FilmRefRole,
  type FilmRun,
  type FilmStatus,
  filmRunSummary,
  isRunStalled,
  listenFilmEvents,
  parseProjectList,
  parseRuns,
  parseStatus,
  parseUploadedRef,
} from "../../lib/films";
import { readFilmRef } from "../../lib/films/refs";
import { registerDownloadedArtifact } from "../../lib/studio/artifacts";
import {
  videomakerCancelRun,
  videomakerCreateProject,
  videomakerDeleteProject,
  videomakerExportFilm,
  videomakerGetSettings,
  videomakerImproveBrief,
  videomakerListProjects,
  videomakerListRuns,
  videomakerProjectStatus,
  videomakerSetAutonomous,
  videomakerStartRun,
  videomakerUpdateBudget,
  videomakerUploadRef,
} from "../../lib/tauri";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import { FilmDirectorPanel } from "./FilmDirectorPanel";
import { FilmProduceControl } from "./FilmProduceControl";
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
  // Latest run per project: a stopped run is the difference between "the
  // studio is working" and "the studio is waiting for you", and nothing in
  // the queue counts tells them apart.
  const [runBySlug, setRunBySlug] = useState<Record<string, FilmRun | null>>({});
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // New film form.
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [budgetDiem, setBudgetDiem] = useState(300);
  // Frozen at creation server-side, so it is a create-form choice and never a
  // per-project setting.
  const [modelSet, setModelSet] = useState<FilmModelSet>("full_quality");
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
  // Per-project "raise the budget ceiling" input + in-flight slug.
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});
  const [budgetBusy, setBudgetBusy] = useState<string | null>(null);
  // Per-project directed/autonomous flip in flight.
  const [autonomyBusy, setAutonomyBusy] = useState<string | null>(null);

  const refreshTimers = useRef<Record<string, number>>({});

  const refreshProjects = useCallback(async () => {
    try {
      const raw = await videomakerListProjects();
      const list = parseProjectList(raw);
      setProjects(list);
      setError(null);
      return list;
    } catch (cause) {
      setError(errorMessage(cause));
      return [] as FilmProject[];
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

  const refreshRun = useCallback(async (slug: string) => {
    try {
      const runs = parseRuns(await videomakerListRuns(slug));
      setRunBySlug((current) => ({ ...current, [slug]: runs[0] ?? null }));
    } catch {
      // Transient: the next event or resync covers it.
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
          const list = await refreshProjects();
          // Load each project's status up front so spent/ceiling and the
          // raise-ceiling control show immediately — idle/done projects emit
          // no SSE events, so they'd otherwise never populate a status. Same
          // for the run: a run that stopped emits nothing at all.
          if (!cancelled)
            for (const p of list) {
              void refreshStatus(p.slug);
              void refreshRun(p.slug);
            }
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
  }, [refreshProjects, refreshStatus, refreshRun]);

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
      // A run transition is rare and always meaningful (a pause, a quote, a
      // failure): never debounce it away.
      if (event.kind === "run") {
        void refreshRun(event.slug);
      }
      // Any other kind (scene, ledger, phase_gate...) means the project
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
  }, [refreshProjects, refreshStatus, refreshRun]);

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
        modelSet,
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
      // The set is frozen server-side and never shown again, so the one
      // confirmation the user gets is here.
      const setNote =
        modelSet === "full_quality"
          ? ""
          : ` Model set: ${FILM_MODEL_SET_LABELS[modelSet].toLowerCase()}.`;
      if (directed) {
        if (manifest) {
          setDirectorSeeds((current) => ({ ...current, [slug]: `${manifest}\n\n` }));
        }
        setNotice(`Project created. Open it below and give the crew your brief.${setNote}`);
        setExpandedSlug(slug);
      } else {
        const fullBrief = manifest ? `${brief.trim()}\n\n${manifest}` : brief.trim();
        await videomakerStartRun({
          slug,
          brief: fullBrief,
          maxCostDiem: budgetDiem,
          // The same figure bounds the run itself: the crew's own work (writing,
          // asset and storyboard renders) is billed too, and only the render
          // queue is covered by the project ceiling.
          budgetDiem,
          produce: true,
        });
        void refreshRun(slug);
        setNotice(
          `Production started. The film downloads to the gallery when it's done.${setNote}`,
        );
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
    modelSet,
    directed,
    brief,
    uploadRefs,
    refreshProjects,
    refreshStatus,
    refreshRun,
  ]);

  /// Re-POST a run on a project whose last one stopped (a gate pause, a spent
  /// envelope, a transient studio fault). The driver is state-based: an empty
  /// brief resumes at the last saved phase and never re-pays for the phases
  /// already banked. The project ceiling is reused as the run envelope so a
  /// resume is bounded exactly like the first run.
  const resumeRun = useCallback(
    async (slug: string, ceilingDiem?: number) => {
      // Both bounds come from the ceiling the user agreed (ADR-0011): no film
      // run starts unbounded, not even a resume.
      if (!(ceilingDiem && ceilingDiem > 0)) {
        setError("Set a budget ceiling on this film before resuming it.");
        return;
      }
      setRunBusy(slug);
      setError(null);
      setNotice(null);
      try {
        await videomakerStartRun({
          slug,
          brief: "",
          maxCostDiem: ceilingDiem,
          budgetDiem: ceilingDiem,
          produce: true,
        });
        setNotice("The studio picked the film back up where it stopped.");
        await refreshRun(slug);
        void refreshStatus(slug);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setRunBusy(null);
      }
    },
    [refreshRun, refreshStatus],
  );

  const stopRun = useCallback(
    async (slug: string, runId: string) => {
      setRunBusy(slug);
      setError(null);
      try {
        await videomakerCancelRun(slug, runId);
        setNotice("The run stops after the step in flight (work already paid for is finished).");
        await refreshRun(slug);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setRunBusy(null);
      }
    },
    [refreshRun],
  );

  const raiseBudget = useCallback(
    async (slug: string) => {
      const ceiling = Number(budgetDraft[slug]);
      if (!Number.isFinite(ceiling) || ceiling <= 0) {
        setError("Enter a budget ceiling greater than zero.");
        return;
      }
      setBudgetBusy(slug);
      setError(null);
      setNotice(null);
      try {
        await videomakerUpdateBudget({ slug, ceilingDiem: ceiling });
        setNotice(`Budget ceiling set to ${formatDiem(ceiling)}.`);
        setBudgetDraft((current) => {
          const next = { ...current };
          delete next[slug];
          return next;
        });
        await refreshStatus(slug);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBudgetBusy(null);
      }
    },
    [budgetDraft, refreshStatus],
  );

  // Flip a film between directed (approve each phase) and autonomous (hands-off). Turning
  // autonomy ON needs a hard DIEM cap, so it reuses the project's current ceiling; if there
  // is none yet, the user must set one first. The studio resumes a gate-paused run on the flip.
  const setAutonomy = useCallback(
    async (slug: string, next: boolean, ceilingDiem?: number) => {
      if (next && !(ceilingDiem && ceilingDiem > 0)) {
        setError("Set a budget ceiling before switching this film to autonomous.");
        return;
      }
      setAutonomyBusy(slug);
      setError(null);
      setNotice(null);
      try {
        await videomakerSetAutonomous({ slug, autonomous: next, budgetCeilingDiem: ceilingDiem });
        setNotice(
          next
            ? "Now running autonomously — the studio approves each phase and finishes hands-off."
            : "Now directed — the studio pauses for your approval at each phase.",
        );
        await refreshStatus(slug);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setAutonomyBusy(null);
      }
    },
    [refreshStatus],
  );

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
        setRunBySlug((current) => {
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
            hint="Up to 4 images the studio anchors characters, locations, or the visual style on. The brief and the crew call them by the number shown on each card."
          >
            <div className="film-refs">
              {refs.map((ref, index) => (
                <div key={ref.id} className="film-ref-card">
                  <img src={ref.previewDataUri} alt={ref.fileName} className="film-ref-thumb" />
                  <div className="film-ref-meta">
                    <span className="film-ref-index">Reference image {index + 1}</span>
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
          <StudioField
            label="Model set"
            hint={
              modelSet === "uncensored"
                ? "Writing and explicit-scene frames go to models that will not refuse adult material. Same video and audio models as the default set. A film keeps the set it was created with."
                : "The studio's default crew. Switch to uncensored for adult material, which the default writing model refuses. A film keeps the set it was created with."
            }
          >
            <PillGroup
              options={FILM_MODEL_SETS.map((set) => ({
                value: set,
                label: FILM_MODEL_SET_LABELS[set],
              }))}
              value={modelSet}
              onChange={setModelSet}
              ariaLabel="Model set"
            />
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
              // A delivered film has nothing left to resume; its last run
              // status is stale noise at that point.
              const run = project.finalMp4 ? null : runBySlug[project.slug];
              const runSummary = run ? filmRunSummary(run) : null;
              // The studio stopped on the production quote, not on its own
              // envelope: the answer is a cost decision, not a resume.
              const awaitingCost =
                run?.status === "awaiting_confirmation" &&
                run.outcome.reason !== "run_budget_exhausted";
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
                  {run && runSummary ? (
                    <div className="film-run" data-status={run.status}>
                      <p className="film-run-headline">{runSummary.headline}</p>
                      {runSummary.hint ? <p className="film-run-hint">{runSummary.hint}</p> : null}
                      <div className="studio-card-actions">
                        {isRunStalled(run) && !awaitingCost ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={runBusy === project.slug}
                            onClick={() => void resumeRun(project.slug, status?.cost.ceilingDiem)}
                          >
                            {runBusy === project.slug ? "Resuming..." : "Resume production"}
                          </button>
                        ) : null}
                        {awaitingCost ? (
                          <FilmProduceControl
                            slug={project.slug}
                            idleLabel="Review the production cost"
                            onStarted={() => {
                              void refreshRun(project.slug);
                              void refreshStatus(project.slug);
                            }}
                            onError={setError}
                          />
                        ) : null}
                        {run.status === "running" ? (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={runBusy === project.slug}
                            onClick={() => void stopRun(project.slug, run.id)}
                          >
                            Stop the run
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {status ? (
                    <div className="film-autonomy">
                      <StudioField
                        label="Direct it yourself"
                        hint={
                          status.autonomous
                            ? "Off - the studio is finishing hands-off. Turn on to approve each phase."
                            : "On - the studio pauses for your approval at each phase. Turn off to let it finish hands-off."
                        }
                      >
                        <Switch
                          checked={!status.autonomous}
                          disabled={autonomyBusy === project.slug}
                          onCheckedChange={(directed) =>
                            void setAutonomy(project.slug, !directed, status.cost.ceilingDiem)
                          }
                          aria-label={`Direct ${project.title} yourself`}
                        />
                      </StudioField>
                    </div>
                  ) : null}
                  {/* Always offered, ceiling or not: a film with no cap is the
                      one case where a run, a resume and every reshoot are
                      unbounded, and there was no other way to give it one. */}
                  {status ? (
                    <div className="film-budget">
                      {status.cost.ceilingDiem ? (
                        status.cost.spentDiem >= status.cost.ceilingDiem ? (
                          <p className="film-budget-over">
                            Over the {formatDiem(status.cost.ceilingDiem)} budget ceiling. Raise it
                            to reshoot or keep producing.
                          </p>
                        ) : null
                      ) : (
                        <p className="film-budget-over">
                          No budget ceiling on this film. Set one to bound what it can spend.
                        </p>
                      )}
                      <div className="film-budget-raise">
                        <input
                          className="studio-input"
                          type="number"
                          min={status.cost.ceilingDiem ? Math.ceil(status.cost.ceilingDiem) + 1 : 1}
                          placeholder={
                            status.cost.ceilingDiem
                              ? `New ceiling (now ${formatDiem(status.cost.ceilingDiem)})`
                              : "Budget ceiling in DIEM"
                          }
                          value={budgetDraft[project.slug] ?? ""}
                          onChange={(event) =>
                            setBudgetDraft((current) => ({
                              ...current,
                              [project.slug]: event.target.value,
                            }))
                          }
                          aria-label={`New budget ceiling for ${project.title}`}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={budgetBusy === project.slug || !budgetDraft[project.slug]}
                          onClick={() => void raiseBudget(project.slug)}
                        >
                          {budgetBusy === project.slug
                            ? "Saving..."
                            : status.cost.ceilingDiem
                              ? "Raise ceiling"
                              : "Set a ceiling"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {expandedSlug === project.slug ? (
                    <FilmDirectorPanel
                      project={project}
                      status={status}
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
