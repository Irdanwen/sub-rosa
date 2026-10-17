// The engine's vocabulary: what a node produces, what a run reports, and what
// a caller injects (storage, durable renders, budget checks, approvals).

import type { ArtifactKind } from "../types";
import type { WorkflowNode } from "./schema";

/** A shot's link to the clip it continues (ADR-0019 parent links). */
export interface ChainRef {
  artifactId: string;
  handoffSeconds: number;
}

export type NodeOutput =
  | { kind: "text"; text: string }
  | {
      kind: "image";
      base64: string;
      mimeType: string;
      artifactId?: string;
      /** Set when the image is a handoff frame: the clip it was read from and
       * where — the video generated from it records these as parent links. */
      chainFrom?: ChainRef;
    }
  // `source` tells savers which gallery bucket the audio belongs to — with
  // base64 delivery, music and speech are otherwise indistinguishable.
  | {
      kind: "audio";
      url?: string;
      base64?: string;
      mimeType: string;
      source?: "music" | "speech";
      artifactId?: string;
      /** A URL this webview can decode (the saved gallery copy). */
      src?: string;
      /**
       * Where on the film this sound is heard, in seconds.
       *
       * Stamped by the node that knows: a line of dialogue belongs to a shot,
       * and only the node that rendered it was told which. Absent means "the
       * cut decides" - music starts at the top, dialogue is scheduled after
       * whatever came before it.
       */
      atSeconds?: number;
    }
  | {
      kind: "video";
      /** The backend delivery URL. Absent on gallery assets. */
      url?: string;
      artifactId?: string;
      /** A URL this webview can decode (the saved gallery copy). */
      src?: string;
      parentId?: string;
      parentHandoffSeconds?: number;
    };

export interface NodeRunResult {
  nodeId: string;
  /** "awaiting" is a gate holding the production for the user's approval —
   * a pause, not a failure: siblings finish, downstream stays pending. */
  status: "pending" | "running" | "done" | "error" | "awaiting";
  output?: NodeOutput;
  error?: string;
  /** 0..1, for nodes that can report it (the assemble export is real-time). */
  progress?: number;
  /** A judged gate's verdict, shown next to the hold it caused. */
  note?: string;
  /** The result came from the step cache: same request, nothing spent
   * (ADR-0115). */
  reused?: boolean;
}

/**
 * The step cache (ADR-0115), injected by the caller that wants it (the
 * canvas). A step is looked up by what it is about to ask just before it
 * would spend, and stored once it has made something.
 */
export interface StepCache {
  get(key: string): Promise<NodeOutput | undefined>;
  put(key: string, staticKey: string, node: WorkflowNode, output: NodeOutput): Promise<void>;
}

/** The gate nodes currently holding a finished-for-now run. */
export function awaitingGateIds(results: Map<string, NodeRunResult>): string[] {
  return [...results.values()]
    .filter((result) => result.status === "awaiting")
    .map((result) => result.nodeId);
}

/** Internal control flow: a gate that has no approval yet. */
export class GateHold extends Error {
  /** What a judge said before the gate held, when one ran. */
  readonly note?: string;
  constructor(note?: string) {
    super("Waiting for your approval.");
    this.name = "GateHold";
    this.note = note;
  }
}

export interface SavedMedia {
  artifactId: string;
  /** A URL this webview can decode (asset protocol on desktop, blob on iOS). */
  src: string;
  /** Format recognized when the native gallery saved the returned bytes. */
  mimeType?: string;
}

export interface SaveMediaMeta {
  kind: ArtifactKind;
  model: string;
  prompt: string;
  parentId?: string;
  parentHandoffSeconds?: number;
  /** What the render was quoted or estimated at, in credits. An estimate the
   * caller priced before running, not a receipt. */
  costCredits?: number;
}

export interface LoadedAsset {
  kind: "image" | "video" | "audio";
  src: string;
  /** Image assets only: the bytes, so they can feed generation inputs. */
  base64?: string;
  mimeType?: string;
  artifactId: string;
  parentId?: string;
  parentHandoffSeconds?: number;
}

/**
 * Where produced media lands and where referenced media comes from.
 *
 * Injected rather than imported: the engine stays storage-agnostic, and only
 * the caller knows where files should land (the gallery on both shells) and
 * which URL scheme this platform's webview can actually decode. Without it,
 * nodes that need bytes (lastFrame, assemble, asset, document) fail with a
 * clear message instead of silently doing nothing.
 */
export interface WorkflowStorage {
  save(
    payload: { base64?: string; url?: string },
    extension: string,
    meta: SaveMediaMeta,
  ): Promise<SavedMedia>;
  loadAsset(artifactId: string): Promise<LoadedAsset>;
  loadNote(noteId: string): Promise<{ title: string; text: string }>;
  /**
   * A gallery item as a data URI, for the requests that must carry the bytes
   * inline (reference clips: there is nowhere to host them). Separate from
   * `loadAsset` because reading a whole clip is expensive and almost never
   * what a node needs.
   */
  readMedia(artifactId: string): Promise<string>;
}

/** What a durable render needs queued: everything Rust's job runner asks for,
 * minus the queue id it will get back. */
export interface DurableRenderRequest {
  kind: "video" | "music" | "image" | "speech";
  model: string;
  prompt: string;
  extension: string;
  queuePath: string;
  queueBody: Record<string, unknown>;
  retrievePath: string;
  urlFields: string[];
  parentArtifactId?: string;
  parentHandoffSeconds?: number;
  costCredits?: number;
}

export interface RunWorkflowOptions {
  /** Check/reserve budget immediately before an uncached paid node starts. */
  beforeNode?: (node: WorkflowNode) => Promise<void>;
  signal?: AbortSignal;
  onUpdate?: (result: NodeRunResult) => void;
  storage?: WorkflowStorage;
  /**
   * How long a node may wait out a payment rail or a capacity outage before
   * giving up. Defaults to `TRANSIENT_WAIT_BUDGET_MS`; zero disables the wait,
   * which is what a test wants.
   */
  transientWaitMs?: number;
  /** Per-node cost figures (estimates or run-time quotes), in credits, keyed
   * by node id. Stamped onto what each node saves, so a workflow-produced
   * artifact prices its chain the way a hand-run render does. */
  nodeCosts?: Record<string, number>;
  /**
   * Runs a long render as a durable media job instead of an in-webview poll:
   * queue upstream, hand the id to Rust, wait for delivery, file the artifact.
   * Injected by the durable runner (ADR-0021); without it, video and music
   * nodes poll in the webview and the run is foreground-bound.
   */
  durableMedia?: (
    nodeId: string,
    request: DurableRenderRequest,
    signal?: AbortSignal,
  ) => Promise<SavedMedia>;
  /**
   * Nodes a previous session already finished, keyed by node id. They are
   * marked done with their cached output instead of executing — what makes a
   * resumed run pick up exactly where it stopped without re-spending.
   */
  completed?: Map<string, NodeOutput>;
  /**
   * Gate approvals for THIS run, keyed by gate node id. The value picks which
   * upstream candidate passes through (a source node id), or `undefined` for
   * "the first one". A gate with no entry holds the run: its node reports
   * "awaiting", downstream stays pending, and the run returns.
   */
  approvedGates?: Map<string, string | undefined>;
  /**
   * How steps are started. `levels` (the default) waits for a whole level
   * before starting the next, as every production has always run; `ready`
   * starts a step as soon as what feeds it is done (ADR-0114 addendum).
   */
  scheduling?: "levels" | "ready";
  /** With `ready`: a failed step stops only what it feeds, and the other
   * branches finish. The run still ends failed, and resumable. */
  isolateFailures?: boolean;
  /** Reuse what an identical step already made instead of buying it again.
   * Absent for callers whose own takes decide what is made (a film
   * production keeps its take signature, ADR-0030). */
  cache?: StepCache;
}

/** Carries the per-node status map so callers keep the results of branches
 * that finished before the failure. */
export class WorkflowRunError extends Error {
  nodeId?: string;
  results: Map<string, NodeRunResult>;

  constructor(message: string, results: Map<string, NodeRunResult>, nodeId?: string) {
    super(message);
    this.name = "WorkflowRunError";
    this.results = results;
    this.nodeId = nodeId;
  }
}
