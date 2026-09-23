import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { errorCode } from "../../lib/errors";
import { intlLocale, t } from "../../lib/i18n";
import {
  buildShotList,
  createNote,
  deleteNotes,
  getNote,
  shotList,
  SHOT_LIST_EVENT,
  updateNote,
  type ShotListDto,
} from "../../lib/tauri";
import { listArtifacts } from "../../lib/studio/artifacts";
import {
  BIBLE_KINDS,
  BIBLE_ROLE_LABELS,
  type BibleKind,
  type BibleRole,
} from "../../lib/studio/bible";
import { createEditorClip, fps } from "../../lib/studio/editor/document";
import { mediaSeconds } from "../../lib/studio/reference-media";
import { artifactSrc } from "../../lib/studio/artifacts";
import { modelsOfType } from "../../lib/studio/catalog";
import {
  compileOpeningImage,
  compileBibleReference,
  compileProjectWithNotes,
  productionBudget,
  quoteProject,
} from "../../lib/studio/project-production";
import {
  getProject,
  importLegacyFilms,
  listProjects,
  listArtifactMetadata,
  montageArtifacts,
  newProject,
  newShot,
  organizeArtifact,
  projectDocumentFits,
  projectError,
  ProjectWriter,
  saveArtifactMetadata,
  saveProject,
  sameProjectMembership,
  shotSignature,
  type ProjectDocument,
  type ProjectRun,
  type ProjectSummary,
  type StudioProject,
} from "../../lib/studio/projects";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import type { Shot } from "../../lib/studio/workflow/compile";
import type { Workflow } from "../../lib/studio/workflow/schema";
import {
  estimateNodeCost,
  nodeCostMap,
  type WorkflowCostEstimate,
} from "../../lib/studio/workflow/cost";
import type { NodeRunResult } from "../../lib/studio/workflow/engine";
import {
  activeWorkflowRuns,
  descendantsOf,
  resumeWorkflowRun,
  runAndSaveWorkflow,
} from "../../lib/studio/workflow-run";
import { Dialog } from "../ui/Dialog";
import { NotePicker } from "./NotePicker";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";
import { ProjectBible } from "./ProjectBible";
import { ProjectMedia } from "./ProjectMedia";
import { ProjectShots } from "./ProjectShots";
import { ProjectTimeline } from "./ProjectTimeline";
import { STUDIO_IMAGE_RECOVERED_EVENT } from "../../lib/studio/image-job-recovery";
import { STUDIO_FILM_NOTE_KEY } from "./studio-keys";
import "./project-studio.css";

type Section = "script" | "shots" | "bible" | "media" | "montage";
const LAST_PROJECT = "os-june:studio-project";
type ReadyQuote = {
  projectId: string;
  version: number;
  resumeRun?: ProjectRun;
  redoNodeIds?: string[];
  uncertainRetry?: boolean;
  acceptedCosts?: Record<string, number>;
  priorSpend?: number;
  workflow: Workflow;
  estimate: WorkflowCostEstimate;
  notes?: string[];
  signatures: Record<string, string>;
};

const quoteCredits = (credits: number) =>
  credits.toLocaleString(intlLocale(), { maximumFractionDigits: 2 });

export function ProjectStudio({ catalog }: { catalog: MediaCatalog }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<StudioProject | null>(null);
  const current = useRef<StudioProject | null>(null);
  const writer = useRef<ProjectWriter>();
  const [section, setSection] = useState<Section>("shots");
  const [library, setLibrary] = useState(false);
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [saved, setSaved] = useState(true);
  const [error, setErrorState] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const productionBusy = useRef(false);
  const [reading, setReading] = useState(false);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [notePicker, setNotePicker] = useState(false);
  const [mediaSaving, setMediaSaving] = useState(false);
  const [openSession, setOpenSession] = useState(0);
  const [reopenConfirm, setReopenConfirm] = useState(false);
  const [quote, setQuote] = useState<ReadyQuote>();
  const [runStates, setRunStates] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, NodeRunResult>>({});
  const abort = useRef<AbortController>();
  const resultWrites = useRef<Promise<void>>(Promise.resolve());
  const finishingReadings = useRef(new Set<string>());
  const epoch = useRef(0);
  const openRequest = useRef(0);
  const errorVersion = useRef(0);
  const setError = (message: string) => {
    ++errorVersion.current;
    setErrorState(message);
  };
  const report = (cause: unknown) => setError(projectError(cause));
  const refreshArtifacts = async () => {
    const items = await listArtifacts();
    setArtifacts(items);
    return items;
  };
  useEffect(() => {
    const onRecovered = () =>
      void listArtifacts()
        .then(setArtifacts)
        .catch(() => undefined);
    window.addEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
    return () => window.removeEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
  }, []);
  const edit = (change: (previous: StudioProject) => StudioProject) => {
    if (!current.current || !writer.current) return Promise.resolve();
    const next = change(current.current);
    if (!projectDocumentFits(next.document)) {
      const cause = new Error(t("This film is too large to save. Reduce its script or LUTs."));
      report(cause);
      return Promise.reject(cause);
    }
    current.current = next;
    setProject(next);
    setSaved(false);
    const version = ++epoch.current;
    const errorAtSave = errorVersion.current;
    return writer.current
      .save(next)
      .then(() => {
        if (epoch.current === version) {
          setSaved(true);
          if (errorVersion.current === errorAtSave) setError("");
        }
      })
      .catch((cause) => {
        report(cause);
        throw cause;
      });
  };
  const editDocument = (change: (previous: ProjectDocument) => ProjectDocument) => {
    void edit((previous) => ({ ...previous, document: change(previous.document) })).catch(
      () => undefined,
    );
  };
  const finishReadingNote = async (noteId: string, projectId: string) => {
    await deleteNotes([noteId]);
    if (current.current?.id !== projectId || current.current.document.readingNoteId !== noteId)
      return;
    await edit((previous) => ({
      ...previous,
      document: { ...previous.document, readingNoteId: undefined },
    }));
  };
  const open = async (value: StudioProject, request = ++openRequest.current) => {
    const version = epoch.current;
    await writer.current?.flush(current.current ?? undefined);
    if (request !== openRequest.current || version !== epoch.current) return;
    current.current = value;
    ++epoch.current;
    writer.current = new ProjectWriter(value);
    setProject(value);
    setOpenSession((session) => session + 1);
    setSaved(true);
    setError("");
    setLibrary(false);
    setProgress({});
    setRunStates({});
    setReading(false);
    window.localStorage.setItem(LAST_PROJECT, value.id);
    const readingNoteId = value.document.readingNoteId;
    if (readingNoteId) {
      const row = await shotList(readingNoteId);
      if (current.current?.id !== value.id) return;
      if (row) await acceptReading(row);
      else await finishReadingNote(readingNoteId, value.id);
    }
    const openingWriter = writer.current;
    const missing = new Set<string>();
    for (const run of value.document.runs) {
      if (current.current?.id !== value.id || writer.current !== openingWriter) return;
      try {
        await restoreRun(run, value.id, openingWriter);
      } catch (cause) {
        if (errorCode(cause) !== "workflow_run_missing") throw cause;
        missing.add(run.id);
      }
    }
    if (missing.size && current.current?.id === value.id && writer.current === openingWriter)
      await edit((previous) => ({
        ...previous,
        document: {
          ...previous.document,
          runs: previous.document.runs.filter((run) => !missing.has(run.id)),
        },
      }));
  };
  const applyResult = (run: ProjectRun, result: NodeRunResult, projectId: string) => {
    if (current.current?.id !== projectId) return;
    setProgress((previous) => ({ ...previous, [result.nodeId]: result }));
    const output = result.output;
    if (result.status !== "done" || !output || output.kind === "text" || !output.artifactId) return;
    const artifactId = output.artifactId;
    const alreadyApplied = current.current.document.runs
      .find((savedRun) => savedRun.id === run.id)
      ?.appliedNodeIds?.includes(result.nodeId);
    // A recovered node can have its applied marker committed while the
    // detached gallery write was interrupted. Repair that membership only if
    // the project still owns the media; a deliberate removal stays removed.
    if (alreadyApplied && !current.current.document.artifactIds.includes(artifactId)) return;
    const applyDocument = (document: ProjectDocument): ProjectDocument => {
      const savedRun = document.runs.find((item) => item.id === run.id);
      const signatures = { ...(savedRun?.shotSignatures ?? run.shotSignatures) };
      const completedIndex = document.shots.findIndex(
        (shot) => result.nodeId === `shot-${shot.id}`,
      );
      const successor = completedIndex >= 0 ? document.shots[completedIndex + 1] : undefined;
      if (successor?.mode === "continuation")
        signatures[successor.id] = shotSignature(successor, document, artifactId);
      return {
        ...document,
        runs: document.runs.map((savedRun) =>
          savedRun.id === run.id
            ? {
                ...savedRun,
                shotSignatures: signatures,
                appliedNodeIds: [...new Set([...(savedRun.appliedNodeIds ?? []), result.nodeId])],
              }
            : savedRun,
        ),
        artifactIds: [...new Set([...document.artifactIds, artifactId])],
        bible: document.bible.map((entry) => {
          const match = /^bible-(.+)-(portrait|profile|wide|medium|detail)$/.exec(result.nodeId);
          if (
            !match ||
            match[1] !== entry.id ||
            entry.refs.some((ref) => ref.artifactId === artifactId)
          )
            return entry;
          const role = match[2] as BibleRole;
          return {
            ...entry,
            refs: [
              ...entry.refs,
              {
                id: crypto.randomUUID(),
                entryId: entry.id,
                artifactId,
                role,
                label: BIBLE_ROLE_LABELS[role],
                ordinal: entry.refs.length,
              },
            ],
          };
        }),
        shots: document.shots.map((shot) => {
          if (result.nodeId === `shot-${shot.id}`)
            return {
              ...shot,
              takeIds: [...new Set([...shot.takeIds, artifactId])],
              activeTakeId: shot.activeTakeId ?? artifactId,
              renderedSignature: signatures[shot.id],
            };
          if (shot.id === successor?.id && savedRun?.appliedNodeIds?.includes(`shot-${shot.id}`))
            return { ...shot, renderedSignature: signatures[shot.id] };
          if (result.nodeId === `image-${shot.id}`)
            return {
              ...shot,
              imageCandidates: [...new Set([...shot.imageCandidates, artifactId])],
            };
          return shot;
        }),
      };
    };
    const saved = alreadyApplied
      ? Promise.resolve()
      : edit((previous) => ({ ...previous, document: applyDocument(previous.document) }));
    // The previous gallery write may still be pending when this save rejects.
    void saved.catch(() => undefined);
    resultWrites.current = resultWrites.current
      .then(() => saved)
      .then(async () => {
        const owner = await getProject(projectId);
        if (!owner?.document.artifactIds.includes(artifactId)) return;
        const metadata = (await listArtifactMetadata()).find((item) => item.id === artifactId);
        if (metadata?.projectIds.includes(projectId)) return;
        await saveArtifactMetadata({
          id: artifactId,
          title: metadata?.title ?? "",
          projectIds: [...new Set([...(metadata?.projectIds ?? []), projectId])],
        });
      })
      .catch(report);
  };
  const restoreRun = async (
    run: ProjectRun,
    projectId: string,
    openingWriter: ProjectWriter | undefined,
  ) => {
    const detail = await invoke<{
      run: { status: string };
      nodes: Array<{ nodeId: string; status: string; output?: string; error?: string }>;
    }>("workflow_run_get", { id: run.id });
    if (current.current?.id !== projectId || writer.current !== openingWriter) return;
    setRunStates((previous) => ({ ...previous, [run.id]: detail.run.status }));
    for (const node of detail.nodes) {
      if (node.status !== "done" || !node.output) continue;
      let output: NodeRunResult["output"];
      try {
        output = JSON.parse(node.output);
      } catch {
        continue;
      }
      if (output && output.kind !== "text" && output.artifactId)
        applyResult(run, { nodeId: node.nodeId, status: "done", output }, projectId);
    }
  };
  useEffect(() => {
    let cancelled = false;
    const request = ++openRequest.current;
    void (async () => {
      try {
        await importLegacyFilms();
        const [items, media] = await Promise.all([listProjects(), listArtifacts()]);
        if (cancelled) return;
        setProjects(items);
        setArtifacts(media);
        const asked = window.localStorage.getItem(STUDIO_FILM_NOTE_KEY);
        if (asked) {
          for (const item of items) {
            const candidate = await getProject(item.id);
            if (cancelled) return;
            if (candidate?.document.noteId !== asked) continue;
            await open(candidate, request);
            if (request !== openRequest.current) return;
            setSection(candidate.document.shots.length ? "shots" : "script");
            window.localStorage.removeItem(STUDIO_FILM_NOTE_KEY);
            return;
          }
          const note = await getNote(asked);
          if (cancelled) return;
          const linked = newProject(note.title || t("Untitled project"));
          linked.document.noteId = asked;
          linked.document.script = note.editedContent ?? note.generatedContent ?? "";
          const stored = await saveProject(linked, null);
          if (cancelled) return;
          setProjects(await listProjects());
          await open(stored, request);
          if (request !== openRequest.current) return;
          setSection("script");
          window.localStorage.removeItem(STUDIO_FILM_NOTE_KEY);
          return;
        }
        const id = window.localStorage.getItem(LAST_PROJECT);
        if (id) {
          const last = await getProject(id);
          if (last && !last.archived && !cancelled) await open(last, request);
        }
      } catch (cause) {
        if (!cancelled) report(cause);
      }
    })();
    return () => {
      cancelled = true;
      abort.current?.abort();
    };
  }, []);
  const acceptReading = async (row: ShotListDto) => {
    const active = current.current;
    if (!active || row.noteId !== active.document.readingNoteId) return;
    setReading(row.status === "pending" || row.status === "running");
    if (row.status === "pending" || row.status === "running") return;
    if (finishingReadings.current.has(row.noteId)) return;
    finishingReadings.current.add(row.noteId);
    try {
      if (row.status === "failed") {
        const failure = row.lastError || t("The script could not be read.");
        await finishReadingNote(row.noteId, active.id);
        if (current.current?.id === active.id) setError(failure);
        return;
      }
      if (row.status !== "ready") return;
      if (!row.shotsJson) {
        await finishReadingNote(row.noteId, active.id);
        if (current.current?.id === active.id) setError(t("The script could not be read."));
        return;
      }
      if (active.document.shots.length) {
        await finishReadingNote(row.noteId, active.id);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(row.shotsJson);
        const body =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        const shots = Array.isArray(parsed)
          ? (parsed as Shot[])
          : Array.isArray(body?.shots)
            ? (body.shots as Shot[])
            : [];
        const cast = Array.isArray(body?.cast)
          ? body.cast.flatMap((entry) => {
              if (!entry || typeof entry !== "object") return [];
              const member = entry as Record<string, unknown>;
              const name = typeof member.name === "string" ? member.name.trim() : "";
              if (!name || !BIBLE_KINDS.includes(member.kind as BibleKind)) return [];
              return [
                {
                  name,
                  kind: member.kind as BibleKind,
                  traits: typeof member.traits === "string" ? member.traits : "",
                },
              ];
            })
          : [];
        await edit((previous) => ({
          ...previous,
          document: {
            ...previous.document,
            shots: shots.map((shot, index) => ({
              ...newShot(index),
              ...shot,
              id: crypto.randomUUID(),
              title: shot.scene || t("Shot {number}", { number: index + 1 }),
              mode: shot.continues ? "continuation" : "text",
            })),
            bible: [
              ...previous.document.bible,
              ...cast
                .filter(
                  (member, index) =>
                    !previous.document.bible.some(
                      (entry) => entry.name.trim().toLowerCase() === member.name.toLowerCase(),
                    ) &&
                    !cast
                      .slice(0, index)
                      .some((entry) => entry.name.toLowerCase() === member.name.toLowerCase()),
                )
                .map((member) => ({
                  id: crypto.randomUUID(),
                  name: member.name,
                  kind: member.kind,
                  traits: member.traits,
                  note: "",
                  refs: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                })),
            ],
          },
        }));
        setSection("shots");
      } catch (cause) {
        report(cause);
        return;
      }
      await finishReadingNote(row.noteId, active.id);
    } finally {
      finishingReadings.current.delete(row.noteId);
    }
  };
  // The listener reads the active project through current.current. Keeping one
  // subscription avoids dropping native events between renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listener identity is stable by design
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then((api) =>
        api.listen<ShotListDto>(SHOT_LIST_EVENT, (event) => {
          void acceptReading(event.payload).catch(report);
        }),
      )
      .then((stop) => {
        if (cancelled) stop();
        else dispose = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  const create = async (source?: StudioProject, request = ++openRequest.current) => {
    if (request !== openRequest.current) return;
    const next = source
      ? {
          ...structuredClone(source),
          id: crypto.randomUUID(),
          name: t("{name} copy", { name: source.name }),
          revision: 0,
          archived: false,
          document: { ...structuredClone(source.document), readingNoteId: undefined, runs: [] },
        }
      : newProject();
    const stored = await saveProject(next, null);
    await open(stored, request);
    setProjects(await listProjects());
    if (request === openRequest.current) setSection(source ? "shots" : "script");
  };
  const back = async () => {
    const request = ++openRequest.current;
    await writer.current?.flush(current.current ?? undefined);
    if (request !== openRequest.current) return;
    current.current = null;
    writer.current = undefined;
    setProject(null);
    window.localStorage.removeItem(LAST_PROJECT);
    setProjects(await listProjects());
  };
  const retrySave = async () => {
    const version = epoch.current;
    await writer.current?.flush(current.current ?? undefined);
    if (version === epoch.current) {
      setSaved(true);
      setError("");
    }
  };
  const reopenSaved = async () => {
    const request = ++openRequest.current;
    const version = epoch.current;
    const id = current.current?.id;
    if (!id) return;
    const stored = await getProject(id);
    if (current.current?.id !== id || request !== openRequest.current || version !== epoch.current)
      return;
    if (!stored) {
      setError(t("This project is no longer available."));
      return;
    }
    writer.current = undefined;
    setReopenConfirm(false);
    await open(stored, request);
  };
  const attachArtifactMetadata = async (artifactId: string, projectId: string) => {
    const metadata = (await listArtifactMetadata()).find((item) => item.id === artifactId);
    if (metadata?.projectIds.includes(projectId)) return;
    await saveArtifactMetadata({
      id: artifactId,
      projectIds: [...new Set([...(metadata?.projectIds ?? []), projectId])],
    });
    await refreshArtifacts();
  };
  const addArtifact = (artifactId: string) => {
    const target = current.current;
    if (!target || !writer.current) return;
    void edit((previous) => ({
      ...previous,
      document: {
        ...previous.document,
        artifactIds: [...new Set([...previous.document.artifactIds, artifactId])],
      },
    }))
      .then(() => attachArtifactMetadata(artifactId, target.id))
      .catch(report);
  };
  const prepare = async (shotId?: string, image = false) => {
    if (!current.current) return;
    if (exportingRef.current) {
      report(new Error(t("Wait for montage export to finish before generating.")));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await writer.current?.flush();
      const snapshot = current.current;
      const version = epoch.current;
      const selected = snapshot.document.shots.find((shot) => shot.id === shotId);
      const compiled =
        image && selected
          ? { workflow: compileOpeningImage(selected, snapshot.name), notes: [] }
          : compileProjectWithNotes(snapshot.name, snapshot.document, catalog, shotId);
      const { workflow, notes } = compiled;
      const estimate = await quoteProject(workflow, catalog);
      if (current.current?.id !== snapshot.id || epoch.current !== version)
        throw new Error(
          t("The project changed while quoting. Review its settings and quote again."),
        );
      setQuote({
        projectId: snapshot.id,
        version,
        workflow,
        estimate,
        notes,
        signatures: Object.fromEntries(
          snapshot.document.shots.map((shot) => [shot.id, shotSignature(shot, snapshot.document)]),
        ),
      });
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const produce = async (ready: ReadyQuote) => {
    if (exportingRef.current) {
      setQuote(undefined);
      report(new Error(t("Wait for montage export to finish before generating.")));
      return;
    }
    const origin = current.current;
    if (!origin || origin.id !== ready.projectId || epoch.current !== ready.version) {
      setQuote(undefined);
      report(
        new Error(t("The project changed while quoting. Review its settings and quote again.")),
      );
      return;
    }
    setQuote(undefined);
    setBusy(true);
    productionBusy.current = true;
    setError("");
    setProgress({});
    const controller = new AbortController();
    abort.current = controller;
    let run: ProjectRun = ready.resumeRun ?? { id: "", shotSignatures: ready.signatures };
    try {
      const options = {
        signal: controller.signal,
        nodeCosts: { ...ready.acceptedCosts, ...nodeCostMap(ready.estimate) },
        beforeNode: productionBudget(
          ready.estimate,
          origin.document.settings.budget - (ready.priorSpend ?? 0),
        ),
        onUpdate: (result: NodeRunResult) => applyResult(run, result, origin.id),
      };
      if (ready.resumeRun) {
        await resumeWorkflowRun(run.id, {
          ...options,
          requireExistingOutputs: true,
          redoNodeIds: ready.redoNodeIds,
        });
      } else {
        await runAndSaveWorkflow(ready.workflow, {
          ...options,
          requireDurable: true,
          onRunRecorded: async (id) => {
            run = { ...run, id };
            if (current.current?.id !== origin.id)
              throw new Error(t("Open the original project to resume this production."));
            await edit((previous) => ({
              ...previous,
              document: { ...previous.document, runs: [...previous.document.runs, run] },
            }));
          },
        });
      }
      await writer.current?.flush();
      await resultWrites.current;
      setRunStates((previous) => ({ ...previous, [run.id]: "completed" }));
    } catch (cause) {
      const cancelled = cause instanceof DOMException && cause.name === "AbortError";
      if (!cancelled) {
        const nodeId =
          cause && typeof cause === "object" && "nodeId" in cause ? cause.nodeId : undefined;
        const step = ready.workflow.nodes.find((node) => node.id === nodeId);
        report(
          step
            ? new Error(
                t("{step}: {message}", {
                  step: step.label || t("Generation step"),
                  message: projectError(cause),
                }),
              )
            : cause,
        );
      }
      if (run.id)
        setRunStates((previous) => ({ ...previous, [run.id]: cancelled ? "cancelled" : "failed" }));
    } finally {
      if (abort.current === controller) abort.current = undefined;
      productionBusy.current = false;
      setBusy(false);
      await refreshArtifacts().catch(report);
    }
  };
  const prepareBible = async (entryId: string, role: BibleRole) => {
    const target = current.current;
    const entry = target?.document.bible.find((item) => item.id === entryId);
    if (!target || !entry) return;
    setBusy(true);
    setError("");
    try {
      await writer.current?.flush();
      const version = epoch.current;
      const workflow = compileBibleReference(entry, role, catalog, target.name);
      const estimate = await quoteProject(workflow, catalog);
      if (current.current?.id !== target.id || epoch.current !== version)
        throw new Error(
          t("The project changed while quoting. Review its settings and quote again."),
        );
      setQuote({ projectId: target.id, version, workflow, estimate, signatures: {} });
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const resume = async (run: ProjectRun) => {
    const origin = current.current;
    if (!origin) return;
    const version = epoch.current;
    setBusy(true);
    setError("");
    try {
      await writer.current?.flush();
      const detail = await invoke<{
        run: { definition: string; nodeCosts?: string };
        nodes: Array<{ nodeId: string; status: string; output?: string }>;
      }>("workflow_run_get", { id: run.id });
      const workflow: Workflow = JSON.parse(detail.run.definition);
      const acceptedCosts: Record<string, number> = detail.run.nodeCosts
        ? JSON.parse(detail.run.nodeCosts)
        : {};
      const jobs =
        (await invoke<
          Array<{
            id: string;
            status: string;
            errorStatus?: number | null;
            submissionConfirmed?: boolean;
          }>
        >("media_job_list")) ?? [];
      const failedNodeIds: string[] = [];
      const paidNodeIds = new Set<string>();
      const alreadyPaid = new Set<string>();
      let uncertainRetry = false;
      for (const node of detail.nodes) {
        if (node.status === "done") {
          alreadyPaid.add(node.nodeId);
          continue;
        }
        let stored: { pendingJobId?: unknown; submissionStarted?: unknown };
        try {
          const parsed: unknown = JSON.parse(node.output ?? "{}");
          if (!parsed || typeof parsed !== "object") continue;
          stored = parsed;
        } catch {
          continue;
        }
        if (
          stored.submissionStarted === true &&
          workflow.nodes.some(
            (candidate) =>
              candidate.id === node.nodeId &&
              ["image", "imageEdit", "tts", "music", "video", "chat"].includes(candidate.type),
          )
        ) {
          failedNodeIds.push(node.nodeId);
          paidNodeIds.add(node.nodeId);
          uncertainRetry = true;
          continue;
        }
        const jobId = stored.pendingJobId;
        if (typeof jobId !== "string") continue;
        const job = jobs.find((item) => item.id === jobId);
        if (!job)
          throw new Error(
            t("A paid result is missing. Restore its file or explicitly request a new take."),
          );
        if (job.status !== "failed" || job.submissionConfirmed === true)
          paidNodeIds.add(node.nodeId);
        if (job.status !== "failed") {
          alreadyPaid.add(node.nodeId);
          continue;
        }
        if (job.errorStatus == null && job.submissionConfirmed !== true)
          throw new Error(
            t(
              "A previous request may already have been charged. Check its result before requesting another take.",
            ),
          );
        failedNodeIds.push(node.nodeId);
      }
      const redo = descendantsOf(workflow, failedNodeIds);
      for (const id of redo) alreadyPaid.delete(id);
      const remaining = {
        ...workflow,
        nodes: workflow.nodes.filter((node) => !alreadyPaid.has(node.id)),
        edges: workflow.edges.filter((edge) => !alreadyPaid.has(edge.target)),
      };
      let priorSpend = 0;
      for (const node of workflow.nodes) {
        if (
          (!alreadyPaid.has(node.id) && !paidNodeIds.has(node.id)) ||
          estimateNodeCost(node, catalog).kind === "free"
        )
          continue;
        const cost = acceptedCosts[node.id];
        if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
          throw new Error(t("Price unavailable. Choose another model or try quoting again."));
        priorSpend += cost;
      }
      const estimate = await quoteProject(remaining, catalog);
      if (current.current?.id !== origin.id || epoch.current !== version)
        throw new Error(
          t("The project changed while quoting. Review its settings and quote again."),
        );
      setQuote({
        projectId: origin.id,
        version,
        workflow,
        estimate,
        resumeRun: run,
        redoNodeIds: failedNodeIds,
        uncertainRetry,
        signatures: run.shotSignatures ?? {},
        acceptedCosts,
        priorSpend,
      });
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const addSelectedTakes = async () => {
    const target = current.current;
    if (!target) return;
    setBusy(true);
    try {
      const selected: Array<{
        title: string;
        artifactId: string;
        seconds: number;
        parentId?: string;
        parentHandoffSeconds?: number;
      }> = [];
      for (const shot of target.document.shots) {
        const artifact = artifacts.find((item) => item.id === shot.activeTakeId);
        if (!artifact) continue;
        const seconds = await mediaSeconds(artifactSrc(artifact), "video");
        if (!seconds)
          throw new Error(
            t("A selected take could not be read. Check the file before adding it to the montage."),
          );
        selected.push({
          title: shot.title,
          artifactId: artifact.id,
          seconds,
          parentId: artifact.parentId,
          parentHandoffSeconds: artifact.parentHandoffSeconds,
        });
      }
      if (current.current?.id !== target.id) return;
      await edit((previous) => {
        const timeline = structuredClone(previous.document.timeline);
        const picture = timeline.tracks.find((track) => track.id === "picture");
        if (!picture || picture.locked || picture.hidden)
          throw new Error(t("Unlock and show the picture track before appending takes."));
        const rate = fps(timeline);
        let start = Math.max(
          0,
          ...timeline.clips
            .filter((clip) => clip.trackId === "picture")
            .map((clip) => clip.start + clip.duration),
        );
        for (const [index, item] of selected.entries()) {
          const next = selected[index + 1];
          const handoff = next?.parentHandoffSeconds;
          const outSeconds =
            next?.parentId === item.artifactId &&
            typeof handoff === "number" &&
            Number.isFinite(handoff) &&
            handoff > 0
              ? Math.min(item.seconds, handoff)
              : item.seconds;
          const sourceDuration = Math.max(1, Math.round(item.seconds * rate));
          const duration = Math.max(1, Math.min(sourceDuration, Math.round(outSeconds * rate)));
          timeline.clips.push(
            createEditorClip({
              name: item.title,
              artifactId: item.artifactId,
              trackId: "picture",
              start,
              duration,
              sourceDuration,
            }),
          );
          start += duration;
        }
        return { ...previous, document: { ...previous.document, timeline } };
      });
      setSection("montage");
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const readScript = async () => {
    const origin = current.current;
    if (!origin) return;
    const projectId = origin.id;
    setBusy(true);
    setError("");
    try {
      let noteId = origin.document.readingNoteId;
      if (!noteId) {
        const note = await createNote();
        noteId = note.id;
        try {
          if (current.current?.id !== projectId)
            throw new Error(t("Open the original project to resume this production."));
          await edit((previous) => ({
            ...previous,
            document: { ...previous.document, readingNoteId: note.id },
          }));
        } catch (cause) {
          if (
            current.current?.id === projectId &&
            current.current.document.readingNoteId === note.id
          ) {
            const restored = {
              ...current.current,
              document: { ...current.current.document, readingNoteId: undefined },
            };
            current.current = restored;
            setProject(restored);
          }
          await deleteNotes([note.id]).catch(report);
          throw cause;
        }
      }
      const active = current.current;
      if (!active || active.id !== projectId)
        throw new Error(t("Open the original project to resume this production."));
      await updateNote({
        noteId,
        title: active.name,
        editedContent: active.document.script,
      });
      await acceptReading(await buildShotList(noteId));
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const media = artifacts.map((artifact) => ({
    ...artifact,
    projectIds: [
      ...new Set([
        ...(artifact.projectIds ?? []),
        ...(project?.document.artifactIds.includes(artifact.id) ? [project.id] : []),
      ]),
    ],
  }));
  const mediaEditor = (
    <ProjectMedia
      artifacts={media}
      projects={projects}
      projectId={project?.id}
      readOnly={busy || mediaSaving || exporting}
      onMetadata={async (artifact, title, projectIds) => {
        if (busy) throw new Error(t("Wait for production to finish before editing media."));
        if (exportingRef.current)
          throw new Error(t("Wait for montage export to finish before editing media."));
        const projectId = current.current?.id;
        const version = epoch.current;
        setMediaSaving(true);
        try {
          await writer.current?.flush();
          if (sameProjectMembership(projectIds, artifact.projectIds ?? [])) {
            await saveArtifactMetadata({ id: artifact.id, title });
          } else {
            await organizeArtifact({
              id: artifact.id,
              title,
              projectIds,
              expectedProjectIds: artifact.projectIds ?? [],
            });
          }
          if (projectId && current.current?.id === projectId && epoch.current === version) {
            const reloaded = await getProject(projectId);
            if (reloaded && current.current?.id === projectId && epoch.current === version) {
              current.current = reloaded;
              writer.current = new ProjectWriter(reloaded);
              setProject(reloaded);
              setSaved(true);
            }
          }
          await refreshArtifacts();
        } catch (cause) {
          if (String(cause).includes("studio_project_conflict"))
            await refreshArtifacts().catch(() => undefined);
          throw cause;
        } finally {
          setMediaSaving(false);
        }
      }}
    />
  );
  const timelineEpoch = epoch.current;
  return (
    <div className="project-studio">
      {error ? (
        <div className="project-error" role="alert">
          <p>{error}</p>
          {project && !saved ? (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void retrySave().catch(report)}
              >
                {t("Retry save")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  const request = ++openRequest.current;
                  const version = epoch.current;
                  const sourceId = project.id;
                  const copy = {
                    ...structuredClone(project),
                    id: crypto.randomUUID(),
                    revision: 0,
                    name: t("{name} copy", { name: project.name }),
                    document: {
                      ...structuredClone(project.document),
                      runs: [],
                      readingNoteId: undefined,
                    },
                  };
                  void saveProject(copy, null)
                    .then(async (stored) => {
                      if (
                        request !== openRequest.current ||
                        version !== epoch.current ||
                        current.current?.id !== sourceId
                      )
                        return;
                      writer.current = undefined;
                      await open(stored, request);
                    })
                    .catch(report);
                }}
              >
                {t("Save a copy")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setReopenConfirm(true)}
              >
                {t("Reopen saved version")}
              </button>
            </>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={() => setError("")}>
            {t("Dismiss")}
          </button>
        </div>
      ) : null}
      {!project ? (
        <>
          <header className="project-home-header">
            <div>
              <h2>{t("Your film projects")}</h2>
              <p>{t("From the first idea to the final cut, keep everything together.")}</p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void create().catch(report)}
            >
              {t("New project")}
            </button>
          </header>
          <div className="project-actions">
            <input
              className="studio-input"
              placeholder={t("Search projects")}
              aria-label={t("Search projects")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label>
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />
              {t("Show archived")}
            </label>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setLibrary(!library)}
            >
              {t("Media library")}
            </button>
          </div>
          {library ? (
            mediaEditor
          ) : (
            <div className="project-cards">
              {projects
                .filter(
                  (item) =>
                    (!item.archived || archived) &&
                    item.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((item) => (
                  <article key={item.id} className="project-card">
                    <button
                      type="button"
                      className="project-card-open"
                      onClick={() => {
                        const request = ++openRequest.current;
                        const version = epoch.current;
                        void getProject(item.id)
                          .then(async (value) => {
                            if (
                              value &&
                              request === openRequest.current &&
                              version === epoch.current
                            )
                              await open(value, request);
                          })
                          .catch(report);
                      }}
                    >
                      <span className="project-card-mark">{t("Film")}</span>
                      <h3>{item.name}</h3>
                      <small>{new Date(item.updatedAt).toLocaleDateString(intlLocale())}</small>
                    </button>
                    <div className="project-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          const request = ++openRequest.current;
                          const version = epoch.current;
                          void getProject(item.id)
                            .then(async (value) => {
                              if (
                                value &&
                                request === openRequest.current &&
                                version === epoch.current
                              )
                                await create(value, request);
                            })
                            .catch(report);
                        }}
                      >
                        {t("Duplicate")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() =>
                          void getProject(item.id)
                            .then(async (value) => {
                              if (value) await saveProject({ ...value, archived: !value.archived });
                              setProjects(await listProjects());
                            })
                            .catch(report)
                        }
                      >
                        {item.archived ? t("Restore") : t("Archive")}
                      </button>
                    </div>
                  </article>
                ))}
              {!projects.length ? (
                <div className="project-empty">
                  <h3>{t("Your next film starts with a project")}</h3>
                  <p>
                    {t(
                      "Write a script, prepare your cast and generate shots you can refine individually.",
                    )}
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : (
        <>
          <header className="project-toolbar">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || mediaSaving || exporting}
              onClick={() => void back().catch(report)}
            >
              {t("All projects")}
            </button>
            <input
              key={`${project.id}:${openSession}`}
              aria-label={t("Project name")}
              defaultValue={project.name}
              disabled={busy || mediaSaving || exporting}
              onBlur={(event) => {
                const name = event.target.value.trim() || t("Untitled project");
                event.target.value = name;
                void edit((previous) => ({ ...previous, name })).catch(() => undefined);
              }}
            />
            <span role="status" className="project-save-state">
              {saved ? t("Saved") : t("Saving...")}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || mediaSaving || exporting || !project.document.shots.length}
              onClick={() => void prepare()}
            >
              {t("Quote production")}
            </button>
          </header>
          <nav className="project-navigation" aria-label={t("Project sections")}>
            {(
              [
                ["script", t("Script")],
                ["shots", t("Shots")],
                ["bible", t("Bible")],
                ["media", t("Media")],
                ["montage", t("Montage")],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-current={section === key ? "page" : undefined}
                disabled={mediaSaving || exporting || (busy && key === "media")}
                onClick={() => setSection(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {busy ? (
            <div className="project-run-status" role="status">
              <span>{t("Production in progress")}</span>
              <span>
                {t("{count} steps completed", {
                  count: Object.values(progress).filter((result) => result.status === "done")
                    .length,
                })}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => abort.current?.abort()}
              >
                {t("Pause after queued work")}
              </button>
            </div>
          ) : null}
          {project.document.runs
            .filter(
              (run) =>
                ["running", "failed", "cancelled"].includes(runStates[run.id]) &&
                !activeWorkflowRuns().some((live) => live.id === run.id),
            )
            .map((run) => (
              <div className="project-run-status" key={run.id}>
                <span>{t("A production needs your attention. Finished takes are preserved.")}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void resume(run)}
                >
                  {t("Resume production")}
                </button>
              </div>
            ))}
          {section === "script" ? (
            <div className="project-script">
              <section className="project-panel">
                <h2>{t("Script")}</h2>
                <textarea
                  aria-label={t("Film script")}
                  rows={18}
                  value={project.document.script}
                  disabled={busy || reading}
                  onChange={(event) =>
                    editDocument((document) => ({ ...document, script: event.target.value }))
                  }
                  placeholder={t("Describe your film, its characters and what happens.")}
                />
                <div className="project-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || reading}
                    onClick={() => setNotePicker(true)}
                  >
                    {t("From your notes")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={
                      busy ||
                      reading ||
                      !project.document.script.trim() ||
                      project.document.shots.length > 0
                    }
                    onClick={() => void readScript()}
                  >
                    {reading ? t("Reading your script...") : t("Break into shots")}
                  </button>
                </div>
                {project.document.shots.length ? (
                  <p className="project-muted">
                    {t(
                      "Your shot list is editable in Shots. Script changes do not overwrite your work.",
                    )}
                  </p>
                ) : null}
              </section>
              <aside className="project-panel">
                <h2>{t("Project settings")}</h2>
                <label className="project-field">
                  {t("Aspect ratio")}
                  <select
                    value={project.document.settings.aspectRatio}
                    onChange={(event) =>
                      editDocument((document) => ({
                        ...document,
                        settings: { ...document.settings, aspectRatio: event.target.value },
                      }))
                    }
                  >
                    {["16:9", "9:16", "1:1", "4:3", "21:9"].map((ratio) => (
                      <option key={ratio}>{ratio}</option>
                    ))}
                  </select>
                </label>
                <MediaModelPicker
                  value={project.document.settings.videoModelId}
                  options={catalog.models
                    .filter(
                      (model) =>
                        !model.offline &&
                        ["video", "imageToVideo", "referenceToVideo"].includes(model.mediaType),
                    )
                    .map(mediaModelOption)}
                  ariaLabel={t("Default video model")}
                  onChange={(videoModelId) =>
                    editDocument((document) => ({
                      ...document,
                      settings: { ...document.settings, videoModelId },
                    }))
                  }
                />
                <MediaModelPicker
                  value={project.document.settings.ttsModelId}
                  options={modelsOfType(catalog, "tts").map(mediaModelOption)}
                  ariaLabel={t("Dialogue model")}
                  onChange={(ttsModelId) =>
                    editDocument((document) => ({
                      ...document,
                      settings: { ...document.settings, ttsModelId },
                    }))
                  }
                />
                <label className="project-field">
                  {t("Spend ceiling")}
                  <input
                    type="number"
                    min={0}
                    value={project.document.settings.budget}
                    onChange={(event) => {
                      const budget = Number(event.target.value);
                      if (Number.isFinite(budget))
                        editDocument((document) => ({
                          ...document,
                          settings: { ...document.settings, budget },
                        }));
                    }}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={project.document.settings.withScore}
                    onChange={(event) =>
                      editDocument((document) => ({
                        ...document,
                        settings: { ...document.settings, withScore: event.target.checked },
                      }))
                    }
                  />
                  {t("Generate a musical score")}
                </label>
                {project.document.settings.withScore ? (
                  <MediaModelPicker
                    value={project.document.settings.musicModelId}
                    options={modelsOfType(catalog, "music").map(mediaModelOption)}
                    ariaLabel={t("Music model")}
                    onChange={(musicModelId) =>
                      editDocument((document) => ({
                        ...document,
                        settings: { ...document.settings, musicModelId },
                      }))
                    }
                  />
                ) : null}
              </aside>
            </div>
          ) : null}
          {section === "shots" ? (
            <ProjectShots
              key={`${project.id}:${openSession}`}
              document={project.document}
              onChange={(shots) => {
                if (current.current?.id !== project.id || !writer.current) return;
                const referenced = shots
                  .flatMap((shot) => [
                    shot.openingArtifactId,
                    shot.endingArtifactId,
                    ...(shot.imageReferenceIds ?? []),
                    ...(shot.referenceArtifactIds ?? []),
                  ])
                  .filter((id): id is string => Boolean(id));
                const added = referenced.filter(
                  (id) => !current.current?.document.artifactIds.includes(id),
                );
                void edit((previous) => ({
                  ...previous,
                  document: {
                    ...previous.document,
                    shots,
                    artifactIds: [...new Set([...previous.document.artifactIds, ...referenced])],
                  },
                }))
                  .then(async () => {
                    for (const id of new Set(added)) await attachArtifactMetadata(id, project.id);
                  })
                  .catch(report);
              }}
              artifacts={media}
              catalog={catalog}
              onGenerate={(id) => void prepare(id)}
              onImage={(id) => void prepare(id, true)}
              onBible={() => setSection("bible")}
              busy={busy || exporting}
            />
          ) : null}
          {section === "bible" ? (
            <ProjectBible
              entries={project.document.bible}
              onChange={(bible) =>
                editDocument((document) => {
                  const renamed = new Map(
                    document.bible.flatMap((entry) => {
                      const next = bible.find((item) => item.id === entry.id);
                      return next && next.name !== entry.name
                        ? [[entry.name.trim().toLowerCase(), next.name] as const]
                        : [];
                    }),
                  );
                  const renamedName = (name: string) =>
                    renamed.get(name.trim().toLowerCase()) ?? name;
                  return {
                    ...document,
                    bible,
                    shots: document.shots.map((shot) => ({
                      ...shot,
                      characters: shot.characters.map(renamedName),
                      location: renamedName(shot.location),
                      speaker: renamedName(shot.speaker),
                    })),
                  };
                })
              }
              artifacts={media}
              catalog={catalog}
              onArtifact={addArtifact}
              onGenerate={(id, role) => void prepareBible(id, role)}
              busy={busy || exporting}
            />
          ) : null}
          {section === "media" ? mediaEditor : null}
          {section === "montage" ? (
            <>
              <div className="project-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={
                    busy || exporting || !project.document.shots.some((shot) => shot.activeTakeId)
                  }
                  onClick={() => void addSelectedTakes()}
                >
                  {t("Append selected takes")}
                </button>
                <span className="project-muted">
                  {t("Existing montage clips stay unchanged when you select another take.")}
                </span>
              </div>
              <ProjectTimeline
                key={`${project.id}:${openSession}`}
                value={project.document.timeline}
                exportDisabled={busy || mediaSaving || exporting}
                onExportStart={() => {
                  if (productionBusy.current || busy || mediaSaving || exportingRef.current)
                    return false;
                  exportingRef.current = true;
                  setExporting(true);
                  return true;
                }}
                onExportEnd={() => {
                  exportingRef.current = false;
                  setExporting(false);
                }}
                onChange={(timeline) => {
                  if (
                    exportingRef.current ||
                    current.current?.id !== project.id ||
                    epoch.current !== timelineEpoch
                  )
                    return;
                  editDocument((document) => ({ ...document, timeline }));
                }}
                artifacts={montageArtifacts(project, media)}
                onExportArtifact={async (artifact) => {
                  if (productionBusy.current)
                    throw new Error(t("Wait for production to finish before editing media."));
                  const version = epoch.current;
                  const ownerWriter = writer.current;
                  if (current.current?.id === project.id) await ownerWriter?.flush();
                  if (productionBusy.current)
                    throw new Error(t("Wait for production to finish before editing media."));
                  const metadata = (await listArtifactMetadata()).find(
                    (item) => item.id === artifact.id,
                  );
                  if (productionBusy.current)
                    throw new Error(t("Wait for production to finish before editing media."));
                  const memberships = [
                    ...new Set([...(metadata?.projectIds ?? []), ...(artifact.projectIds ?? [])]),
                  ];
                  await organizeArtifact({
                    id: artifact.id,
                    title: metadata?.title ?? "",
                    expectedProjectIds: memberships,
                    projectIds: [...new Set([...memberships, project.id])],
                  });
                  if (
                    current.current?.id === project.id &&
                    epoch.current === version &&
                    writer.current === ownerWriter
                  ) {
                    const updated = await getProject(project.id);
                    if (
                      updated &&
                      current.current?.id === project.id &&
                      epoch.current === version &&
                      writer.current === ownerWriter
                    ) {
                      current.current = updated;
                      writer.current = new ProjectWriter(updated);
                      setProject(updated);
                      setSaved(true);
                    }
                  }
                  await refreshArtifacts();
                }}
              />
            </>
          ) : null}
        </>
      )}
      {notePicker ? (
        <NotePicker
          onClose={() => setNotePicker(false)}
          onPick={(note) => {
            const projectId = current.current?.id;
            const version = epoch.current;
            setNotePicker(false);
            if (!projectId) return;
            void getNote(note.id)
              .then((full) => {
                if (current.current?.id !== projectId || epoch.current !== version) return;
                editDocument((document) => ({
                  ...document,
                  noteId: note.id,
                  readingNoteId: undefined,
                  script: full.editedContent ?? full.generatedContent ?? "",
                }));
              })
              .catch((cause) => {
                if (current.current?.id === projectId && epoch.current === version) report(cause);
              });
          }}
        />
      ) : null}
      {quote ? (
        <Dialog
          open
          onClose={() => setQuote(undefined)}
          title={t("Review generation costs")}
          description={t(
            "Only the steps listed here will be generated. Your existing takes remain available.",
          )}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setQuote(undefined)}
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  quote.estimate.metered > 0 ||
                  quote.estimate.credits + (quote.priorSpend ?? 0) >
                    (project?.document.settings.budget ?? 0)
                }
                onClick={() => void produce(quote)}
              >
                {t("Generate · {credits} credits", {
                  credits: quoteCredits(quote.estimate.credits),
                })}
              </button>
            </>
          }
        >
          <div className="dialog-body">
            {quote.notes?.map((note) => (
              <p className="project-warning" key={note}>
                {note}
              </p>
            ))}
            {quote.uncertainRetry ? (
              <p className="project-warning">
                {t(
                  "A previous request may already have been charged. Check your provider history before confirming this new quote.",
                )}
              </p>
            ) : null}
            {quote.estimate.nodes
              .filter((node) => node.kind !== "free")
              .map((node) => (
                <div className="project-quote-row" key={node.nodeId}>
                  <span>{node.label}</span>
                  <strong>
                    {node.credits === undefined
                      ? t("Price unavailable")
                      : t("{credits} credits", { credits: quoteCredits(node.credits) })}
                  </strong>
                </div>
              ))}
            {quote.estimate.metered > 0 ? (
              <p className="project-warning">
                {t(
                  "Some prices are unavailable. Choose another model or try quoting again before generating.",
                )}
              </p>
            ) : null}
            {quote.estimate.credits + (quote.priorSpend ?? 0) >
            (project?.document.settings.budget ?? 0) ? (
              <p className="project-error">{t("This generation exceeds the spend ceiling.")}</p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
      {reopenConfirm ? (
        <Dialog
          open
          onClose={() => setReopenConfirm(false)}
          title={t("Reopen the saved version?")}
          description={t(
            "Your unsaved edits in this window will be lost. Save a copy first if you want to keep them.",
          )}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setReopenConfirm(false)}
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void reopenSaved().catch(report)}
              >
                {t("Reopen saved version")}
              </button>
            </>
          }
        >
          <div className="dialog-body" />
        </Dialog>
      ) : null}
    </div>
  );
}
