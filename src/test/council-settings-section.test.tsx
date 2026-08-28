import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilSeat, SittingPlan } from "../lib/council";

const councilPlan = vi.fn<(input: { councilId?: string }) => Promise<SittingPlan>>();
const councilCycles = vi.fn<() => Promise<[]>>();
const councilSeatModels = vi.fn();
const setCouncilSeatModel = vi.fn();
const listVeniceModels = vi.fn();

vi.mock("../lib/council", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/council")>()),
  councilPlan: (input: { councilId?: string }) => councilPlan(input),
  councilCycles: (...args: unknown[]) => councilCycles(...(args as [])),
  councilVerdicts: () => Promise.resolve([]),
  councilSeatModels: (...args: unknown[]) => councilSeatModels(...(args as [])),
  setCouncilSeatModel: (...args: unknown[]) => setCouncilSeatModel(...(args as [])),
}));

vi.mock("../lib/tauri", () => ({
  listVeniceModels: (...args: unknown[]) => listVeniceModels(...(args as [])),
}));

const { CouncilSettingsSection } = await import("../components/settings/CouncilSettingsSection");

const seat = (id: string, name: string, model: string, family: string): CouncilSeat => ({
  id,
  name,
  role: "position",
  charge: `What ${name} is for.`,
  model,
  modelFamily: family,
});

function plan(overrides: Partial<SittingPlan> = {}): SittingPlan {
  return {
    councilId: "mandate",
    seats: [seat("shape", "Shape", "zai-org-glm-5-2", "glm")],
    minModelCalls: 5,
    maxModelCalls: 9,
    reusedFamilies: [],
    reusedByChoice: false,
    situation: null,
    calls: [],
    ...overrides,
  };
}

/** The two rosters are different councils; giving them the same seat would
 * make every query ambiguous, and hide which of the two a test is looking at. */
function plansFor(mandate: Partial<SittingPlan> = {}) {
  return (input: { councilId?: string }) =>
    Promise.resolve(
      input.councilId === "verdict"
        ? plan({
            councilId: "verdict",
            seats: [seat("conformance", "Conformance", "kimi-k2-6", "kimi")],
          })
        : plan(mandate),
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  councilPlan.mockImplementation(plansFor());
  councilCycles.mockResolvedValue([]);
  councilSeatModels.mockResolvedValue({ seats: {} });
  setCouncilSeatModel.mockResolvedValue({ seats: { shape: "kimi-k2-6" } });
  listVeniceModels.mockResolvedValue({
    models: [{ id: "zai-org-glm-5-2" }, { id: "kimi-k2-6" }],
  });
});

describe("choosing what a seat runs on", () => {
  it("offers the catalog, and leaves the automatic choice as the default", async () => {
    render(<CouncilSettingsSection />);

    const picker = await screen.findByLabelText("Model for Shape");
    // Nothing is pinned yet, so the row still reads as a choice not made -- and
    // names the model that would be used anyway.
    expect((picker as HTMLSelectElement).value).toBe("");
    expect(await screen.findByText("Chosen for me (zai-org-glm-5-2)")).toBeInTheDocument();
    // Scoped to this seat's picker: both rosters offer the same catalog.
    expect(within(picker).getByRole("option", { name: "kimi-k2-6" })).toBeInTheDocument();
  });

  it("pins a seat and re-reads both rosters", async () => {
    const user = userEvent.setup();
    render(<CouncilSettingsSection />);

    const picker = await screen.findByLabelText("Model for Shape");
    await user.selectOptions(picker, "kimi-k2-6");

    await waitFor(() => expect(setCouncilSeatModel).toHaveBeenCalledWith("shape", "kimi-k2-6"));
    // Both councils are re-read: pinning one seat moves the seats around it,
    // because the automatic assignment fills around what is now taken.
    await waitFor(() => expect(councilPlan.mock.calls.length).toBeGreaterThanOrEqual(4));
  });

  it("blames the right thing when two seats share a family", async () => {
    // The catalog running thin and the user pinning two seats onto one family
    // produce the same roster and call for different sentences. Blaming the
    // catalog for a choice someone made is a small lie.
    councilPlan.mockImplementation(plansFor({ reusedFamilies: ["glm"], reusedByChoice: true }));
    render(<CouncilSettingsSection />);

    expect(await screen.findByText(/pinned to the same model family/)).toBeInTheDocument();
    expect(screen.queryByText(/catalog offers fewer model families/)).toBeNull();
  });

  it("says it is the catalog when it is the catalog", async () => {
    councilPlan.mockImplementation(plansFor({ reusedFamilies: ["glm"], reusedByChoice: false }));
    render(<CouncilSettingsSection />);

    expect(await screen.findByText(/catalog offers fewer model families/)).toBeInTheDocument();
    expect(screen.queryByText(/pinned to the same model family/)).toBeNull();
  });

  it("still shows what each seat runs on when the catalog cannot be read", async () => {
    // Offline, or signed out. The screen degrades to what it was before it
    // could be edited rather than to an empty picker.
    listVeniceModels.mockRejectedValue(new Error("offline"));
    render(<CouncilSettingsSection />);

    expect(await screen.findAllByText("zai-org-glm-5-2")).not.toHaveLength(0);
    expect(screen.queryByLabelText("Model for Shape")).toBeNull();
  });
});
