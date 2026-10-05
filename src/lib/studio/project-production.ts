import { t } from "../i18n";
import { carpeDiemGetCredits } from "../tauri";
import { defaultEditModel, imageEditModels, musicCapabilities, videoDirection } from "./catalog";
import type { MediaCatalog } from "./types";
import type { ProjectDocument, ProjectShot } from "./projects";
import { bibleNameInUse, referencePromptOf, sheetSource } from "./projects";
import { pickPortraitModel, portraitPrompt } from "./bible/portrait";
import type { BibleRole } from "./bible/types";
import type { ProjectBibleEntry } from "./projects";
import {
  compileShotList,
  familyStem,
  pickMusicModel,
  resolveShotDuration,
  routeModels,
  shotReferences,
} from "./workflow/compile";
import {
  cueNodeId,
  cuePrompt,
  cueSeconds,
  cueShots,
  musicLength,
  projectScore,
  type ProjectCue,
} from "./score";
import {
  estimateWorkflowCost,
  fetchVideoQuotes,
  nodeCostMap,
  type WorkflowCostEstimate,
} from "./workflow/cost";
import { validateWorkflow } from "./workflow/validator";
import type { FilmDirection } from "./direction/types";
import { type ComposedPrompt, composeShotPrompt, resolveDialogue } from "./prompt/compose";
import { canSilence, rendersAudio } from "./prompt/profiles";
import { guessLanguage } from "./prompt/subject";
import type { Workflow, WorkflowNode } from "./workflow/schema";

export function compileProjectWithNotes(
  name: string,
  document: ProjectDocument,
  catalog: MediaCatalog,
  onlyShotId?: string,
): { workflow: Workflow; notes: string[] } {
  if (document.bible.some((entry) => !entry.name.trim()))
    throw new Error(t("Give this one a name."));
  if (document.bible.some((entry) => bibleNameInUse(document.bible, entry.name, entry.id)))
    throw new Error(t("Give each bible entry a different name."));
  const current = onlyShotId ? document.shots.find((shot) => shot.id === onlyShotId) : undefined;
  if (onlyShotId && !current) throw new Error(t("This shot no longer exists."));
  const previous = current ? document.shots[document.shots.indexOf(current) - 1] : undefined;
  const continuation = current?.mode === "continuation";
  if (continuation && !previous?.activeTakeId)
    throw new Error(t("Select a take for the preceding shot before continuing it."));
  // Compile only the requested take. A continuation temporarily names its
  // opening still; below that asset becomes a local frame extraction from the
  // selected preceding take. No unrelated shot is validated or purchased.
  const openingId = `continuation-opening-${current?.id ?? ""}`;
  const shots = current
    ? [
        {
          ...current,
          ...(continuation ? { mode: "image" as const, openingArtifactId: openingId } : {}),
        },
      ]
    : document.shots;
  const result = compileShotList({
    name,
    shots,
    bible: document.bible,
    catalog,
    ...document.settings,
    filmDirection: projectDirection(document),
    withScore: onlyShotId ? false : document.settings.withScore,
    score: onlyShotId ? undefined : scoreCues(document, catalog),
  });
  if (!result.workflow)
    throw new Error(result.refusal ?? t("Check your shot settings before generating."));
  const workflow = result.workflow;
  if (continuation && previous?.activeTakeId) {
    const frame = workflow.nodes.find(
      (node) => node.type === "asset" && node.params.artifactId === openingId,
    );
    if (!frame) throw new Error(t("The continuation frame could not be prepared."));
    frame.type = "lastFrame";
    frame.params = { position: "handoff" };
    const sourceId = `selected-take-${previous.id}`;
    workflow.nodes.push({
      id: sourceId,
      type: "asset",
      label: previous.title,
      position: { x: 0, y: 0 },
      params: { artifactId: previous.activeTakeId, assetKind: "video" },
    });
    workflow.edges.push({
      id: `${sourceId}-${frame.id}`,
      source: sourceId,
      target: frame.id,
      targetPort: "video",
    });
  }
  const wanted = onlyShotId
    ? new Set([`shot-${onlyShotId}`])
    : new Set(
        workflow.nodes
          .filter((node) => node.type !== "assemble" && node.type !== "output")
          .map((node) => node.id),
      );
  if (onlyShotId) {
    // An isolated take buys only the nodes feeding its picture. Dialogue and
    // score feed the removed assembly node, so charging them here wastes work.
    let size = -1;
    while (size !== wanted.size) {
      size = wanted.size;
      for (const edge of workflow.edges) if (wanted.has(edge.target)) wanted.add(edge.source);
    }
  }
  const nodes = workflow.nodes.filter((node) => wanted.has(node.id));
  const edges = workflow.edges.filter((edge) => wanted.has(edge.source) && wanted.has(edge.target));
  const compiled = { ...workflow, id: crypto.randomUUID(), nodes, edges };
  const validation = validateWorkflow(compiled);
  if (!validation.ok) throw new Error(validation.errors.map((error) => error.message).join("\n"));
  return { workflow: compiled, notes: [...result.warnings, ...result.notes] };
}

/**
 * The film's direction as the compiler reads it: the stored one, with the
 * lines' language guessed from the whole script when nobody set it. A whole
 * script guesses far better than one short line ("Encore ?").
 */
export function projectDirection(document: ProjectDocument): FilmDirection | undefined {
  const stored = document.filmDirection;
  if (stored?.dialogueLanguage || !document.script.trim()) return stored;
  return { ...stored, dialogueLanguage: guessLanguage(document.script) };
}

/**
 * What a shot's take sounds like in the montage: whether the model spoke its
 * line (the music dips under it), and whether the take carries a voice the
 * dubbed line would double (the montage mutes it).
 */
export function shotSound(
  shot: ProjectShot,
  document: ProjectDocument,
  catalog: MediaCatalog,
): { speaks: boolean; mute: boolean } {
  const model = shotVideoModel(shot, document, catalog);
  const dialogue = resolveDialogue(shot, projectDirection(document), model);
  const audible = rendersAudio(model);
  return {
    speaks: dialogue.mode === "native",
    mute: audible && dialogue.mode === "dubbed" && !canSilence(model),
  };
}

/** The score's cues as the compiler takes them: written, timed, placed. */
export function scoreCues(document: ProjectDocument, catalog: MediaCatalog) {
  // A project that only ticked "generate a musical score" before cues existed
  // keeps the single piece named after the film that it always got.
  if (!document.score) return undefined;
  const score = projectScore(document);
  if (!score) return undefined;
  return score.cues
    .filter((cue) => cueShots(document.shots, cue).length > 0)
    .map((cue) => ({
      id: cue.id,
      title: cue.title,
      prompt: cuePrompt(score, cue),
      durationSeconds: cueLength(document, catalog, cue).seconds,
      lyrics: cue.lyrics,
    }));
}

/** How long a cue must run, and what its music model will be asked for. */
export function cueLength(document: ProjectDocument, catalog: MediaCatalog, cue: ProjectCue) {
  const wanted = cueSeconds(document.shots, cue, (shot) => shotSeconds(shot, document, catalog));
  const music = pickMusicModel(catalog, document.settings.musicModelId);
  return { wanted, model: music, ...musicLength(music, wanted) };
}

/** One cue of the score, on its own, for a new take of it. */
export function compileCue(
  name: string,
  document: ProjectDocument,
  catalog: MediaCatalog,
  cueId: string,
): Workflow {
  const score = projectScore(document);
  const cue = score?.cues.find((candidate) => candidate.id === cueId);
  if (!score || !cue) throw new Error(t("This cue no longer exists."));
  if (!cueShots(document.shots, cue).length)
    throw new Error(t("Choose the shots this cue plays under first."));
  const prompt = cuePrompt(score, cue);
  if (!prompt) throw new Error(t("Describe this cue before composing it."));
  const { model, seconds } = cueLength(document, catalog, cue);
  if (!model) throw new Error(t("No music model on this account, so the film has no score."));
  const caps = musicCapabilities(model.id);
  const lyrics = caps.lyrics !== "none" ? cue.lyrics?.trim() : undefined;
  if (caps.lyrics === "required" && !lyrics)
    throw new Error(
      t("{model} sings words: add lyrics to every cue, or choose another music model.", {
        model: model.name,
      }),
    );
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    edges: [],
    nodes: [
      {
        id: cueNodeId(cue),
        type: "music",
        label: t("Music: {title}", { title: cue.title }),
        position: { x: 0, y: 0 },
        params: {
          model: model.id,
          prompt,
          ...(seconds !== undefined ? { durationSeconds: seconds } : {}),
          ...(lyrics ? { lyrics } : {}),
          instrumental: !lyrics && caps.instrumental && caps.lyrics !== "none",
        },
      },
    ],
  };
}

export function compileProject(
  name: string,
  document: ProjectDocument,
  catalog: MediaCatalog,
  onlyShotId?: string,
): Workflow {
  return compileProjectWithNotes(name, document, catalog, onlyShotId).workflow;
}

/** The video model a shot renders with: its own choice among the models that
 * fit its mode, else the project's routing (the cheapest of the project's
 * family). The same answer the shot editor shows and the score times with. */
export function shotVideoModel(
  shot: ProjectShot | undefined,
  document: Pick<ProjectDocument, "settings">,
  catalog: MediaCatalog,
) {
  const mode = shot?.mode ?? "text";
  const direction = mode === "continuation" ? "image" : mode;
  const candidates = catalog.models.filter(
    (model) =>
      !model.offline &&
      ["video", "imageToVideo", "referenceToVideo"].includes(model.mediaType) &&
      videoDirection(model) === direction,
  );
  const preferredId = document.settings.videoModelId;
  const routing = routeModels(catalog, preferredId);
  const routed =
    mode === "reference"
      ? routing.reference
      : mode === "image" || mode === "continuation"
        ? routing.fromImage
        : routing.text;
  return shot?.modelId
    ? candidates.find((candidate) => candidate.id === shot.modelId)
    : candidates.find(
        (candidate) =>
          candidate.id === routed?.id &&
          (!preferredId || familyStem(candidate.id) === familyStem(preferredId)),
      );
}

/**
 * The prompt the compiler will write for a shot, for the surfaces that show
 * it or improve it: the same model, seconds, references and direction, so
 * what is previewed is what renders.
 */
export function composeProjectShot(
  shot: ProjectShot,
  document: ProjectDocument,
  catalog: MediaCatalog,
): ComposedPrompt {
  const model = shotVideoModel(shot, document, catalog);
  const mode = shot.mode === "continuation" ? "continuation" : shot.mode;
  return composeShotPrompt({
    shot,
    direction: projectDirection(document),
    bible: document.bible,
    model,
    mode,
    seconds: resolveShotDuration(shot, model).seconds,
    references: mode === "reference" ? shotReferences(shot, document.bible, model) : [],
  });
}

/** How long a shot's take runs, as the compiler will ask for it. */
export function shotSeconds(
  shot: ProjectShot,
  document: Pick<ProjectDocument, "settings">,
  catalog: MediaCatalog,
): number {
  return resolveShotDuration(shot, shotVideoModel(shot, document, catalog)).seconds;
}

/** The edit model an opening image is composed with: the shot's choice while
 * it is still offered, the app's automatic pick otherwise. */
export function openingImageModel(shot: ProjectShot, catalog: MediaCatalog) {
  return (
    imageEditModels(catalog).find((candidate) => candidate.id === shot.imageModelId) ??
    defaultEditModel(catalog)
  );
}

export function compileOpeningImage(
  shot: ProjectShot,
  name: string,
  catalog: MediaCatalog,
  aspectRatio?: string,
): Workflow {
  const model = openingImageModel(shot, catalog);
  if (!model || !shot.imagePrompt.trim())
    throw new Error(t("Choose an image model and describe your opening image."));
  if (!shot.imageReferenceIds.length || shot.imageReferenceIds.length > 3)
    throw new Error(t("Choose one to three reference images."));
  const target = `image-${shot.id}`;
  const nodes: WorkflowNode[] = shot.imageReferenceIds.map((artifactId, index) => ({
    id: `reference-${index}`,
    type: "asset",
    label: "",
    position: { x: 0, y: index * 100 },
    params: { artifactId },
  }));
  nodes.push({
    id: target,
    type: "imageEdit",
    label: shot.title,
    position: { x: 300, y: 0 },
    // The frame opens the shot, so it comes out in the project's format.
    params: { model: model.id, prompt: shot.imagePrompt, aspectRatio: aspectRatio ?? "" },
  });
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nodes,
    edges: nodes
      .filter((node) => node.type === "asset")
      .map((node) => ({
        id: `${node.id}-${target}`,
        source: node.id,
        target,
        targetPort: "images",
      })),
  };
}

/** Role and entry identity travel in the frozen run for restart attachment. */
export function compileBibleReference(
  entry: ProjectBibleEntry,
  role: BibleRole,
  catalog: MediaCatalog,
  name: string,
  style?: string,
): Workflow {
  if (role === "voice") throw new Error(t("Choose an image reference role."));
  const prompt = referencePromptOf(entry, role)?.trim() || portraitPrompt(entry, role, style);
  const target = `bible-${entry.id}-${role}`;
  const base = { id: crypto.randomUUID(), name, createdAt: Date.now(), updatedAt: Date.now() };
  // A sheet drawn from the portrait keeps the face the person already chose;
  // one drawn from text would be a new face that happens to match the traits.
  const portrait = role === "sheet" ? sheetSource(entry) : undefined;
  if (portrait) {
    const editModel =
      imageEditModels(catalog).find((candidate) => candidate.id === entry.editModelId) ??
      defaultEditModel(catalog);
    if (!editModel) throw new Error(t("Choose an available image model for this reference."));
    const source = `${target}-source`;
    return {
      ...base,
      nodes: [
        {
          id: source,
          type: "asset",
          label: "",
          position: { x: 0, y: 0 },
          params: { artifactId: portrait },
        },
        {
          id: target,
          type: "imageEdit",
          label: entry.name,
          position: { x: 300, y: 0 },
          params: {
            model: editModel.id,
            prompt: `Keep the identity of the person in image 1 exactly: the same face, hair, build and outfit. ${prompt}`,
            bibleEntryId: entry.id,
            bibleRole: role,
          },
        },
      ],
      edges: [{ id: `${source}-${target}`, source, target, targetPort: "images" }],
    };
  }
  const modelId = entry.imageModelId || pickPortraitModel(catalog)?.id;
  const model = catalog.models.find(
    (candidate) =>
      candidate.id === modelId && candidate.mediaType === "image" && !candidate.offline,
  );
  if (!model) throw new Error(t("Choose an available image model for this reference."));
  const ratio = entry.kind === "location" ? "16:9" : "1:1";
  const ratios = model.constraints?.aspectRatios ?? model.constraints?.aspect_ratios;
  const params = {
    model: model.id,
    prompt,
    aspectRatio: ratios && !ratios.includes(ratio) ? "" : ratio,
    bibleEntryId: entry.id,
    bibleRole: role,
  };
  return {
    ...base,
    edges: [],
    nodes: [{ id: target, type: "image", label: entry.name, position: { x: 0, y: 0 }, params }],
  };
}

export async function quoteProject(
  workflow: Workflow,
  catalog: MediaCatalog,
): Promise<WorkflowCostEstimate> {
  return estimateWorkflowCost(workflow, catalog, await fetchVideoQuotes(workflow, catalog));
}

/** Reserve against one opening balance snapshot before parallel jobs start.
 * Fresh balance checks catch spending outside this run, without subtracting
 * already charged reservations from the current balance a second time. */
export function productionBudget(estimate: WorkflowCostEstimate, ceiling: number) {
  const costs = nodeCostMap(estimate);
  let reserved = 0;
  let openingBalance: ReturnType<typeof carpeDiemGetCredits> | undefined;
  return async (node: WorkflowNode) => {
    const item = estimate.nodes.find((entry) => entry.nodeId === node.id);
    if (item?.kind === "free") return;
    const cost = costs[node.id];
    if (cost === undefined || !Number.isFinite(cost) || cost < 0)
      throw new Error(t("Price unavailable. Choose another model or try quoting again."));
    if (!Number.isFinite(ceiling) || ceiling < 0 || reserved + cost > ceiling)
      throw new Error(t("This generation exceeds the spend ceiling."));
    reserved += cost;
    const allocation = reserved;
    openingBalance ??= carpeDiemGetCredits();
    try {
      const initial = await openingBalance;
      if (!Number.isFinite(initial.availableCredits) || initial.availableCredits < allocation)
        throw new Error(t("You do not have enough credits for this generation."));
      const current = await carpeDiemGetCredits();
      if (!Number.isFinite(current.availableCredits) || current.availableCredits < cost)
        throw new Error(t("You do not have enough credits for this generation."));
    } catch (error) {
      reserved -= cost;
      throw error;
    }
  };
}
