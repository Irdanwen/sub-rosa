import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { messageFromError } from "../errors";
import { getNote, listFilms, shotList } from "../tauri";
import { listBibleEntries, type BibleEntry } from "./bible";
import type { Workflow, WorkflowNode } from "./workflow/schema";
import type { WorkflowRunSummary } from "./workflow-run";
import type { StudioArtifact } from "./types";
import type { Shot } from "./workflow/compile";
import { createEditorDocument, type EditorDocument } from "./editor/document";

export interface ProjectShot extends Shot {
  id: string;
  title: string;
  mode: "text" | "image" | "reference" | "continuation";
  imagePrompt: string;
  imageModelId: string;
  imageReferenceIds: string[];
  imageCandidates: string[];
  takeIds: string[];
  activeTakeId?: string;
  renderedSignature?: string;
}
export interface ProjectBibleEntry extends BibleEntry {
  originId?: string;
  imageModelId?: string;
  imagePrompt?: string;
}
export interface ProjectRun {
  id: string;
  shotSignatures: Record<string, string>;
  /** Finished outputs already integrated into this project's document. A
   * gallery removal does not make a replayed run add them back on reopen. */
  appliedNodeIds?: string[];
}
export interface ProjectDocument {
  schemaVersion: 1;
  /** Source note, copied into this project's script but never edited by Studio. */
  noteId?: string;
  /** Studio-owned note used only to run the durable script reader. */
  readingNoteId?: string;
  script: string;
  shots: ProjectShot[];
  bible: ProjectBibleEntry[];
  artifactIds: string[];
  runs: ProjectRun[];
  settings: {
    aspectRatio: string;
    videoModelId: string;
    ttsModelId: string;
    musicModelId: string;
    budget: number;
    withScore: boolean;
  };
  timeline: EditorDocument;
}
export interface ProjectSummary {
  id: string;
  name: string;
  archived: boolean;
  revision: number;
  updatedAt: string;
}
export interface StudioProject extends ProjectSummary {
  document: ProjectDocument;
}
/** Match the native studio_project.rs document limit before changing the visible draft. */
export function projectDocumentFits(document: ProjectDocument): boolean {
  return new TextEncoder().encode(JSON.stringify(document)).byteLength <= 8 * 1024 * 1024;
}
export interface ArtifactMetadata {
  id: string;
  title: string;
  projectIds: string[];
  generation?: Partial<StudioArtifact>;
}

export const listProjects = () => invoke<ProjectSummary[]>("studio_project_list");
export const getProject = (id: string) =>
  invoke<StudioProject | null>("studio_project_get", { id });
export const listArtifactMetadata = () => invoke<ArtifactMetadata[]>("studio_artifact_list");
export const saveArtifactMetadata = (
  request: Pick<ArtifactMetadata, "id"> & Partial<Omit<ArtifactMetadata, "id">>,
) => invoke<ArtifactMetadata>("studio_artifact_save", { request });
export function sameProjectMembership(left: string[], right: string[]): boolean {
  const ids = new Set(left);
  return ids.size === new Set(right).size && right.every((id) => ids.has(id));
}
/** The native transaction updates project documents and gallery metadata together. */
export function organizeArtifact(
  request: Pick<ArtifactMetadata, "id" | "title" | "projectIds"> & {
    expectedProjectIds: string[];
  },
): Promise<ArtifactMetadata> {
  return invoke<ArtifactMetadata>("studio_artifact_organize", { request });
}
export function saveProject(
  project: StudioProject,
  expectedRevision: number | null = project.revision,
) {
  return invoke<StudioProject>("studio_project_save", {
    request: {
      id: project.id,
      name: project.name,
      archived: project.archived,
      document: project.document,
      expectedRevision,
    },
  });
}
export function newShot(index: number): ProjectShot {
  return {
    id: crypto.randomUUID(),
    title: t("Shot {number}", { number: index + 1 }),
    scene: "",
    action: "",
    camera: "",
    characters: [],
    location: "",
    dialogue: "",
    speaker: "",
    motion: "medium",
    continues: false,
    mode: "text",
    imagePrompt: "",
    imageModelId: "",
    imageReferenceIds: [],
    imageCandidates: [],
    takeIds: [],
  };
}
export function newProject(name = t("Untitled project")): StudioProject {
  return {
    id: crypto.randomUUID(),
    name,
    archived: false,
    revision: 0,
    updatedAt: new Date().toISOString(),
    document: {
      schemaVersion: 1,
      script: "",
      shots: [],
      bible: [],
      artifactIds: [],
      runs: [],
      settings: {
        aspectRatio: "16:9",
        videoModelId: "",
        ttsModelId: "",
        musicModelId: "",
        budget: 200,
        withScore: false,
      },
      timeline: createEditorDocument(),
    },
  };
}
/** A cut keeps its on-disk media even after it is removed from the project's
 * gallery membership. The timeline needs those files for playback and export. */
export function montageArtifacts(
  project: StudioProject,
  artifacts: readonly StudioArtifact[],
): StudioArtifact[] {
  const referenced = new Set(
    project.document.timeline.clips.map((clip) => clip.artifactId).filter((id) => !!id),
  );
  return artifacts.filter(
    (artifact) => artifact.projectIds?.includes(project.id) || referenced.has(artifact.id),
  );
}
export function shotSignature(shot: ProjectShot, project: ProjectDocument): string {
  const {
    takeIds: _takes,
    activeTakeId: _active,
    renderedSignature: _signature,
    imageCandidates: _images,
    ...input
  } = shot;
  const previous =
    shot.mode === "continuation"
      ? project.shots[project.shots.findIndex((candidate) => candidate.id === shot.id) - 1]
      : undefined;
  return JSON.stringify({
    input,
    settings: project.settings,
    bible: project.bible,
    ...(shot.mode === "continuation"
      ? { predecessor: { id: previous?.id, activeTakeId: previous?.activeTakeId } }
      : {}),
  });
}
export function projectError(error: unknown): string {
  const message = messageFromError(error);
  if (message.includes("studio_project_conflict"))
    return t(
      "This project changed in another window. Your edits are kept here. Save a copy or reopen the project.",
    );
  if (message.includes("studio_project_"))
    return t("Your project could not be saved. Keep this window open and try again.");
  return message;
}

export function artifactError(error: unknown): string {
  const message = messageFromError(error);
  if (message.includes("studio_project_conflict"))
    return t("This media changed in another window. Review its projects and save again.");
  return projectError(error);
}

/** Serial writes always use the revision returned by the preceding write. */
export class ProjectWriter {
  private revision: number;
  private pending: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  constructor(project: StudioProject) {
    this.revision = project.revision;
  }
  save(project: StudioProject): Promise<StudioProject> {
    const snapshot = structuredClone(project);
    // Saves already queued before a failure must not replay out of order.
    // A later edit is an explicit retry with the full current document.
    const retryAfterFailure = this.failure !== undefined;
    const next = this.pending.then(async () => {
      if (this.failure !== undefined && !retryAfterFailure) throw this.failure;
      try {
        const saved = await saveProject(snapshot, this.revision);
        this.revision = saved.revision;
        this.failure = undefined;
        return saved;
      } catch (error) {
        this.failure = error;
        throw error;
      }
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
  async flush(retry?: StudioProject) {
    await this.pending;
    if (this.failure !== undefined && retry) await this.save(retry);
    if (this.failure !== undefined) throw this.failure;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Copies have independent identities and arrays; their files stay shared. */
export function copyProjectBible(
  entries: readonly BibleEntry[],
  projectId: string,
): ProjectBibleEntry[] {
  return entries.map((entry) => {
    const id = `${projectId}-bible-${entry.id}`;
    return {
      ...structuredClone(entry),
      id,
      originId: entry.id,
      refs: entry.refs.map((ref) => ({ ...ref, id: `${id}-${ref.id}`, entryId: id })),
    };
  });
}

function referencedBible(
  shots: readonly ProjectShot[],
  bible: readonly BibleEntry[],
): BibleEntry[] {
  const names = new Set(
    shots
      .flatMap((shot) => [...shot.characters, shot.location, shot.speaker])
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  return bible.filter((entry) => names.has(entry.name.trim().toLowerCase()));
}

function readLegacyShot(value: unknown, id: string, index: number): ProjectShot | undefined {
  if (!object(value) || typeof value.action !== "string") return undefined;
  const shot = newShot(index);
  for (const field of [
    "scene",
    "action",
    "camera",
    "location",
    "dialogue",
    "speaker",
    "motion",
  ] as const) {
    if (typeof value[field] === "string") shot[field] = value[field];
  }
  shot.characters = Array.isArray(value.characters)
    ? value.characters.filter((name): name is string => typeof name === "string")
    : [];
  for (const field of [
    "title",
    "prompt",
    "modelId",
    "resolution",
    "openingArtifactId",
    "endingArtifactId",
  ] as const) {
    if (typeof value[field] === "string") shot[field] = value[field];
  }
  if (typeof value.duration === "string" || typeof value.duration === "number")
    shot.duration = value.duration;
  if (Array.isArray(value.referenceArtifactIds))
    shot.referenceArtifactIds = value.referenceArtifactIds.filter(
      (ref): ref is string => typeof ref === "string",
    );
  shot.id = id;
  shot.continues = value.continues === true;
  shot.mode =
    value.mode === "image" ||
    value.mode === "reference" ||
    value.mode === "continuation" ||
    value.mode === "text"
      ? value.mode
      : shot.continues
        ? "continuation"
        : "text";
  return shot;
}

async function saveImportedProject(project: StudioProject): Promise<void> {
  try {
    await saveProject(project, null);
  } catch (error) {
    if (!String(error).includes("studio_project_conflict")) throw error;
  }
}

/** Deterministic IDs make migration safe to repeat after interruption. */
export async function importLegacyFilms(): Promise<void> {
  const [films, bible] = await Promise.all([listFilms(), listBibleEntries()]);
  for (const film of films) {
    const id = `legacy-film-${film.noteId}`;
    if (await getProject(id)) continue;
    const row = await shotList(film.noteId);
    const parsed = parseJson(row?.shotsJson ?? undefined);
    const shots = Array.isArray(parsed) ? parsed : object(parsed) ? parsed.shots : undefined;
    if (!Array.isArray(shots)) continue;
    const recovered = shots.flatMap((shot, index) => {
      const value = readLegacyShot(shot, `${id}-${index}`, index);
      return value ? [value] : [];
    });
    if (!recovered.length) continue;
    const project = newProject(film.title);
    project.id = id;
    project.document.noteId = film.noteId;
    const note = await getNote(film.noteId).catch(() => undefined);
    project.document.script = note?.editedContent ?? note?.generatedContent ?? "";
    project.document.shots = recovered;
    project.document.bible = copyProjectBible(referencedBible(recovered, bible), id);
    project.document.artifactIds = [
      ...new Set(
        project.document.bible.flatMap((entry) => entry.refs.map((ref) => ref.artifactId)),
      ),
    ];
    await saveImportedProject(project);
  }
  await importLegacyProductions(bible);
}

interface LegacyRunNode {
  nodeId: string;
  status: string;
  output?: string;
}
interface LegacyOutput {
  kind: string;
  artifactId: string;
}

function validWorkflow(value: unknown): value is Workflow {
  return (
    object(value) &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    value.nodes.every(
      (node) =>
        object(node) &&
        typeof node.id === "string" &&
        typeof node.type === "string" &&
        object(node.params),
    ) &&
    value.edges.every(
      (edge) => object(edge) && typeof edge.source === "string" && typeof edge.target === "string",
    )
  );
}

function restoredShot(
  node: WorkflowNode,
  workflow: Workflow,
  output: LegacyOutput | undefined,
  index: number,
): ProjectShot {
  const shot = newShot(index);
  // Keep compiler node ids compatible with restoreRun: shot-${shot.id}.
  shot.id = node.id.slice("shot-".length);
  shot.title = node.label || shot.title;
  shot.prompt = typeof node.params.prompt === "string" ? node.params.prompt : "";
  shot.action = shot.prompt;
  shot.modelId = typeof node.params.model === "string" ? node.params.model : "";
  if (typeof node.params.duration === "string" || typeof node.params.duration === "number")
    shot.duration = node.params.duration;
  if (typeof node.params.resolution === "string") shot.resolution = node.params.resolution;
  const inputs = workflow.edges.filter((edge) => edge.target === node.id);
  const opening = inputs.find((edge) => edge.targetPort === "openingFrame");
  const source = workflow.nodes.find((candidate) => candidate.id === opening?.source);
  const assetIds = (port: string) =>
    inputs
      .filter((edge) => edge.targetPort === port)
      .flatMap((edge) => {
        const input = workflow.nodes.find((candidate) => candidate.id === edge.source);
        return input?.type === "asset" && typeof input.params.artifactId === "string"
          ? [input.params.artifactId]
          : [];
      });
  shot.referenceArtifactIds = assetIds("references");
  shot.openingArtifactId = assetIds("openingFrame")[0];
  shot.endingArtifactId = assetIds("endFrame")[0];
  shot.mode =
    source?.type === "lastFrame"
      ? "continuation"
      : opening
        ? "image"
        : shot.referenceArtifactIds.length || node.params.modelDirection === "reference"
          ? "reference"
          : node.params.modelDirection === "image"
            ? "image"
            : "text";
  shot.continues = shot.mode === "continuation";
  const line = workflow.nodes.find((candidate) => candidate.id === `line-${shot.id}`);
  if (typeof line?.params.text === "string") shot.dialogue = line.params.text;
  if (output?.kind === "video") {
    shot.takeIds = [output.artifactId];
    shot.activeTakeId = output.artifactId;
  }
  return shot;
}

/** Recover frozen compiled productions, never execute them during migration. */
async function importLegacyProductions(bible: readonly BibleEntry[]): Promise<void> {
  const runs = await invoke<WorkflowRunSummary[]>("workflow_run_list");
  if (!Array.isArray(runs)) return;
  for (const run of runs) {
    const id = `legacy-run-${run.id}`;
    if (await getProject(id)) continue;
    const workflow = parseJson(run.definition);
    if (!validWorkflow(workflow) || !workflow.nodes.some((node) => node.type === "assemble"))
      continue;
    const videoNodes = workflow.nodes.filter(
      (node) => node.type === "video" && node.id.startsWith("shot-"),
    );
    if (!videoNodes.length) continue;
    const detail = await invoke<{ nodes: LegacyRunNode[] }>("workflow_run_get", { id: run.id });
    const outputs = new Map<string, LegacyOutput>();
    for (const node of detail.nodes) {
      const output = parseJson(node.output);
      if (
        node.status === "done" &&
        object(output) &&
        typeof output.kind === "string" &&
        typeof output.artifactId === "string"
      ) {
        outputs.set(node.nodeId, { kind: output.kind, artifactId: output.artifactId });
      }
    }
    const project = newProject(run.name);
    project.id = id;
    project.document.shots = videoNodes.map((node, index) =>
      restoredShot(node, workflow, outputs.get(node.id), index),
    );
    const referenceIds = new Set(
      workflow.nodes.flatMap((node) =>
        node.type === "asset" && typeof node.params.artifactId === "string"
          ? [node.params.artifactId]
          : [],
      ),
    );
    project.document.bible = copyProjectBible(
      bible.filter((entry) => entry.refs.some((ref) => referenceIds.has(ref.artifactId))),
      id,
    );
    project.document.artifactIds = [
      ...new Set([
        ...referenceIds,
        ...[...outputs.values()].map((output) => output.artifactId),
        ...project.document.bible.flatMap((entry) => entry.refs.map((ref) => ref.artifactId)),
      ]),
    ];
    project.document.runs = [
      {
        id: run.id,
        shotSignatures: {},
        appliedNodeIds: detail.nodes
          .filter((node) => node.status === "done")
          .map((node) => node.nodeId),
      },
    ];
    await saveImportedProject(project);
  }
}
