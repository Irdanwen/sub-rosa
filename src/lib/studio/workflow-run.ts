// The workflow engine's storage, backed by the Studio gallery, plus the
// durable run machinery both shells share (ADR-0021). The engine itself is
// storage-agnostic (it only produces typed node outputs); this file is the
// one place that knows where produced media lands (the gallery), where
// referenced media comes from (the gallery, notes), which URL scheme this
// platform's webview can actually decode (asset protocol on desktop, blob/data
// URLs on iOS — the asset protocol does not resolve there), and how a run's
// state persists so a kill or a suspension loses nothing:
//
// - the run and its per-node state are rows (`workflow_runs`), written before
//   the work they describe;
// - video and music renders ride the durable `media_jobs` (Rust polls them
//   with or without a webview), and a running node records its job id so a
//   resume re-attaches instead of re-queueing a paid render;
// - finished nodes persist a *dehydrated* output (artifact references and
//   small payloads), and a resume replays them through the engine's
//   `completed` cache instead of re-spending.

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { artifactDataUrl } from "../artifact-media";
import { isMobilePlatform } from "../mobile";
import { ensureNotificationPermission } from "../notifications";
import { getNote } from "../tauri";
import {
  artifactSrc,
  listArtifacts,
  readArtifactBase64,
  registerDownloadedArtifact,
  saveArtifactFromBase64,
  saveArtifactFromUrl,
} from "./artifacts";
import type { ArtifactFile, StudioArtifact } from "./types";
import { waitForSettledJob, withSubmissionSlot } from "./workflow/render-wait";
import { TRANSIENT_WAIT_BUDGET_MS, transientDelays } from "./workflow/transient";
import {
  awaitingGateIds,
  type ChainRef,
  type DurableRenderRequest,
  type LoadedAsset,
  maybeNodeSchema,
  type NodeOutput,
  type NodeRunResult,
  runWorkflow,
  type RunWorkflowOptions,
  type SavedMedia,
  type SaveMediaMeta,
  type StepCache,
  type Workflow,
  type WorkflowStorage,
} from "./workflow";

async function decodableSrc(artifact: StudioArtifact): Promise<string> {
  return isMobilePlatform() ? artifactDataUrl(artifact) : artifactSrc(artifact);
}

function assetKindOf(artifact: StudioArtifact): LoadedAsset["kind"] {
  if (artifact.kind === "image") return "image";
  if (artifact.kind === "video") return "video";
  return "audio";
}

async function save(
  payload: { base64?: string; url?: string },
  extension: string,
  meta: SaveMediaMeta,
): Promise<SavedMedia> {
  const artifact =
    payload.url !== undefined
      ? await saveArtifactFromUrl(payload.url, extension, meta)
      : await saveArtifactFromBase64(payload.base64 ?? "", extension, meta);
  return {
    artifactId: artifact.id,
    src: await decodableSrc(artifact),
    mimeType: mimeForFile(artifact.fileName),
  };
}

/** How long one gallery listing answers lookups. A run with many inputs (or
 * many reused steps) used to list the whole gallery once per lookup. */
const LISTING_TTL_MS = 10_000;
let listing: Promise<StudioArtifact[]> | undefined;
let listedAt = 0;

/** A gallery item by id, from a recent listing; a miss lists again once, so
 * a file filed a moment ago is never reported gone. */
async function findArtifact(artifactId: string): Promise<StudioArtifact | undefined> {
  const stale = !listing || Date.now() - listedAt > LISTING_TTL_MS;
  if (stale) {
    listing = listArtifacts();
    listedAt = Date.now();
  }
  const found = (await (listing as Promise<StudioArtifact[]>)).find(
    (entry) => entry.id === artifactId,
  );
  if (found || stale) return found;
  listing = listArtifacts();
  listedAt = Date.now();
  return (await listing).find((entry) => entry.id === artifactId);
}

async function loadAsset(artifactId: string): Promise<LoadedAsset> {
  const artifact = await findArtifact(artifactId);
  if (!artifact) {
    throw new Error(t("That gallery item is gone. Pick another one."));
  }
  const kind = assetKindOf(artifact);
  if (kind === "image") {
    // Images travel as bytes so they can feed generation inputs; the data URL
    // reader derives the real mime rather than assuming PNG.
    const dataUrl = await artifactDataUrl(artifact);
    const comma = dataUrl.indexOf(",");
    const mimeType = dataUrl.slice(dataUrl.indexOf(":") + 1, dataUrl.indexOf(";"));
    return {
      kind,
      src: dataUrl,
      base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
      mimeType: mimeType || "image/png",
      artifactId: artifact.id,
      parentId: artifact.parentId,
      parentHandoffSeconds: artifact.parentHandoffSeconds,
    };
  }
  return {
    kind,
    src: await decodableSrc(artifact),
    mimeType: mimeForFile(artifact.fileName),
    artifactId: artifact.id,
    parentId: artifact.parentId,
    parentHandoffSeconds: artifact.parentHandoffSeconds,
  };
}

async function loadNote(noteId: string): Promise<{ title: string; text: string }> {
  const note = await getNote(noteId);
  return {
    title: note.title,
    text: note.editedContent ?? note.generatedContent ?? note.preview ?? "",
  };
}

/** A gallery item as a data URI: the form an inline media input travels in
 * (reference clips). Read on demand — a clip is heavy and almost no node
 * needs its bytes. */
async function readMedia(artifactId: string): Promise<string> {
  const artifact = await findArtifact(artifactId);
  if (!artifact) {
    throw new Error(t("That gallery item is gone. Pick another one."));
  }
  const base64 = await readArtifactBase64(artifact);
  return `data:${mimeForFile(artifact.fileName)};base64,${base64}`;
}

/** Mime from a gallery file name, for the data URIs the backends parse. */
function mimeForFile(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "webm") return "video/webm";
  if (extension === "mov") return "video/quicktime";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  if (extension === "flac") return "audio/flac";
  if (extension === "m4a") return "audio/mp4";
  if (extension === "aac") return "audio/aac";
  if (extension === "ogg" || extension === "opus") return "audio/ogg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return "video/mp4";
}

/** The gallery-backed storage the engine persists through on both shells. */
export function workflowStorage(): WorkflowStorage {
  return { save, loadAsset, loadNote, readMedia };
}

// --- durable runs (ADR-0021) ---------------------------------------------------

/** Mirrors `WorkflowRunDto` (definition and nodeCosts arrive as JSON text). */
export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  name: string;
  definition: string;
  status: "running" | "awaitingGate" | "completed" | "failed" | "cancelled";
  error?: string;
  nodeCosts?: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowRunNodeRow {
  nodeId: string;
  status: string;
  output?: string;
  error?: string;
  updatedAt: string;
}

/** A finished node's output, stripped to what a resume can rebuild it from:
 * artifact references and small payloads, never large media bytes. */
type StoredOutput =
  | { kind: "text"; text: string }
  | { kind: "image"; artifactId?: string; base64?: string; mimeType: string; chainFrom?: ChainRef }
  | {
      kind: "audio";
      artifactId: string;
      mimeType: string;
      source?: "music" | "speech";
      /** Where the sound is heard. Persisted, or a resumed run would place
       * every line at the top of the film again. */
      atSeconds?: number;
    }
  | { kind: "video"; artifactId: string; parentId?: string; parentHandoffSeconds?: number };

function dehydrate(output: NodeOutput): StoredOutput | undefined {
  switch (output.kind) {
    case "text":
      return output;
    case "image":
      // Frame stills are never gallery artifacts; their payload-encoded bytes
      // are bounded, so they persist inline rather than being re-decoded.
      return output.artifactId
        ? {
            kind: "image",
            artifactId: output.artifactId,
            mimeType: output.mimeType,
            chainFrom: output.chainFrom,
          }
        : {
            kind: "image",
            base64: output.base64,
            mimeType: output.mimeType,
            chainFrom: output.chainFrom,
          };
    case "audio":
      return output.artifactId
        ? {
            kind: "audio",
            artifactId: output.artifactId,
            mimeType: output.mimeType,
            source: output.source,
            atSeconds: output.atSeconds,
          }
        : undefined;
    case "video":
      return output.artifactId
        ? {
            kind: "video",
            artifactId: output.artifactId,
            parentId: output.parentId,
            parentHandoffSeconds: output.parentHandoffSeconds,
          }
        : undefined;
  }
}

/** Rebuild a live output from its stored form. Throws when the artifact is
 * gone — the caller drops the node from the cache so it simply re-runs. */
async function rehydrate(stored: StoredOutput, storage: WorkflowStorage): Promise<NodeOutput> {
  switch (stored.kind) {
    case "text":
      return stored;
    case "image": {
      if (!stored.artifactId) {
        if (!stored.base64) throw new Error(t("The stored frame is empty."));
        return {
          kind: "image",
          base64: stored.base64,
          mimeType: stored.mimeType,
          chainFrom: stored.chainFrom,
        };
      }
      const asset = await storage.loadAsset(stored.artifactId);
      if (!asset.base64) throw new Error(t("The stored image cannot be read back."));
      return {
        kind: "image",
        base64: asset.base64,
        mimeType: asset.mimeType ?? stored.mimeType,
        artifactId: stored.artifactId,
        chainFrom: stored.chainFrom,
      };
    }
    case "audio": {
      const asset = await storage.loadAsset(stored.artifactId);
      return {
        kind: "audio",
        mimeType: asset.mimeType ?? stored.mimeType,
        source: stored.source,
        artifactId: stored.artifactId,
        src: asset.src,
        atSeconds: stored.atSeconds,
      };
    }
    case "video": {
      const asset = await storage.loadAsset(stored.artifactId);
      return {
        kind: "video",
        artifactId: stored.artifactId,
        src: asset.src,
        parentId: stored.parentId,
        parentHandoffSeconds: stored.parentHandoffSeconds,
      };
    }
  }
}

/** Mirrors `MediaJobDto` where the durable runner reads it. */
interface MediaJobRow {
  id: string;
  kind: string;
  model: string;
  prompt: string;
  status: "queued" | "processing" | "completed" | "failed";
  error?: string;
  errorStatus?: number | null;
  submissionConfirmed?: boolean;
  artifactPath?: string;
  artifactFileName?: string;
  artifactBytes?: number;
  parentArtifactId?: string;
  parentHandoffSeconds?: number;
  costCredits?: number;
  source?: string;
}

/**
 * The step cache as the canvas uses it (ADR-0115): rows in the native table,
 * outputs stored as gallery references (or a step's text), never bytes. A
 * hit whose file has left the gallery is forgotten and the step runs.
 */
export function workflowStepCache(workflowId: string): StepCache {
  const storage = workflowStorage();
  return {
    async get(key) {
      const row = await invoke<{ output: unknown } | null>("workflow_cache_get", { key });
      if (!row?.output || typeof row.output !== "object") return undefined;
      try {
        return await rehydrate(row.output as StoredOutput, storage);
      } catch {
        await invoke("workflow_cache_forget", { key }).catch(() => undefined);
        return undefined;
      }
    },
    async put(key, staticKey, node, output) {
      const stored = dehydrate(output);
      // A frame read out of a clip is cheap to read again and heavy to keep.
      if (!stored || (stored.kind === "image" && !stored.artifactId)) return;
      await invoke("workflow_cache_put", {
        step: { key, staticKey, nodeType: node.type, output: stored, workflowId },
      });
    },
  };
}

/** One line of a workflow's run history (see `workflow_run_history`). */
export interface WorkflowRunEntry {
  id: string;
  status: WorkflowRunSummary["status"];
  error?: string;
  nodeCosts?: string;
  /** Steps that finished in this run. */
  done: number;
  createdAt: string;
  updatedAt: string;
}

/** A workflow's runs, newest first, without their frozen graphs. */
export async function workflowRunHistory(workflowId: string): Promise<WorkflowRunEntry[]> {
  try {
    return (await invoke<WorkflowRunEntry[] | null>("workflow_run_history", { workflowId })) ?? [];
  } catch {
    return [];
  }
}

/** Let go of a workflow's oldest finished runs (the newest thirty stay). */
export function pruneWorkflowRuns(workflowId: string): Promise<void> {
  return invoke("workflow_run_prune", { workflowId }).then(
    () => undefined,
    () => undefined,
  );
}

/** What a run credited, in credits: the figures it was confirmed at. */
export function runCredits(entry: Pick<WorkflowRunEntry, "nodeCosts">): number | undefined {
  if (!entry.nodeCosts) return undefined;
  try {
    const costs = JSON.parse(entry.nodeCosts) as Record<string, unknown>;
    return Object.values(costs).reduce<number>(
      (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
      0,
    );
  } catch {
    return undefined;
  }
}

/**
 * What a past run left on each step: its outputs, read back from their
 * gallery references, and its errors. A step whose file has left the
 * gallery is simply left out. Also returns the graph the run executed.
 */
export async function runResults(
  runId: string,
): Promise<{ results: Map<string, NodeRunResult>; definition?: Workflow }> {
  const detail = await invoke<{ run: WorkflowRunSummary; nodes: WorkflowRunNodeRow[] }>(
    "workflow_run_get",
    { id: runId },
  );
  const storage = workflowStorage();
  const results = new Map<string, NodeRunResult>();
  for (const node of detail.nodes) {
    if (node.status === "error") {
      results.set(node.nodeId, { nodeId: node.nodeId, status: "error", error: node.error });
      continue;
    }
    if (node.status !== "done" || !node.output) continue;
    try {
      const stored = JSON.parse(node.output) as StoredOutput;
      results.set(node.nodeId, {
        nodeId: node.nodeId,
        status: "done",
        output: await rehydrate(stored, storage),
      });
    } catch {
      // Gone from the gallery since, or never stored: shown as not run.
    }
  }
  return { results, definition: runDefinition(detail.run) };
}

/** Which of these static keys a run would answer from the cache. */
export async function knownStepKeys(staticKeys: string[]): Promise<Set<string>> {
  if (staticKeys.length === 0) return new Set();
  try {
    return new Set(await invoke<string[]>("workflow_cache_known", { staticKeys }));
  } catch {
    return new Set();
  }
}

function waitDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The workflow run was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The longest a provider's own `Retry-After` is honoured for, per attempt. */
const MAX_RETRY_AFTER_MS = 150_000;

/** A definite, uncharged refusal the provider expects to lift on its own: a
 * rate limit (429) or an empty payment rail (402). Read from the details the
 * native queue command attaches; anything else is not waited out. */
function waitableRefusal(error: unknown): { retryAfterMs?: number } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (code !== "media_job_queue_failed" || !details || typeof details !== "object")
    return undefined;
  const { status, retryAfterMs } = details as { status?: unknown; retryAfterMs?: unknown };
  if (status !== 429 && status !== 402) return undefined;
  return typeof retryAfterMs === "number" && retryAfterMs > 0 ? { retryAfterMs } : {};
}

/**
 * The engine's durable-render hook: queue upstream once, hand the id to Rust,
 * wait for delivery, file the artifact. `pendingJobs` carries the job ids a
 * previous session already queued, so a resume re-attaches instead of
 * re-queueing (and re-paying) the render.
 */
function durableMediaRunner(
  runId: string,
  pendingJobs: Map<string, string>,
  waitBudgetMs: number = TRANSIENT_WAIT_BUDGET_MS,
): NonNullable<RunWorkflowOptions["durableMedia"]> {
  /** Queue the render under a fresh job id, its pointer written first. */
  const submit = async (nodeId: string, request: DurableRenderRequest): Promise<string> => {
    const jobId = crypto.randomUUID();
    await invoke("workflow_run_set_node", {
      request: { runId, nodeId, status: "running", output: { pendingJobId: jobId } },
    });
    pendingJobs.set(nodeId, jobId);
    void ensureNotificationPermission("studio");
    await withSubmissionSlot(() =>
      invoke("media_job_queue", {
        request: {
          jobId,
          queuePath: request.queuePath,
          queueBody: request.queueBody,
          kind: request.kind,
          model: request.model,
          prompt: request.prompt,
          extension: request.extension,
          retrievePath: request.retrievePath,
          urlFields: request.urlFields,
          parentArtifactId: request.parentArtifactId,
          parentHandoffSeconds: request.parentHandoffSeconds,
          costCredits: request.costCredits,
          source: "workflow",
          // Filed with the result, so the gallery leads back to the step.
          ...(request.origin ? { clientContext: { origin: request.origin } } : {}),
        },
      }),
    );
    // The pointer goes down before we wait: it is what lets the next
    // session find this render instead of buying it twice.
    await invoke("workflow_run_set_node", {
      request: { runId, nodeId, status: "running", output: { pendingJobId: jobId } },
    });
    return jobId;
  };

  return async (nodeId, request: DurableRenderRequest, signal) => {
    let jobId = pendingJobs.get(nodeId);
    if (!jobId) {
      // A rate limit or an empty payment rail refuses before anything is
      // charged, so the render is queued again, under a new id (the refused
      // row is a definite failure the old id would only hand back), after
      // the provider's own wait or the outage patience's next step.
      const delays = transientDelays(waitBudgetMs);
      for (let attempt = 0; ; attempt += 1) {
        try {
          jobId = await submit(nodeId, request);
          break;
        } catch (error) {
          const refusal = waitableRefusal(error);
          const delay = delays[attempt];
          if (!refusal || delay === undefined) {
            if (
              error &&
              typeof error === "object" &&
              "message" in error &&
              typeof error.message === "string"
            )
              throw new Error(t(error.message));
            throw error;
          }
          // The refused row stays until the next submission replaces it: a
          // run cancelled during the wait resumes onto that definite failure
          // instead of a pointer to nothing.
          await waitDelay(Math.min(refusal.retryAfterMs ?? delay, MAX_RETRY_AFTER_MS), signal);
          const refused = pendingJobs.get(nodeId);
          if (refused) await invoke("media_job_dismiss", { id: refused }).catch(() => undefined);
        }
      }
    }
    const job = await waitForSettledJob<MediaJobRow>(jobId, signal);
    if (job.status === "failed") {
      throw new Error(job.error ?? "The generation failed.");
    }
    if (!job.artifactPath || !job.artifactFileName) {
      throw new Error(t("The render finished but its file is missing."));
    }
    const file: ArtifactFile = {
      path: job.artifactPath,
      fileName: job.artifactFileName,
      bytes: job.artifactBytes ?? 0,
    };
    const artifact = registerDownloadedArtifact(file, {
      kind: request.kind,
      model: request.model,
      prompt: request.prompt,
      parentId: request.parentArtifactId,
      parentHandoffSeconds: request.parentHandoffSeconds,
      costCredits: request.costCredits,
      origin: request.origin,
    });
    // Keep the completed job until its consumer has durably stored the output.
    // A crash between delivery and that write must reattach, never repurchase.
    return {
      artifactId: artifact.id,
      src: await decodableSrc(artifact),
      mimeType: mimeForFile(artifact.fileName),
    };
  };
}

/** Serialize terminal writes before downstream spending or finishing the run.
 * Every nonterminal paid job retains its queue pointer, including failures. */
async function persistNode(
  runId: string,
  result: NodeRunResult,
  pendingJobs: Map<string, string>,
  submitted: Set<string>,
): Promise<void> {
  if (result.status === "pending" || result.status === "running") return;
  const payload: Record<string, unknown> = { runId, nodeId: result.nodeId, status: result.status };
  if (result.status === "done" && result.output) {
    const stored = dehydrate(result.output);
    if (stored) payload.output = stored;
  } else if (pendingJobs.has(result.nodeId)) {
    payload.output = { pendingJobId: pendingJobs.get(result.nodeId) };
  } else if (submitted.has(result.nodeId)) {
    payload.output = { submissionStarted: true };
  }
  if (result.status === "error") payload.error = result.error;
  await invoke("workflow_run_set_node", { request: payload });
  if (result.status === "done" && payload.output) {
    const jobId = pendingJobs.get(result.nodeId);
    if (jobId) {
      // The node now owns the durable artifact reference. A failed dismissal
      // only leaves an extra row; it must not turn a completed node into an error.
      await invoke("media_job_dismiss", { id: jobId }).catch(() => undefined);
      pendingJobs.delete(result.nodeId);
    }
  }
}

interface DurableRunOptions {
  /** Fail closed when a finished paid output is missing instead of buying it again. */
  requireExistingOutputs?: boolean;
  /** How long a render may wait out a rate limit or an empty payment rail
   * before the node fails (see `RunWorkflowOptions.transientWaitMs`). */
  transientWaitMs?: number;
  /** The step cache, for callers that want it (see `RunWorkflowOptions`). */
  cache?: StepCache;
  scheduling?: RunWorkflowOptions["scheduling"];
  isolateFailures?: boolean;
  beforeNode?: RunWorkflowOptions["beforeNode"];
  signal?: AbortSignal;
  onUpdate?: (result: NodeRunResult) => void;
  nodeCosts?: Record<string, number>;
  /** Gate approvals for this run (see `RunWorkflowOptions.approvedGates`). */
  approvedGates?: Map<string, string | undefined>;
  /** Hands back the run id as soon as the row exists, so the caller can
   * approve this run's gates later without re-listing. */
  onRunRecorded?: (runId: string) => void | Promise<void>;
  /**
   * Nodes to make again, with everything that was built from them.
   *
   * A resume replays finished nodes from their cached outputs, which is what
   * makes it cheap. Redoing one shot is the same machinery pointed the other
   * way: drop that node from the cache, and drop whatever depended on it -
   * keeping the cut that was made from the old shot would hand back a film
   * that does not contain the shot the user just paid to replace.
   */
  redoNodeIds?: string[];
}

/**
 * A node and everything downstream of it.
 *
 * Walked rather than stored, like a shot chain (ADR-0019): the graph is the
 * record, and a list would be one more thing to keep in step with it.
 */
export function descendantsOf(
  workflow: Pick<Workflow, "edges">,
  nodeIds: readonly string[],
): Set<string> {
  const marked = new Set(nodeIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of workflow.edges) {
      if (marked.has(edge.source) && !marked.has(edge.target)) {
        marked.add(edge.target);
        grew = true;
      }
    }
  }
  return marked;
}

/**
 * Runs currently executing in THIS webview. Whether a run is live is an
 * in-process question, never a database one (ADR-0018): the rows still say
 * "running" while the promise chain is alive, and a resume banner that
 * trusted them would offer to double-run a production that never stopped —
 * re-spending on every non-media node.
 */
const liveRuns = new Map<string, string>();

/** The productions executing in this session right now, id → name. */
export function activeWorkflowRuns(): Array<{ id: string; name: string }> {
  return [...liveRuns.entries()].map(([id, name]) => ({ id, name }));
}

async function executeDurable(
  runId: string,
  workflow: Workflow,
  options: DurableRunOptions,
  completed: Map<string, NodeOutput>,
  pendingJobs: Map<string, string>,
): Promise<Map<string, NodeRunResult>> {
  liveRuns.set(runId, workflow.name);
  let writes: Promise<void> = Promise.resolve();
  const submitted = new Set<string>();
  try {
    const results = await runWorkflow(workflow, {
      signal: options.signal,
      storage: workflowStorage(),
      nodeCosts: options.nodeCosts,
      completed,
      approvedGates: options.approvedGates,
      cache: options.cache,
      origin: { workflowId: workflow.id, runId },
      scheduling: options.scheduling,
      isolateFailures: options.isolateFailures,
      durableMedia: durableMediaRunner(runId, pendingJobs, options.transientWaitMs),
      beforeNode: async (node) => {
        await writes;
        if (!pendingJobs.has(node.id)) {
          await options.beforeNode?.(node);
          await invoke("workflow_run_set_node", {
            request: {
              runId,
              nodeId: node.id,
              status: "running",
              output: { submissionStarted: true },
            },
          });
          submitted.add(node.id);
        }
      },
      onUpdate: (result) => {
        writes = writes.then(() => persistNode(runId, result, pendingJobs, submitted));
        // The chain is awaited before the next paid node and at completion.
        void writes.catch(() => undefined);
        options.onUpdate?.(result);
      },
    });
    // A run held at a gate is paused, not finished: the row says so (and the
    // user gets told — they may be in another app by now).
    await writes;
    const held = awaitingGateIds(results).length > 0;
    await invoke("workflow_run_finish", {
      request: { id: runId, status: held ? "awaitingGate" : "completed" },
    }).catch(() => undefined);
    return results;
  } catch (error) {
    await writes.catch(() => undefined);
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    await invoke("workflow_run_finish", {
      request: {
        id: runId,
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? undefined : error instanceof Error ? error.message : "The run failed.",
      },
    }).catch(() => undefined);
    throw error;
  } finally {
    liveRuns.delete(runId);
  }
}

/** Record the run row: it must exist before the first node does anything,
 * so closing the app mid-run leaves something to resume. */
async function createRunRow(
  runId: string,
  workflow: Workflow,
  nodeCosts?: Record<string, number>,
): Promise<void> {
  await invoke("workflow_run_create", {
    request: {
      id: runId,
      workflowId: workflow.id,
      name: workflow.name,
      definition: workflow,
      nodeIds: workflow.nodes.map((node) => node.id),
      nodeCosts,
    },
  });
}

/**
 * The productions that are not finished and are not running: interrupted,
 * held at a gate, or failed.
 *
 * `failed` belongs here, and its absence was a real bug on the remote studio
 * this replaces: a run that stopped on an error showed nothing at all after a
 * reload, so a project that was stuck looked exactly like a project at rest.
 * Resuming a failed run is also the right thing to offer - the engine replays
 * finished nodes from their cached outputs, so what it actually does is retry
 * the step that failed and keep everything already paid for.
 *
 * A run whose promise chain is still alive in this webview is running, not
 * interrupted: offering to "resume" it would double-run it.
 */
export async function listResumableRuns(): Promise<WorkflowRunSummary[]> {
  try {
    const runs = await invoke<WorkflowRunSummary[]>("workflow_run_list");
    // A run someone stopped is listed too, so its row can be let go (it would
    // otherwise sit in the table for good). It is offered, never resumed on
    // its own: stopping was a decision.
    return runs.filter(
      (run) =>
        (run.status === "running" ||
          run.status === "awaitingGate" ||
          run.status === "failed" ||
          run.status === "cancelled") &&
        !liveRuns.has(run.id),
    );
  } catch {
    // No command surface (browser preview): nothing to resume.
    return [];
  }
}

/** The frozen graph a run executes, for showing it on the canvas. */
export function runDefinition(run: WorkflowRunSummary): Workflow | undefined {
  try {
    const parsed: unknown = JSON.parse(run.definition);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Workflow).nodes)) {
      return parsed as Workflow;
    }
  } catch {
    // Fall through: an unreadable definition cannot be resumed.
  }
  return undefined;
}

/**
 * Pick an interrupted run back up: finished nodes replay from their stored
 * outputs, a node that was waiting on a render re-attaches to its job, and
 * everything else executes as usual. Project callers require existing paid
 * outputs so a missing result cannot silently buy a replacement.
 */
export async function resumeWorkflowRun(
  runId: string,
  options: DurableRunOptions = {},
): Promise<Map<string, NodeRunResult>> {
  const detail = await invoke<{ run: WorkflowRunSummary; nodes: WorkflowRunNodeRow[] }>(
    "workflow_run_get",
    { id: runId },
  );
  const workflow = runDefinition(detail.run);
  if (!workflow) {
    throw new Error(t("This run's graph is unreadable. Dismiss it and start a new run."));
  }
  const storage = workflowStorage();
  const completed = new Map<string, NodeOutput>();
  const pendingJobs = new Map<string, string>();
  // What the caller asked to make again, plus what was built from it.
  const stale = options.redoNodeIds?.length
    ? descendantsOf(workflow, options.redoNodeIds)
    : undefined;
  // An explicitly quoted replacement no longer needs a definitive failed
  // queue row. Clear its pointer durably before dismissing it, so a restart
  // between this decision and the new queue can still resume the new attempt.
  if (stale) {
    const replaced = detail.nodes.flatMap((node) => {
      if (!stale.has(node.nodeId) || node.status !== "error" || !node.output) return [];
      try {
        const pending = (JSON.parse(node.output) as { pendingJobId?: unknown }).pendingJobId;
        return typeof pending === "string" ? [{ nodeId: node.nodeId, jobId: pending }] : [];
      } catch {
        return [];
      }
    });
    if (replaced.length) {
      const jobs = (await invoke<MediaJobRow[]>("media_job_list")) ?? [];
      for (const { nodeId, jobId } of replaced) {
        const job = jobs.find((candidate) => candidate.id === jobId);
        if (
          job?.status !== "failed" ||
          (job.errorStatus == null && job.submissionConfirmed !== true)
        )
          continue;
        await invoke("workflow_run_set_node", {
          request: { runId, nodeId, status: "pending", output: {} },
        });
        await invoke("media_job_dismiss", { id: jobId }).catch(() => undefined);
      }
    }
  }
  for (const node of detail.nodes) {
    if (stale?.has(node.nodeId)) continue;
    // A generator's result is what was paid for; a gate only passes one on.
    const paid = workflow.nodes.some(
      (candidate) => candidate.id === node.nodeId && maybeNodeSchema(candidate.type)?.paid === true,
    );
    const missingPaidOutput = () =>
      new Error(t("A paid result is missing. Restore its file or explicitly request a new take."));
    if (!node.output) {
      if (options.requireExistingOutputs && paid && node.status === "done")
        throw missingPaidOutput();
      continue;
    }
    let stored: unknown;
    try {
      stored = JSON.parse(node.output);
    } catch {
      if (options.requireExistingOutputs && paid && node.status === "done")
        throw missingPaidOutput();
      continue;
    }
    if (
      options.requireExistingOutputs &&
      paid &&
      node.status !== "done" &&
      stored &&
      typeof stored === "object" &&
      "submissionStarted" in stored &&
      stored.submissionStarted === true
    ) {
      throw new Error(
        t(
          "A previous request may already have been charged. Check its result before requesting another take.",
        ),
      );
    }
    if (node.status === "done") {
      try {
        completed.set(node.nodeId, await rehydrate(stored as StoredOutput, storage));
      } catch {
        if (options.requireExistingOutputs && paid) throw missingPaidOutput();
        // Legacy callers may explicitly keep the historical re-render behavior.
      }
    } else {
      const pending =
        stored && typeof stored === "object"
          ? (stored as { pendingJobId?: unknown }).pendingJobId
          : undefined;
      if (typeof pending === "string" && pending) {
        if (options.requireExistingOutputs && node.status === "error") {
          const jobs = (await invoke<MediaJobRow[]>("media_job_list")) ?? [];
          const job = jobs.find((entry) => entry.id === pending);
          if (
            job?.status === "failed" &&
            (job.errorStatus != null || job.submissionConfirmed === true)
          ) {
            throw new Error(t("This generation failed. Review a new quote to make another take."));
          }
        }
        pendingJobs.set(node.nodeId, pending);
      }
    }
  }
  const costs = detail.run.nodeCosts ? JSON.parse(detail.run.nodeCosts) : undefined;
  return executeDurable(
    runId,
    workflow,
    { ...options, nodeCosts: options.nodeCosts ?? costs },
    completed,
    pendingJobs,
  );
}

/**
 * Point a recorded run at a new graph.
 *
 * Used by a retake on another engine. The row is the record (ADR-0021), and a
 * resume reads the graph back from it, so the change has to land there before
 * the resume rather than only in the caller's copy.
 */
export async function setWorkflowRunDefinition(runId: string, definition: Workflow): Promise<void> {
  await invoke("workflow_run_set_definition", { id: runId, definition });
}

/** Forget a run. Delivered render jobs it still owns are filed into the
 * gallery first, so dismissing an interrupted production cannot lose a paid
 * render that finished in the background. */
export async function dismissWorkflowRun(runId: string): Promise<void> {
  try {
    const detail = await invoke<{ run: WorkflowRunSummary; nodes: WorkflowRunNodeRow[] }>(
      "workflow_run_get",
      { id: runId },
    );
    const jobs = await invoke<MediaJobRow[]>("media_job_list").catch(() => [] as MediaJobRow[]);
    for (const node of detail.nodes) {
      if (!node.output) continue;
      let pending: string | undefined;
      try {
        const parsed = JSON.parse(node.output) as { pendingJobId?: unknown };
        pending = typeof parsed.pendingJobId === "string" ? parsed.pendingJobId : undefined;
      } catch {
        continue;
      }
      if (!pending) continue;
      const job = jobs.find((entry) => entry.id === pending);
      if (!job) continue;
      if (job.status === "completed" && job.artifactPath && job.artifactFileName) {
        registerDownloadedArtifact(
          { path: job.artifactPath, fileName: job.artifactFileName, bytes: job.artifactBytes ?? 0 },
          {
            kind: job.kind === "image" ? "image" : job.kind === "music" ? "music" : "video",
            model: job.model,
            prompt: job.prompt,
            parentId: job.parentArtifactId,
            parentHandoffSeconds: job.parentHandoffSeconds,
            costCredits: job.costCredits,
            origin: {
              surface: "workflow",
              workflowId: detail.run.workflowId,
              runId,
              nodeId: node.nodeId,
            },
          },
        );
      }
      // Failed or delivered: the row has said all it will. Still rendering:
      // stop polling it — the row expires on its own if it never lands.
      const command = job.status === "queued" || job.status === "processing";
      await invoke(command ? "media_job_stop" : "media_job_dismiss", { id: pending }).catch(
        () => undefined,
      );
    }
  } catch {
    // Best-effort salvage; the dismiss below is the part that must happen.
  }
  await invoke("workflow_run_dismiss", { id: runId }).catch(() => undefined);
}

/** Runs `workflow` with gallery persistence, durably when the run row can be
 * recorded (the run then survives a kill and can be resumed), and in-webview
 * otherwise (tests, browser previews, an early boot). A run that *recorded*
 * and then failed stays failed — the fallback is only for a run that could
 * never have been resumed anyway. Returns the finished per-node results
 * (same shape `runWorkflow` returns; a gate hold shows as "awaiting"). */
export async function runAndSaveWorkflow(
  workflow: Workflow,
  options?: RunWorkflowOptions & {
    onRunRecorded?: (runId: string) => void | Promise<void>;
    requireDurable?: boolean;
  },
): Promise<Map<string, NodeRunResult>> {
  const runId = crypto.randomUUID();
  try {
    await createRunRow(runId, workflow, options?.nodeCosts);
  } catch (error) {
    if (options?.requireDurable) throw error;
    return runWorkflow(workflow, { storage: workflowStorage(), ...options });
  }
  try {
    await options?.onRunRecorded?.(runId);
  } catch (error) {
    // No node has started yet. If the owner cannot record this run, leaving
    // its native row resumable would expose the paid graph outside that owner.
    await invoke("workflow_run_dismiss", { id: runId }).catch(() => undefined);
    throw error;
  }
  return executeDurable(
    runId,
    workflow,
    {
      signal: options?.signal,
      onUpdate: options?.onUpdate,
      nodeCosts: options?.nodeCosts,
      beforeNode: options?.beforeNode,
      approvedGates: options?.approvedGates,
      // Everything the caller chose about how the run goes: dropping these
      // here silently ran canvas workflows without the step cache, level by
      // level, and without the rate-limit budget.
      cache: options?.cache,
      scheduling: options?.scheduling,
      isolateFailures: options?.isolateFailures,
      transientWaitMs: options?.transientWaitMs,
    },
    new Map(),
    new Map(),
  );
}

/**
 * Approve every gate currently holding a run (first candidate each) and
 * continue it — the one-tap "approve and continue". A caller that wants to
 * decide gates one at a time passes its own `approvedGates` to
 * {@link resumeWorkflowRun} instead; undecided gates simply hold again.
 */
export async function approveRunGates(
  runId: string,
  options: DurableRunOptions = {},
): Promise<Map<string, NodeRunResult>> {
  const detail = await invoke<{ run: WorkflowRunSummary; nodes: WorkflowRunNodeRow[] }>(
    "workflow_run_get",
    { id: runId },
  );
  const approvals = new Map<string, string | undefined>(options.approvedGates ?? []);
  for (const node of detail.nodes) {
    if (node.status === "awaiting" && !approvals.has(node.nodeId)) {
      approvals.set(node.nodeId, undefined);
    }
  }
  return resumeWorkflowRun(runId, { ...options, approvedGates: approvals });
}

/** A finished production, opened up so it can be finished properly. */
export interface ProductionCut {
  runId: string;
  name: string;
  /** The shots, in the order the run cut them. */
  shots: Array<{ artifactId: string; parentHandoffSeconds?: number }>;
  /** Everything audible, by lane, with where it was heard. */
  sounds: Array<{ artifactId: string; lane: "dialogue" | "sfx" | "music"; atSeconds: number }>;
}

/**
 * Read a finished production back as a cut list.
 *
 * The film a run produces is one flattened file: fine to watch, and the end of
 * the line if the user wants to grade it or move a line half a second. What
 * they need for that is the *parts*, in order, with their lanes - which the run
 * still has, on its node rows.
 *
 * Read from the frozen graph rather than from the node ids, because the graph
 * is what says which sound was on which lane. A node whose artifact has since
 * been deleted is skipped rather than failing the whole load: an incomplete cut
 * list is still worth having.
 */
export async function productionCut(runId: string): Promise<ProductionCut | undefined> {
  const detail = await invoke<{ run: WorkflowRunSummary; nodes: WorkflowRunNodeRow[] }>(
    "workflow_run_get",
    { id: runId },
  ).catch(() => undefined);
  if (!detail) return undefined;
  const workflow = runDefinition(detail.run);
  if (!workflow) return undefined;

  const outputs = new Map<string, StoredOutput>();
  for (const node of detail.nodes) {
    if (node.status !== "done" || !node.output) continue;
    try {
      outputs.set(node.nodeId, JSON.parse(node.output) as StoredOutput);
    } catch {
      // An unreadable row is one missing shot, not a failed load.
    }
  }

  const assemble = workflow.nodes.find((node) => node.type === "assemble");
  if (!assemble) return undefined;
  const into = (port: string) =>
    workflow.edges.filter((edge) => edge.target === assemble.id && edge.targetPort === port);

  const shots = into("clips").flatMap((edge) => {
    const stored = outputs.get(edge.source);
    if (stored?.kind !== "video") return [];
    return [{ artifactId: stored.artifactId, parentHandoffSeconds: stored.parentHandoffSeconds }];
  });

  const lanes: Array<["dialogue" | "sfx" | "music", string]> = [
    ["dialogue", "dialogue"],
    ["sfx", "sfx"],
    ["music", "music"],
    // The single track this node started with was always the music.
    ["music", "audio"],
  ];
  const sounds = lanes.flatMap(([lane, port]) =>
    into(port).flatMap((edge) => {
      const stored = outputs.get(edge.source);
      if (stored?.kind !== "audio") return [];
      return [{ artifactId: stored.artifactId, lane, atSeconds: stored.atSeconds ?? 0 }];
    }),
  );

  if (shots.length === 0) return undefined;
  return { runId, name: detail.run.name, shots, sounds };
}

/** Productions worth reopening: the ones that reached a cut. */
export async function listFinishedProductions(): Promise<WorkflowRunSummary[]> {
  try {
    const runs = await invoke<WorkflowRunSummary[]>("workflow_run_list");
    return runs.filter((run) => run.status === "completed");
  } catch {
    return [];
  }
}
