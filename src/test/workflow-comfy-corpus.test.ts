// The ComfyUI importer against real files: the official templates in
// fixtures/comfy-corpus, translated against the catalog Carpe Diem published
// the day they were frozen. The report snapshot is the measurement: every
// node type that translates, and every one that is left out and why.

import { describe, expect, it } from "vitest";
import type { MediaCatalog, MediaType } from "../lib/studio/types";
import { translateComfy } from "../lib/studio/workflow/comfy/translate";
import models from "./fixtures/comfy-corpus/catalog.json";

const FILES = import.meta.glob<{ default: unknown }>("./fixtures/comfy-corpus/workflows/*.json", {
  eager: true,
});

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: (models as Array<{ id: string; mediaType: string }>).map((model) => ({
    id: model.id,
    mediaType: model.mediaType as MediaType,
    name: model.id,
    offline: false,
  })),
};

function nameOf(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.json$/, "");
}

/** One file's import, reduced to what a reader of the diff needs. */
function summary(json: unknown) {
  const { workflow, report, usable } = translateComfy(json, catalog);
  const steps = [...workflow.nodes, ...(workflow.blocks ?? []).flatMap((block) => block.nodes)];
  const count = (values: string[]) => {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    usable,
    steps: count(steps.map((step) => step.type)),
    models: [
      ...new Set(
        steps.map((step) => step.params.model).filter((model): model is string => !!model),
      ),
    ].sort(),
    translated: count(report.translated.map((entry) => `${entry.comfyType} → ${entry.as}`)),
    dropped: count(report.dropped.map((entry) => `${entry.comfyType}: ${entry.reason}`)),
    adjusted: report.adjusted.length,
    missing: report.missing.length,
  };
}

const entries = Object.entries(FILES)
  .map(([path, module]) => [nameOf(path), module.default] as const)
  .sort(([a], [b]) => a.localeCompare(b));

describe("ComfyUI importer on the official templates", () => {
  it("has the corpus", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
  });

  it("matches the frozen report", async () => {
    const reports = Object.fromEntries(entries.map(([name, json]) => [name, summary(json)]));
    await expect(`${JSON.stringify(reports, null, 2)}\n`).toMatchFileSnapshot(
      "./fixtures/comfy-corpus/report.json",
    );
  });

  it("picks the model the file names, from the same provider and direction", () => {
    const picked = (name: string) => {
      const json = entries.find(([entry]) => entry === name)?.[1];
      return summary(json).models;
    };
    expect(picked("api_kling_v3_flf2v")).toEqual(["kling-v3-pro-image-to-video"]);
    expect(picked("api_seedance2_5_r2v")).toEqual(["seedance-2-5-reference-to-video-basic"]);
    expect(picked("api_ideogram_v4_5_t2i")).toEqual(["ideogram-v4-5"]);
    expect(picked("api_bytedance_seedream_5_0_pro_image_edit")).toEqual(["seedream-v5-pro-edit"]);
    expect(picked("api_openai_gpt_image_2_image_edit")).toEqual(["gpt-image-2-edit"]);
    expect(picked("templates-character_sheet")).toEqual(["nano-banana-pro-edit"]);
    expect(picked("api_minimax_h3_max_flf2v")).toContain("minimax-h3-max-image-to-video");
    // No HeyGen model, and no Kling model that changes a clip: none, rather
    // than another provider's or one that starts from a prompt.
    expect(picked("api_heygen_talking_photo")).toEqual([]);
    expect(picked("api_kling_o3_video_edit")).toEqual([]);
  });

  it("leaves no node type out without a reason", () => {
    for (const [, json] of entries) {
      const { report } = translateComfy(json, catalog);
      for (const entry of report.dropped) expect(entry.reason.trim()).not.toBe("");
    }
  });
});
