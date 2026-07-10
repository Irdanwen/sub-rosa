import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsSection } from "../components/settings/MemorySettingsSection";
import type { MemoryDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  memoryList: vi.fn(),
  memoryAdd: vi.fn(),
  memoryUpdate: vi.fn(),
  memoryDelete: vi.fn(),
  memoryClear: vi.fn(),
  memorySetSettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  memoryList: mocks.memoryList,
  memoryAdd: mocks.memoryAdd,
  memoryUpdate: mocks.memoryUpdate,
  memoryDelete: mocks.memoryDelete,
  memoryClear: mocks.memoryClear,
  memorySetSettings: mocks.memorySetSettings,
}));

function memory(overrides: Partial<MemoryDto> = {}): MemoryDto {
  return {
    id: "mem1",
    text: "Prefers answers in French.",
    source: "auto",
    importance: 1,
    disabled: false,
    hasEmbedding: false,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memoryList.mockResolvedValue({
    items: [
      memory(),
      memory({ id: "mem2", text: "Uses a Mac.", source: "manual", disabled: true }),
    ],
    settings: { enabled: true, autoExtract: true },
  });
});

describe("MemorySettingsSection", () => {
  it("lists stored memories with their provenance and paused state", async () => {
    render(<MemorySettingsSection />);

    expect(await screen.findByText("Prefers answers in French.")).toBeInTheDocument();
    expect(screen.getByText("Learned from a conversation")).toBeInTheDocument();
    expect(screen.getByText("Added by you · paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget all memories" })).toBeInTheDocument();
  });

  it("persists the master toggle through memory_set_settings", async () => {
    const user = userEvent.setup();
    mocks.memorySetSettings.mockResolvedValue({ enabled: false, autoExtract: true });
    render(<MemorySettingsSection />);
    await screen.findByText("Prefers answers in French.");

    await user.click(screen.getByRole("switch", { name: "Use memory" }));

    expect(mocks.memorySetSettings).toHaveBeenCalledWith({ enabled: false, autoExtract: true });
    // The auto-extract switch is dependent on the master toggle.
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Learn from conversations" })).toBeDisabled();
    });
  });

  it("adds a manual memory through the dialog", async () => {
    const user = userEvent.setup();
    mocks.memoryAdd.mockResolvedValue(
      memory({ id: "mem3", text: "Ships on Fridays.", source: "manual" }),
    );
    render(<MemorySettingsSection />);
    await screen.findByText("Prefers answers in French.");

    await user.click(screen.getByRole("button", { name: "Add memory" }));
    await user.type(screen.getByLabelText("Fact to remember"), "Ships on Fridays.");
    // Toolbar and dialog submit share the label; the submit is type="submit".
    const submit = screen
      .getAllByRole("button", { name: "Add memory" })
      .find((button) => button.getAttribute("type") === "submit");
    expect(submit).toBeDefined();
    await user.click(submit as HTMLElement);

    await waitFor(() => {
      expect(mocks.memoryAdd).toHaveBeenCalledWith("Ships on Fridays.");
    });
    expect(await screen.findByText("Ships on Fridays.")).toBeInTheDocument();
  });

  it("requires a second click before forgetting everything", async () => {
    const user = userEvent.setup();
    mocks.memoryClear.mockResolvedValue(undefined);
    render(<MemorySettingsSection />);
    await screen.findByText("Prefers answers in French.");

    await user.click(screen.getByRole("button", { name: "Forget all memories" }));
    expect(mocks.memoryClear).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Click again to forget everything" }));
    await waitFor(() => {
      expect(mocks.memoryClear).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Prefers answers in French.")).toBeNull();
  });
});
