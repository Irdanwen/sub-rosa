/**
 * Prices while editing: a video step is quoted once per set of pricing
 * settings with a single attempt (a rate limit costs a figure, never a
 * wait), and the pre-spend dialog holds the person's ceiling.
 */

import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { RunCostDialog } from "../components/studio/workflow/RunCostDialog";
import {
  resetLiveQuotesForTests,
  useLiveQuotes,
} from "../components/studio/workflow/useLiveQuotes";
import type { WorkflowCostEstimate } from "../lib/studio/workflow/cost";
import { defaultParams, type WorkflowNode } from "../lib/studio/workflow/schema";
import { readSpendCeiling } from "../lib/studio/workflow/spend-ceiling";
import type { MediaCatalog } from "../lib/studio/types";

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  priceMultiplier: 1,
  models: [{ id: "kling-2.5-turbo-pro", name: "Kling", mediaType: "video", offline: false }],
};

function video(id: string, duration: string): WorkflowNode {
  return {
    id,
    type: "video",
    label: "",
    position: { x: 0, y: 0 },
    params: { ...defaultParams("video"), model: "kling-2.5-turbo-pro", prompt: "A car", duration },
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  resetLiveQuotesForTests();
  window.localStorage.clear();
});

describe("live quotes", () => {
  it("quotes each set of pricing settings once, and a refusal costs only the figure", async () => {
    mocks.invoke.mockImplementation(
      async (_command: string, args: { request: { body: { duration?: string } } }) =>
        args.request.body.duration === "10s"
          ? { ok: false, status: 429, json: { error: "Slow down." } }
          : { ok: true, status: 200, json: { quote: 0.5 } },
    );
    const nodes = [video("a", "5s"), video("b", "5s"), video("c", "10s")];
    const { result } = renderHook(() => useLiveQuotes({ nodes }, catalog));
    await waitFor(() => expect(result.current.get("a")).toBe(50), { timeout: 3000 });
    expect(result.current.get("b")).toBe(50);
    expect(result.current.has("c")).toBe(false);
    // Two distinct settings, one call each: no retry of the refused one.
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("the ceiling in the pre-spend dialog", () => {
  const estimate: WorkflowCostEstimate = {
    credits: 120,
    metered: 0,
    quotable: 0,
    nodes: [
      { nodeId: "v", type: "video", label: "Shot", kind: "flat", credits: 120, quotable: false },
    ],
  };

  it("refuses to start a run estimated above the ceiling, and remembers the ceiling", async () => {
    const onConfirm = vi.fn();
    render(<RunCostDialog estimate={estimate} onConfirm={onConfirm} onClose={() => {}} />);
    const field = screen.getByPlaceholderText("No limit");
    await userEvent.type(field, "100");
    expect(readSpendCeiling()).toBe(100);
    expect(screen.getByRole("alert")).toHaveTextContent("above your ceiling");
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDisabled();
    await userEvent.clear(field);
    expect(readSpendCeiling()).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
