/**
 * The composer: a pack becomes the requests it sends, a sheet is one paid
 * request cut into nine, and a finished job files its images (named, in the
 * composition's folder) whoever is awake when it lands (ADR-0018).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
const cut = vi.hoisted(() => ({ cells: vi.fn() }));
vi.mock("../lib/studio/bible/sheet", () => ({ cutSheetCells: cut.cells }));

import type { MediaJob } from "../lib/studio/async-job";
import {
  COMPOSE_FAILED_EVENT,
  COMPOSE_RESULT_EVENT,
  type ComposeJobContext,
  readComposeFailures,
} from "../lib/studio/compose/jobs";
import {
  composePacks,
  customPack,
  IDENTITY_LOCK,
  SHEET_CELLS,
  sheetable,
} from "../lib/studio/compose/packs";
import { compositionRequests, planComposition } from "../lib/studio/compose/plan";
import { recoverStandaloneImageJob } from "../lib/studio/image-job-recovery";
import type { EditCaps } from "../lib/studio/retouch/request";

const caps: EditCaps = {
  maxInputs: 3,
  resolutions: ["1K"],
  defaultResolution: "1K",
  qualities: [],
  aspectRatios: ["1:1", "16:9", "9:16"],
};
const pack = (id: string) => {
  const found = composePacks().find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("a composition's plan", () => {
  it("sends one request per shot, each holding the subject", () => {
    const angles = pack("angles");
    const plan = planComposition(angles, "separate", caps, 10.8);
    expect(plan).toMatchObject({ mode: "separate", jobs: 4, costCredits: 43.2 });
    const requests = compositionRequests(plan, angles, caps, "data:image/png;base64,AA", {
      model: "ideogram-v4-5-edit",
      resolution: "1K",
      aspectRatio: "16:9",
    });
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.base).toBe("/image/multi-edit");
      expect(String(request.body.prompt).startsWith(IDENTITY_LOCK)).toBe(true);
      expect(request.body.images).toEqual(["data:image/png;base64,AA"]);
      expect(request.body.aspect_ratio).toBe("16:9");
    }
    expect(new Set(requests.map((request) => request.body.prompt)).size).toBe(4);
  });

  it("leaves out a frame the model does not offer, and says so", () => {
    const formats = pack("formats");
    const plan = planComposition(formats, "separate", caps, 10);
    expect(plan.shots.map((shot) => shot.aspectRatio)).toEqual(["1:1", "9:16", "16:9"]);
    expect(plan.skipped.map((shot) => shot.aspectRatio)).toEqual(["4:5"]);
    const requests = compositionRequests(plan, formats, caps, "data:x", { model: "m" });
    expect(requests.map((request) => request.body.aspect_ratio)).toEqual(["1:1", "9:16", "16:9"]);
  });

  it("draws a nine-shot pack as one square sheet for the price of one image", () => {
    const sheet = pack("character");
    expect(sheetable(sheet)).toBe(true);
    const plan = planComposition(sheet, "sheet", caps, 10.8);
    expect(plan).toMatchObject({ mode: "sheet", jobs: 1, costCredits: 10.8 });
    const [request, ...rest] = compositionRequests(plan, sheet, caps, "data:x", { model: "m" });
    expect(rest).toHaveLength(0);
    expect(request.body.aspect_ratio).toBe("1:1");
    expect(String(request.body.prompt)).toContain("three by three grid");
    expect(String(request.body.prompt)).toContain("9. ");
  });

  it("makes a four-shot pack one by one even when a sheet was asked for", () => {
    expect(sheetable(pack("angles"))).toBe(false);
    expect(planComposition(pack("angles"), "sheet", caps, undefined).mode).toBe("separate");
  });

  it("takes one shot per written line, nine at most", () => {
    const own = customPack(" a\n\nb \n".concat("x\n".repeat(20)));
    expect(own.shots).toHaveLength(SHEET_CELLS);
    expect(own.shots[0]).toMatchObject({ label: "a", instruction: "a" });
    expect(planComposition(customPack(""), "separate", caps, 1).jobs).toBe(0);
  });
});

function job(context: ComposeJobContext, overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: overrides.id ?? "job-1",
    kind: "image",
    model: "ideogram-v4-5-edit",
    prompt: "Keep the subject",
    extension: "png",
    status: "completed",
    artifactPath: "/gallery/0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c01.png",
    artifactFileName: "0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c01.png",
    artifactBytes: 10,
    source: `compose:${context.group}`,
    clientContext: context as unknown as Record<string, unknown>,
    createdAt: "2026-10-06T10:00:00Z",
    updatedAt: "2026-10-06T10:01:00Z",
    ...overrides,
  };
}

const base: ComposeJobContext = {
  v: 1,
  group: "g1",
  sourceId: "source.png",
  pack: "angles",
  mode: "separate",
  collectionId: "folder-1",
  labels: ["Profile"],
  index: 0,
  of: 4,
};

describe("a finished composition job", () => {
  let saved = 0;
  beforeEach(() => {
    saved = 0;
    window.localStorage.clear();
    cut.cells.mockReset();
    tauri.invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === "carpe_diem_media_read_artifact") return "AAAA";
      if (command === "carpe_diem_media_save_artifact") {
        saved += 1;
        const name = `0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4d${String(saved).padStart(2, "0")}.png`;
        return { path: `/gallery/${name}`, fileName: name, bytes: 5 };
      }
      return undefined;
    });
  });

  it("is named, filed in its folder and announced", async () => {
    const results: unknown[] = [];
    const onResult = (event: Event) => results.push((event as CustomEvent).detail);
    window.addEventListener(COMPOSE_RESULT_EVENT, onResult);
    await recoverStandaloneImageJob(job(base));
    window.removeEventListener(COMPOSE_RESULT_EVENT, onResult);

    const id = "0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c01.png";
    expect(tauri.invoke).toHaveBeenCalledWith("studio_artifact_save", {
      request: { id, title: "Profile" },
    });
    expect(tauri.invoke).toHaveBeenCalledWith("studio_library_mark", {
      request: { ids: [id], collectionId: "folder-1" },
    });
    expect(tauri.invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
    expect(results).toEqual([{ group: "g1", jobId: "job-1", artifactIds: [id] }]);
  });

  it("cuts a sheet into nine named images, once", async () => {
    cut.cells.mockResolvedValue(Array.from({ length: 9 }, (_, index) => `cell${index}`));
    const labels = pack("character").shots.map((shot) => shot.label);
    const sheet = job({ ...base, mode: "sheet", labels, of: 1 });
    await recoverStandaloneImageJob(sheet);
    expect(cut.cells).toHaveBeenCalledWith(
      "data:image/png;base64,AAAA",
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    expect(saved).toBe(9);
    const marked = tauri.invoke.mock.calls.find(([command]) => command === "studio_library_mark");
    const request = marked?.[1] as { request: { ids: string[] } } | undefined;
    expect(request?.request.ids).toHaveLength(10);
  });

  it("records a failure and settles the row", async () => {
    let failed = false;
    const onFailed = () => {
      failed = true;
    };
    window.addEventListener(COMPOSE_FAILED_EVENT, onFailed);
    await recoverStandaloneImageJob(job(base, { status: "failed", error: "Upstream refused" }));
    window.removeEventListener(COMPOSE_FAILED_EVENT, onFailed);
    expect(failed).toBe(true);
    expect(readComposeFailures("g1")).toMatchObject([{ jobId: "job-1", label: "Profile" }]);
    expect(tauri.invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
  });
});
