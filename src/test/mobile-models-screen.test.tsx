import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsScreen } from "../components/mobile/screens/SectionScreen";

const mocks = vi.hoisted(() => ({
  listVeniceModels: vi.fn(),
  setVeniceModel: vi.fn(async () => ({})),
  dispatch: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  listVeniceModels: mocks.listVeniceModels,
  setVeniceModel: mocks.setVeniceModel,
  shareText: vi.fn(),
}));
vi.mock("../lib/diagnostics-report", () => ({ diagnosticsReportText: vi.fn() }));
vi.mock("../lib/model-privacy", () => ({
  dispatchProviderModelSettingsChanged: mocks.dispatch,
}));
vi.mock("../lib/platform-capabilities", () => ({ usePlatformCapabilities: () => null }));

describe("the phone's Models screen", () => {
  beforeEach(() => {
    mocks.listVeniceModels.mockImplementation(async (mode: string) => ({
      mode,
      modelType: "text",
      selectedModel: mode === "generation" ? "m-fast" : "m-other",
      models: [
        { provider: "cd", id: "m-fast", name: "Fast model", modelType: "text" },
        { provider: "cd", id: "m-deep", name: "Deep model", modelType: "text" },
        { provider: "cd", id: "m-other", name: "Other", modelType: "text" },
      ],
    }));
  });

  it("shows each default by name and sets a new one through the bridge", async () => {
    render(<ModelsScreen onBack={() => {}} />);
    const text = await screen.findByRole("button", { name: "Text model: Fast model" });
    fireEvent.click(text);
    fireEvent.click(await screen.findByText("Deep model"));
    await waitFor(() => expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "m-deep"));
    expect(mocks.dispatch).toHaveBeenCalledWith({ mode: "generation", modelId: "m-deep" });
    expect(
      await screen.findByRole("button", { name: "Text model: Deep model" }),
    ).toBeInTheDocument();
  });
});
