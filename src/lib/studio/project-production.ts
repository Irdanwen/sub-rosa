import { t } from "../i18n";
import { carpeDiemGetCredits } from "../tauri";
import type { MediaCatalog } from "./types";
import type { ProjectDocument, ProjectShot } from "./projects";
import { bibleNameInUse } from "./projects";
import { portraitPrompt } from "./bible/portrait";
import type { BibleRole } from "./bible/types";
import type { ProjectBibleEntry } from "./projects";
import { compileShotList } from "./workflow/compile";
import {
  estimateWorkflowCost,
  fetchVideoQuotes,
  nodeCostMap,
  type WorkflowCostEstimate,
} from "./workflow/cost";
import { validateWorkflow } from "./workflow/validator";
import type { Workflow, WorkflowNode } from "./workflow/schema";

export function compileProjectWithNotes(
  name: string,
  document: ProjectDocument,
  catalog: MediaCatalog,
  onlyShotId?: string,
): { workflow: Workflow; notes: string[] } {
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
    withScore: onlyShotId ? false : document.settings.withScore,
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

export function compileProject(
  name: string,
  document: ProjectDocument,
  catalog: MediaCatalog,
  onlyShotId?: string,
): Workflow {
  return compileProjectWithNotes(name, document, catalog, onlyShotId).workflow;
}

export function compileOpeningImage(shot: ProjectShot, name: string): Workflow {
  if (!shot.imageModelId || !shot.imagePrompt.trim())
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
    params: { model: shot.imageModelId, prompt: shot.imagePrompt },
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
): Workflow {
  if (role === "voice") throw new Error(t("Choose an image reference role."));
  const model = catalog.models.find(
    (candidate) =>
      candidate.id === entry.imageModelId && candidate.mediaType === "image" && !candidate.offline,
  );
  if (!model) throw new Error(t("Choose an available image model for this reference."));
  const prompt = entry.imagePrompt?.trim() || portraitPrompt(entry, role);
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
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    edges: [],
    nodes: [
      {
        id: `bible-${entry.id}-${role}`,
        type: "image",
        label: entry.name,
        position: { x: 0, y: 0 },
        params,
      },
    ],
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
