// Every shipped app, judged as the two shells judge it before a run: its
// fields all show, an empty picture is named by its field, a filled form is
// runnable and priced, and each result it promises comes from a step a run
// can leave a result on. The catalog is derived from the templates so the
// test follows them.

import { describe, expect, it } from "vitest";
import { costSummary } from "../components/studio/workflow/RunCostDialog";
import { canShowResult, isApp, shownFields } from "../lib/studio/workflow/app";
import { appBlocker, appEstimate, appGraph } from "../lib/studio/workflow/app-run";
import { visibleStep } from "../lib/studio/workflow/lift";
import { type IOKind, outputKindOf, type Workflow } from "../lib/studio/workflow/schema";
import { resolveTemplateModels } from "../lib/studio/workflow/template-models";
import { templateWorkflows } from "../lib/studio/workflow/templates";
import { assetKindOf, catalogFor, filled, filledApp } from "./workflow-apps-fixtures";

/** The setting kinds both shells draw a control for. */
const DRAWN = new Set(["text", "string", "number", "boolean", "enum", "model", "artifact"]);

/** What a result shown for this step is: a step's own kind, or what reaches
 * an output, a gate or a relay. */
function resultKindOf(workflow: Workflow, id: string): IOKind {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const node = nodeById.get(id);
  if (!node) return "none";
  if (node.type === "output" || node.type === "gate" || node.type === "relay") {
    const inbound = workflow.edges.find((edge) => edge.target === id);
    return inbound ? resultKindOf(workflow, inbound.source) : "none";
  }
  return outputKindOf(node, { nodeById, edges: workflow.edges });
}

/** What each app gives, as the person was told. */
const OUTPUT_KINDS: Record<string, IOKind[]> = {
  "template-album-cover": ["image"],
  "template-music-from-mood": ["audio"],
  "template-try-it-on": ["image"],
  "template-covers-from-list": ["image"],
  "template-character-sheet": ["image"],
  "template-podcast-intro": ["audio"],
  "template-before-and-after": ["image"],
  "template-upscale-for-print": ["image"],
  "template-post-with-caption": ["image", "text"],
  "template-read-in-another-language": ["audio"],
  "template-product-studio-shot": ["image"],
  "template-product-to-video": ["image", "video"],
  "template-product-in-hand": ["image"],
  "template-ad-in-the-style-of": ["image", "video"],
  "template-exploded-view": ["image", "video"],
  "template-product-placement": ["image", "video"],
  "template-reformat-for-every-format": ["image", "image", "image"],
  "template-video-thumbnail": ["image"],
  "template-animated-logo": ["image", "video"],
  "template-storyboard-to-video": ["image", "video"],
  "template-editorial-to-motion": ["video"],
  "template-extend-a-clip": ["video"],
  "template-relight-a-portrait": ["image"],
  "template-coverage-from-one-shot": ["image"],
  "template-outfit-shoot": ["image"],
  "template-remove-an-object": ["image"],
  "template-sound-effects-pack": ["audio"],
  "template-song-from-a-story": ["audio"],
  "template-two-voice-dialogue": ["audio"],
  "template-talking-photo": ["video"],
  "template-restyle-a-clip": ["video"],
  "template-recast-a-clip": ["video"],
};

const templates = templateWorkflows();
const catalog = catalogFor(templates);
const apps = templates.filter(isApp);

describe("the catalog the matrix is judged against", () => {
  it("offers every template's models as they are, so nothing is swapped", () => {
    for (const template of templates) {
      const resolved = resolveTemplateModels(template, catalog);
      expect([template.id, resolved.missing]).toEqual([template.id, []]);
      for (const node of template.nodes)
        expect([
          template.id,
          node.id,
          resolved.workflow.nodes.find((n) => n.id === node.id)?.params.model,
        ]).toEqual([template.id, node.id, node.params.model]);
    }
  });

  it("covers every app with an expected list of results", () => {
    expect(Object.keys(OUTPUT_KINDS).sort()).toEqual(apps.map((app) => app.id).sort());
  });
});

describe.each(apps.map((app) => [app.id, app] as const))("the app %s", (_id, template) => {
  const app = template.app as NonNullable<Workflow["app"]>;
  const graph = appGraph(template);
  const fullTemplate = filledApp(template, catalog);

  it("shows every field it declares, with a control both shells draw", () => {
    const shown = shownFields(app, template, catalog);
    expect(shown.map((entry) => entry.field)).toEqual(app.fields);
    for (const entry of shown)
      expect([entry.field.param, DRAWN.has(entry.param.type)]).toEqual([entry.field.param, true]);
  });

  it("names the field an empty picture, clip or track blocks on", () => {
    const empty = app.fields
      .map((field) => ({ field, node: template.nodes.find((node) => node.id === field.nodeId) }))
      .find(
        ({ field, node }) =>
          field.param === "artifactId" && node && !filled(node.params.artifactId),
      );
    const blocker = appBlocker(graph, app);
    if (!empty?.node) {
      expect(blocker).toBeUndefined();
      return;
    }
    const noun = { image: "picture", video: "clip", audio: "track" }[assetKindOf(empty.node)];
    expect(blocker).toBe(`${empty.field.label ?? empty.node.label}: pick a ${noun}.`);
  });

  it("runs once its fields are filled, at a price", () => {
    const full = appGraph(fullTemplate);
    expect(appBlocker(full, app)).toBeUndefined();
    const estimate = appEstimate(full, catalog);
    expect(estimate.credits + estimate.metered).toBeGreaterThan(0);
    expect(costSummary(estimate)).not.toBe("");
  });

  it("promises only results a run can leave", () => {
    const producible = new Set(
      graph.effective.nodes.flatMap((node) => visibleStep(graph.view, node.id) ?? []),
    );
    for (const id of app.outputs) {
      const node = template.nodes.find((entry) => entry.id === id);
      expect([id, node && canShowResult(node), producible.has(id)]).toEqual([id, true, true]);
    }
  });

  it("gives what it says it gives", () => {
    const kinds = app.outputs.map((id) => resultKindOf(template, id));
    expect(kinds).not.toContain("none");
    expect([...kinds].sort()).toEqual([...OUTPUT_KINDS[template.id]].sort());
  });
});
