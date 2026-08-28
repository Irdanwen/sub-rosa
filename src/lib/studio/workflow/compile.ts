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
import { estimateCostCredits, humanizeModelId, isSeedanceModel, modelsOfType } from "../catalog";
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

/** How far into its shot a line starts. A line landing on the cut frame reads
 * as a mistake, and a beat of picture before someone speaks is what an editor
 * would leave. */
export const DIALOGUE_LEAD_IN_SECONDS = 0.4;

/** Used when a model published no durations at all, so `duration` is empty. */
const DEFAULT_SHOT_SECONDS = 5;

export interface CompileInput {
  name: string;
  shots: readonly Shot[];
  /** Named identities, so a character keeps their face and their traits. */
  bible?: readonly BibleEntry[];
  catalog: MediaCatalog;
  /**
   * The video family to shoot on. Its other directions are matched by stem, so
   * a chained shot and a shot holding a face come from the same engine. Absent
   * means the cheapest the account publishes.
   */
  videoModelId?: string;
  /** Which voice engine speaks the dialogue. Absent picks the default below. */
  ttsModelId?: string;
  /** Which engine writes the score. */
  musicModelId?: string;
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
  /**
   * Things that will cost the user something if left alone.
   *
   * Kept apart from `notes`, which are choices made on their behalf. A note is
   * "this is what I did"; a warning is "this is going to disappoint you".
   */
  warnings: string[];
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
 * A model id with its direction removed, so the three variants of one family
 * collapse to the same string.
 *
 * `seedance-2-0-fast-text-to-video-basic` and
 * `seedance-2-0-fast-reference-to-video-basic` are one family doing two
 * different jobs, and a film should shoot on one family throughout: the moment
 * a chained shot comes from a different engine than the one before it, the
 * grade and the motion change mid-cut and it stops reading as one film.
 */
export function familyStem(id: string): string {
  return id.toLowerCase().replace(/-(?:text|image|reference|video|first-last-frame)-to-video/g, "");
}

/**
 * A video family: one engine, and the jobs it can do.
 *
 * Families rather than ids, because a picker of a hundred and twenty-four
 * model names is a list, not a choice - and because the three directions of
 * one family are the same engine and belong together (see `familyStem`).
 *
 * `holdsFaces` is the one that costs money to get wrong. Only a minority of
 * families publish a reference-to-video arm, and choosing one that does not
 * means every character is drawn from scratch on every shot: the bible is
 * still built, still paid for, and does nothing.
 */
export interface VideoFamily {
  stem: string;
  label: string;
  /** An id from the family, for showing a price and for pinning the choice. */
  representativeId: string;
  holdsFaces: boolean;
  /** Can start a shot from the previous one's handoff frame. */
  continuesShots: boolean;
  costCredits?: number;
}

/** Every video family this account can run, cheapest first. */
export function videoFamilies(catalog: MediaCatalog): VideoFamily[] {
  const byStem = new Map<string, VideoFamily>();
  for (const type of ["video", "imageToVideo", "referenceToVideo"] as const) {
    for (const model of modelsOfType(catalog, type)) {
      const stem = familyStem(model.id);
      const existing = byStem.get(stem);
      const cost = estimateCostCredits(model, { multiplier: catalog.priceMultiplier });
      const entry: VideoFamily = existing ?? {
        stem,
        label: humanizeModelId(stem),
        representativeId: model.id,
        holdsFaces: false,
        continuesShots: false,
        costCredits: undefined,
      };
      if (type === "referenceToVideo") entry.holdsFaces = true;
      if (type === "imageToVideo") entry.continuesShots = true;
      // The text-to-video arm is what a plain shot costs, so it is the one
      // whose price and id represent the family.
      if (type === "video") {
        entry.representativeId = model.id;
        entry.costCredits = cost;
      }
      if (entry.costCredits === undefined) entry.costCredits = cost;
      byStem.set(stem, entry);
    }
  }
  return [...byStem.values()].sort(
    (left, right) =>
      (left.costCredits ?? Number.POSITIVE_INFINITY) -
      (right.costCredits ?? Number.POSITIVE_INFINITY),
  );
}

/**
 * Point one shot at a different engine, keeping its place in the film.
 *
 * Which arm of the new family it lands on is not the user's problem: a shot
 * that was holding a face still needs to hold it, and a shot continuing the
 * previous one still needs its opening frame. So the arm is re-derived from
 * what the graph already feeds that node, and the duration is snapped to what
 * the new engine actually offers - families do not agree on lengths, and
 * sending the old one is how a retake fails on submit.
 *
 * Returns a new graph. The caller persists it before resuming, because the
 * row is the record (ADR-0021).
 */
export function retargetShotModel(
  workflow: Workflow,
  nodeId: string,
  catalog: MediaCatalog,
  familyId: string,
): Workflow | undefined {
  const target = workflow.nodes.find((entry) => entry.id === nodeId);
  if (!target || target.type !== "video") return undefined;
  const inputs = workflow.edges.filter((entry) => entry.target === nodeId);
  const routing = routeModels(catalog, familyId);
  const model = inputs.some((entry) => entry.targetPort === "references")
    ? routing.reference
    : inputs.some((entry) => entry.targetPort === "openingFrame")
      ? routing.fromImage
      : routing.text;
  if (!model) return undefined;

  const wanted = Number(target.params?.duration) || SECONDS_BY_MOTION.medium;
  const constraints = effectiveVideoConstraints(model);
  const params: Record<string, unknown> = {
    ...target.params,
    model: model.id,
    duration: nearestOption(constraints.durations, wanted),
  };
  const ratio = target.params?.aspectRatio;
  if (
    typeof ratio === "string" &&
    constraints.aspect_ratios &&
    !constraints.aspect_ratios.includes(ratio)
  ) {
    params.aspectRatio = nearestOptionExact(constraints.aspect_ratios, ratio) ?? ratio;
  }
  return {
    ...workflow,
    nodes: workflow.nodes.map((entry) => (entry.id === nodeId ? { ...entry, params } : entry)),
  };
}

/** The family a chosen id belongs to. */
export function familyOf(
  catalog: MediaCatalog,
  modelId: string | undefined,
): VideoFamily | undefined {
  if (!modelId) return undefined;
  const stem = familyStem(modelId);
  return videoFamilies(catalog).find((family) => family.stem === stem);
}

/**
 * The models this account can actually run, sorted into the three jobs a shot
 * can need.
 *
 * Nothing is hardcoded: ids change under us (the catalogue renamed every
 * seedance variant between two releases), so families are recognised by what
 * the catalogue says they *take*, and the three directions of one family are
 * matched by stem rather than by a table somebody has to maintain.
 *
 * With no preference, the cheapest published option wins. Sorting by name was
 * picking whichever family happened to sort first, which on a real catalogue
 * is a premium model nobody chose.
 */
export function routeModels(catalog: MediaCatalog, preferredId?: string): Routing {
  const cheapestFirst = (models: MediaModel[]) =>
    [...models].sort(
      (left, right) =>
        (estimateCostCredits(left, { multiplier: catalog.priceMultiplier }) ??
          Number.POSITIVE_INFINITY) -
        (estimateCostCredits(right, { multiplier: catalog.priceMultiplier }) ??
          Number.POSITIVE_INFINITY),
    );
  const video = cheapestFirst(modelsOfType(catalog, "video"));
  const fromImage = cheapestFirst(modelsOfType(catalog, "imageToVideo"));
  const reference = cheapestFirst(modelsOfType(catalog, "referenceToVideo"));

  const stem = preferredId ? familyStem(preferredId) : undefined;
  const inFamily = (models: MediaModel[]) =>
    stem ? models.find((model) => familyStem(model.id) === stem) : undefined;

  const text = inFamily(video) ?? video[0];
  return {
    text,
    // A family with no image-to-video arm falls back to its own text arm
    // rather than to another family's: a chained shot losing its opening
    // frame is a smaller break than a chained shot changing engine.
    fromImage: inFamily(fromImage) ?? (stem ? text : undefined) ?? fromImage[0] ?? video[0],
    // Seedance first among the reference models when nothing was asked for:
    // it is the family whose whole contract is holding an identity across
    // separate renders.
    reference:
      inFamily(reference) ?? reference.find((model) => isSeedanceModel(model.id)) ?? reference[0],
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
  videoModelId?: string,
): { planned: PlannedShot[]; notes: string[] } {
  const routing = routeModels(catalog, videoModelId);
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

/**
 * Which engine speaks.
 *
 * Not by price: nothing in this catalogue publishes one for speech, so
 * "cheapest" would sort nothing and quietly mean "first alphabetically" -
 * which is what it did. The signal that exists is the voice list, and a model
 * offering more voices is more likely to have one that fits a character.
 */
export function pickTtsModel(catalog: MediaCatalog, preferredId?: string): MediaModel | undefined {
  const models = modelsOfType(catalog, "tts");
  const chosen = preferredId ? models.find((model) => model.id === preferredId) : undefined;
  if (chosen) return chosen;
  return [...models].sort(
    (left, right) => (right.voices?.length ?? 0) - (left.voices?.length ?? 0),
  )[0];
}

/**
 * Which engine writes the score.
 *
 * Not by price either - nothing publishes one. The signal that does exist is
 * length: a film wants one piece of music over the whole cut, and a model
 * capped at thirty seconds forces a loop that a viewer hears. So the longest
 * published duration wins, and models that publish nothing keep their order
 * rather than being pushed to the back for saying less about themselves.
 */
export function pickMusicModel(
  catalog: MediaCatalog,
  preferredId?: string,
): MediaModel | undefined {
  const models = modelsOfType(catalog, "music");
  const chosen = preferredId ? models.find((model) => model.id === preferredId) : undefined;
  if (chosen) return chosen;
  return [...models].sort((left, right) => longestDuration(right) - longestDuration(left))[0];
}

/** The longest score a model says it can write, in seconds. */
function longestDuration(model: MediaModel): number {
  const published = effectiveVideoConstraints(model).durations ?? [];
  return published.reduce((longest, option) => {
    const value = Number.parseFloat(option);
    return Number.isFinite(value) && value > longest ? value : longest;
  }, 0);
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
  const warnings: string[] = [];
  const shots = input.shots.filter((shot) => shot.action.trim().length > 0);
  if (shots.length === 0) {
    return { estimateCredits: 0, notes, warnings, refusal: "There are no shots to film." };
  }
  if (shots.length > MAX_COMPILED_SHOTS) {
    return {
      estimateCredits: 0,
      notes,
      warnings,
      refusal: `That is ${shots.length} shots, past the ${MAX_COMPILED_SHOTS} this will build in one go. Split the script.`,
    };
  }

  const aspectRatio = input.aspectRatio ?? "16:9";
  const { planned, notes: routingNotes } = planShots(
    shots,
    input.bible ?? [],
    input.catalog,
    aspectRatio,
    input.videoModelId,
  );
  notes.push(...routingNotes);

  // A family that cannot hold a face does not lose the bible - the router
  // sends those shots to a family that can. What it loses is the one look:
  // half the film comes off a different engine. Worth a word before paying.
  if (input.videoModelId) {
    const family = familyOf(input.catalog, input.videoModelId);
    const withFaces = planned.filter((entry) => entry.references.length > 0).length;
    const elsewhere = routeModels(input.catalog, input.videoModelId).reference;
    if (family && !family.holdsFaces && withFaces > 0 && elsewhere) {
      warnings.push(
        `${family.label} cannot carry a face from one shot to the next, so the ${withFaces} shot${
          withFaces === 1 ? "" : "s"
        } with someone from your bible are made on ${elsewhere.name} instead. The film will change look partway. A family that holds faces keeps it in one.`,
      );
    }
  }
  if (planned.length === 0) {
    return {
      estimateCredits: 0,
      notes,
      warnings,
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
  let shotStartSeconds = 0;
  const videoIds: string[] = [];
  const ttsIds: string[] = [];
  const tts = pickTtsModel(input.catalog, input.ttsModelId);

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

    // A spoken line, in the speaker's own voice, placed on the shot it belongs
    // to. Only the compiler knows which shot that is, so it says so here - the
    // cut cannot work it out from a graph.
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
          // Just inside the shot rather than exactly on the cut: a line that
          // starts on the frame the shot does reads as a mistake.
          startAt: (shotStartSeconds + DIALOGUE_LEAD_IN_SECONDS).toFixed(2),
        }),
      );
      ttsIds.push(ttsId);
    }

    // The requested durations, accumulated. An estimate, because the real clip
    // is only measured once it exists - but the shots are cut back to back, so
    // it is the right estimate, and the user can move a line on the canvas.
    shotStartSeconds += Number.parseFloat(entry.duration) || DEFAULT_SHOT_SECONDS;
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
  // The lines reach the film. Without this they render, cost money, and are
  // never heard - which is exactly what happened before this edge existed.
  for (const ttsId of ttsIds) edges.push(edge(ttsId, assembleId, "dialogue"));

  if (input.withScore) {
    const music = pickMusicModel(input.catalog, input.musicModelId);
    if (music) {
      const musicId = "score";
      nodes.push(
        node(musicId, "music", "Score", finalLevel - 1, 1, {
          model: music.id,
          prompt: `Score for ${input.name}.`,
        }),
      );
      edges.push(edge(musicId, assembleId, "music"));
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
      warnings,
      refusal: `This would cost about ${estimateCredits.toFixed(2)} credits, past the ${input.envelopeCredits.toFixed(
        2,
      )} agreed. About ${fewer} shot${fewer === 1 ? "" : "s"} fits, or raise the ceiling.`,
    };
  }

  if (ttsIds.length > 0) {
    notes.push(
      `${ttsIds.length} spoken line${ttsIds.length === 1 ? "" : "s"}, placed on the shots they belong to. Move one on the canvas if it lands wrong.`,
    );
  }

  return {
    warnings,
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
