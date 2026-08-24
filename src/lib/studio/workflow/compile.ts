/**
 * A shot list, compiled into a workflow.
 *
 * This is the load-bearing decision of the whole local production path, and it
 * is a refusal: **there is no second runtime.** A shot list does not get an
 * executor, a scheduler, a resume story or a cost model of its own. It
 * compiles into the graph the Studio already runs - which is durable across
 * restarts and iOS suspensions (ADR-0021), already prices itself, already has
 * approval gates, already reattaches to renders that finished while the app
 * was closed, and already renders as guided Flows on the phone. Everything a
 * production needs was built once, for the canvas, and is inherited here for
 * free.
 *
 * **The app owns the routing.** The model that read the script returned a
 * motion class and who is in the shot. It never saw the catalogue, so it never
 * picks a model, a duration or an aspect ratio: those are resolved here,
 * against what the account can actually run, and clamped to what each model
 * publishes (ADR-0022). A language model guessing at a video model id is a
 * guess that gets billed.
 *
 * **Nothing compiles over the envelope.** A graph that would spend more than
 * the user agreed to is not built and then confirmed - it is refused, with the
 * figure, and with the two things that would bring it under. The confirmation
 * handshake still stands in front of the spend; this stands in front of the
 * handshake.
 */

import {
  type BibleEntry,
  invariantLine,
  referenceStack,
  shotPrompt,
  voiceReference,
} from "../bible";
import { estimateCostCredits, isSeedanceModel, modelsOfType } from "../catalog";
import { effectiveVideoConstraints } from "../model-constraints";
import type { MediaCatalog, MediaModel } from "../types";
import { defaultParams, type Workflow, type WorkflowEdge, type WorkflowNode } from "./schema";

/** One shot, exactly as `src-tauri/src/shotlist` produces it. */
export interface Shot {
  scene: string;
  action: string;
  camera: string;
  characters: string[];
  location: string;
  dialogue: string;
  speaker: string;
  /** low | medium | high. */
  motion: string;
  /** Carries straight on from the shot before it, same place, no cut in time. */
  continues: boolean;
}

const LEVEL_X = 320;
const ROW_Y = 240;

/**
 * How long a shot runs, by how much moves in it.
 *
 * A face listening does not need eight seconds and a chase does not read in
 * three. These are the app's opinion, clamped to whatever the chosen model
 * actually publishes - so they are a preference, never a request that gets
 * refused after being billed.
 */
const SECONDS_BY_MOTION: Record<string, number> = { low: 4, medium: 5, high: 8 };

/** The longest a compiled film runs before this refuses to build it blind. */
export const MAX_COMPILED_SHOTS = 40;

export interface CompileInput {
  name: string;
  shots: readonly Shot[];
  /** Named identities, so a character keeps their face and their traits. */
  bible?: readonly BibleEntry[];
  catalog: MediaCatalog;
  /** Hard ceiling in credits. Over it, nothing is built. */
  envelopeCredits?: number;
  aspectRatio?: string;
  /** Lay a generated score under the film. */
  withScore?: boolean;
  /** Stop for approval after the shots, before the film is cut together. */
  gateBeforeAssemble?: boolean;
}

export interface CompileResult {
  workflow?: Workflow;
  /** Sum of the flat prices this account publishes. Metered nodes count zero. */
  estimateCredits: number;
  /** Why nothing was built. */
  refusal?: string;
  /** Choices made on the user's behalf, said out loud. */
  notes: string[];
}

function node(
  id: string,
  type: WorkflowNode["type"],
  label: string,
  level: number,
  row: number,
  params: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    type,
    label,
    position: { x: level * LEVEL_X, y: row * ROW_Y },
    params: { ...defaultParams(type), ...params },
  };
}

function edge(source: string, target: string, targetPort?: string): WorkflowEdge {
  return {
    id: `${source}-${target}${targetPort ? `-${targetPort}` : ""}`,
    source,
    target,
    targetPort,
  };
}

/** The closest published value to what we would like, or nothing. */
export function nearestOption(options: readonly string[] | undefined, wanted: number): string {
  if (!options || options.length === 0) return "";
  const scored = options
    .map((option) => ({ option, value: Number.parseFloat(option) }))
    .filter((entry) => Number.isFinite(entry.value));
  if (scored.length === 0) return options[0];
  scored.sort((left, right) => Math.abs(left.value - wanted) - Math.abs(right.value - wanted));
  return scored[0].option;
}

interface Routing {
  /** Text-to-video: nothing to start from. */
  text?: MediaModel;
  /** Image-to-video: a shot continuing from a handoff frame. */
  fromImage?: MediaModel;
  /** Reference-to-video: a shot that has to hold somebody's face. */
  reference?: MediaModel;
}

/**
 * The models this account can actually run, sorted into the three jobs a shot
 * can need.
 *
 * Nothing is hardcoded: ids change under us (the catalogue renamed every
 * seedance variant between two releases), so the families are recognised by
 * what the catalogue says they take, not by their name.
 */
export function routeModels(catalog: MediaCatalog): Routing {
  const video = modelsOfType(catalog, "video");
  const fromImage = modelsOfType(catalog, "imageToVideo");
  const reference = modelsOfType(catalog, "referenceToVideo");
  // Seedance first among the reference models: it is the family whose whole
  // contract is holding an identity across separate renders.
  const preferredReference = reference.find((model) => isSeedanceModel(model.id)) ?? reference[0];
  return {
    text: video[0],
    fromImage: fromImage[0] ?? video[0],
    reference: preferredReference,
  };
}

interface PlannedShot {
  shot: Shot;
  model: MediaModel;
  /** Continues the previous shot from its handoff frame. */
  chained: boolean;
  /** Gallery artifact ids to send as references. */
  references: string[];
  prompt: string;
  duration: string;
  aspectRatio: string;
}

/**
 * Which model renders a shot, and what it is handed.
 *
 * The order matters. A shot that continues another one has a frame to start
 * from, and starting from it is what makes the seam invisible - that wins over
 * everything else. Otherwise a shot with a face the bible knows goes to the
 * reference family, because holding that face is the harder problem. Anything
 * else is text to video.
 */
export function planShots(
  shots: readonly Shot[],
  bible: readonly BibleEntry[],
  catalog: MediaCatalog,
  aspectRatio: string,
): { planned: PlannedShot[]; notes: string[] } {
  const routing = routeModels(catalog);
  const notes: string[] = [];
  const byName = new Map(bible.map((entry) => [entry.name.toLowerCase(), entry]));
  const planned: PlannedShot[] = [];

  shots.forEach((shot, index) => {
    const characters = shot.characters
      .map((name) => byName.get(name.trim().toLowerCase()))
      .filter((entry): entry is BibleEntry => entry !== undefined);
    const location = byName.get(shot.location.trim().toLowerCase());
    const chained = shot.continues && index > 0;
    const stack = chained ? [] : referenceStack({ characters, location });

    const model =
      (chained ? routing.fromImage : stack.length > 0 ? routing.reference : routing.text) ??
      routing.text;
    if (!model) return;

    const constraints = effectiveVideoConstraints(model);
    const wanted = SECONDS_BY_MOTION[shot.motion] ?? SECONDS_BY_MOTION.medium;
    const duration = nearestOption(constraints.durations, wanted);
    const ratio =
      constraints.aspect_ratios && !constraints.aspect_ratios.includes(aspectRatio)
        ? (nearestOptionExact(constraints.aspect_ratios, aspectRatio) ?? "")
        : aspectRatio;
    if (ratio !== aspectRatio && ratio) {
      notes.push(
        `Shot ${index + 1} renders at ${ratio}: ${model.name} does not offer ${aspectRatio}.`,
      );
    }

    const invariants = [
      ...characters.map(invariantLine),
      ...(location ? [invariantLine(location)] : []),
    ].filter(Boolean);

    planned.push({
      shot,
      model,
      chained,
      references: stack.map((reference) => reference.artifactId),
      prompt: shotPrompt({
        subject: shot.scene ? `${shot.scene}.` : "",
        action: shot.action,
        camera: shot.camera,
        invariants,
        stack,
        model,
      }).prompt,
      duration,
      aspectRatio: ratio,
    });
  });

  return { planned, notes };
}

/** An exact match if the list has one, otherwise its first entry. */
function nearestOptionExact(options: readonly string[], wanted: string): string | undefined {
  return options.includes(wanted) ? wanted : options[0];
}

/**
 * Compile the shot list, or refuse and say why.
 *
 * The graph is validated by the caller before it is offered: an invalid graph
 * here is a bug in this function, not a run that should be attempted.
 */
export function compileShotList(input: CompileInput): CompileResult {
  const notes: string[] = [];
  const shots = input.shots.filter((shot) => shot.action.trim().length > 0);
  if (shots.length === 0) {
    return { estimateCredits: 0, notes, refusal: "There are no shots to film." };
  }
  if (shots.length > MAX_COMPILED_SHOTS) {
    return {
      estimateCredits: 0,
      notes,
      refusal: `That is ${shots.length} shots, past the ${MAX_COMPILED_SHOTS} this will build in one go. Split the script.`,
    };
  }

  const aspectRatio = input.aspectRatio ?? "16:9";
  const { planned, notes: routingNotes } = planShots(
    shots,
    input.bible ?? [],
    input.catalog,
    aspectRatio,
  );
  notes.push(...routingNotes);
  if (planned.length === 0) {
    return {
      estimateCredits: 0,
      notes,
      refusal: "This account has no video model to render these shots with.",
    };
  }

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const assets = new Map<string, string>();
  const assetNode = (artifactId: string, row: number): string => {
    const existing = assets.get(artifactId);
    if (existing) return existing;
    const id = `asset-${assets.size + 1}`;
    nodes.push(node(id, "asset", artifactId, 0, row, { artifactId }));
    assets.set(artifactId, id);
    return id;
  };

  let previousVideoId: string | undefined;
  const videoIds: string[] = [];
  const ttsIds: string[] = [];
  const tts = modelsOfType(input.catalog, "tts")[0];

  planned.forEach((entry, index) => {
    const level = 1 + index * 2;
    const videoId = `shot-${index + 1}`;

    if (entry.chained && previousVideoId) {
      // The seam: a still taken shortly before the end of the previous shot,
      // which the assemble node then trims the parent's tail to. Recording
      // where it was taken is what keeps the cut on movement (ADR-0019).
      const frameId = `handoff-${index + 1}`;
      nodes.push(
        node(frameId, "lastFrame", `Handoff ${index}`, level - 1, index, {
          position: "handoff",
        }),
      );
      edges.push(edge(previousVideoId, frameId, "video"));
      edges.push(edge(frameId, videoId, "openingFrame"));
    }

    for (const [order, artifactId] of entry.references.entries()) {
      const assetId = assetNode(artifactId, index * 2 + order);
      edges.push(edge(assetId, videoId, "references"));
    }

    nodes.push(
      node(videoId, "video", entry.shot.scene || `Shot ${index + 1}`, level, index, {
        model: entry.model.id,
        prompt: entry.prompt,
        duration: entry.duration,
        aspectRatio: entry.aspectRatio,
      }),
    );
    videoIds.push(videoId);
    previousVideoId = videoId;

    // A spoken line, and the voice it is spoken in. The mix places it; the
    // scheduler keeps two lines from landing on top of each other.
    if (entry.shot.dialogue.trim() && tts) {
      const speaker = (input.bible ?? []).find(
        (candidate) => candidate.name.toLowerCase() === entry.shot.speaker.trim().toLowerCase(),
      );
      const donor = voiceReference(speaker);
      const ttsId = `line-${index + 1}`;
      nodes.push(
        node(ttsId, "tts", `${entry.shot.speaker || "Line"} ${index + 1}`, level, index + 0.5, {
          model: tts.id,
          text: entry.shot.dialogue.trim(),
          voice: donor?.label ?? "",
        }),
      );
      ttsIds.push(ttsId);
    }
  });

  const finalLevel = 2 + planned.length * 2;
  let assembleSource = videoIds;

  if (input.gateBeforeAssemble) {
    const gateId = "gate-cut";
    nodes.push(
      node(gateId, "gate", "Before the cut", finalLevel - 1, 0, {
        note: "Look over the shots before they are cut together.",
      }),
    );
    for (const videoId of videoIds) edges.push(edge(videoId, gateId));
    assembleSource = [gateId];
  }

  const assembleId = "assemble";
  nodes.push(node(assembleId, "assemble", input.name, finalLevel, 0));
  for (const source of assembleSource) edges.push(edge(source, assembleId, "clips"));

  if (input.withScore) {
    const music = modelsOfType(input.catalog, "music")[0];
    if (music) {
      const musicId = "score";
      nodes.push(
        node(musicId, "music", "Score", finalLevel - 1, 1, {
          model: music.id,
          prompt: `Score for ${input.name}.`,
        }),
      );
      edges.push(edge(musicId, assembleId, "audio"));
    } else {
      notes.push("No music model on this account, so the film has no score.");
    }
  }

  const outputId = "output";
  nodes.push(node(outputId, "output", "The film", finalLevel + 1, 0));
  edges.push(edge(assembleId, outputId));

  // Flat published prices only. A metered node counts zero, which is why the
  // figure is always "at least" - the same honesty the cost panel already
  // shows for a hand-built graph.
  const byId = new Map(input.catalog.models.map((model) => [model.id, model]));
  const estimateCredits = nodes.reduce((sum, entry) => {
    const modelId = typeof entry.params.model === "string" ? entry.params.model : "";
    const model = modelId ? byId.get(modelId) : undefined;
    if (!model) return sum;
    const durationSeconds = Number.parseFloat(String(entry.params.duration ?? "")) || undefined;
    return (
      sum +
      (estimateCostCredits(model, {
        durationSeconds,
        multiplier: input.catalog.priceMultiplier,
      }) ?? 0)
    );
  }, 0);

  if (input.envelopeCredits !== undefined && estimateCredits > input.envelopeCredits) {
    // Refused rather than built and confirmed: the handshake is for deciding,
    // not for catching a graph that was never affordable.
    const fewer = Math.max(
      1,
      Math.floor((planned.length * input.envelopeCredits) / estimateCredits),
    );
    return {
      estimateCredits,
      notes,
      refusal: `This would cost about ${estimateCredits.toFixed(2)} credits, past the ${input.envelopeCredits.toFixed(
        2,
      )} agreed. About ${fewer} shot${fewer === 1 ? "" : "s"} fits, or raise the ceiling.`,
    };
  }

  if (ttsIds.length > 0) {
    notes.push(
      `${ttsIds.length} spoken line${ttsIds.length === 1 ? "" : "s"} render alongside the shots. Place them in Assemble.`,
    );
  }

  return {
    workflow: {
      id: `compiled-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: input.name,
      createdAt: 0,
      updatedAt: 0,
      nodes,
      edges,
    },
    estimateCredits,
    notes,
  };
}
