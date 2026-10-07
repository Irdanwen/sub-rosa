// Personalization (ADR-0081): the desktop tab and the phone screen edit the
// same three settings through the same commands, the texts are drafts until
// saved, and memory settings gain the "reference past chats" switch.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryScreen } from "../components/mobile/screens/MemoryScreen";
import { PersonalizationScreen } from "../components/mobile/screens/PersonalizationScreen";
import { MemorySettingsSection } from "../components/settings/MemorySettingsSection";
import { PersonalizationSettingsSection } from "../components/settings/PersonalizationSettingsSection";
import type { PersonalizationSettings } from "../lib/personalization";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  memoryList: vi.fn(),
  memorySetSettings: vi.fn(),
}));

vi.mock("../lib/personalization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/personalization")>()),
  personalizationGetSettings: mocks.get,
  personalizationSetSettings: mocks.set,
}));

vi.mock("../lib/tauri", () => ({
  memoryList: mocks.memoryList,
  memorySetSettings: mocks.memorySetSettings,
  memoryAdd: vi.fn(),
  memoryUpdate: vi.fn(),
  memoryDelete: vi.fn(),
  memoryClear: vi.fn(),
  listVeniceModels: vi.fn(async () => ({ models: [] })),
}));

vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));

vi.mock("../components/settings/ReflexJournal", () => ({
  ReflexJournalCard: () => null,
  ReflexJournalGroup: () => null,
}));

const STORED: PersonalizationSettings = {
  enabled: true,
  aboutYou: "I run a bakery.",
  responseStyle: "",
  personality: "default",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(STORED);
  mocks.set.mockImplementation(async (next: PersonalizationSettings) => next);
  mocks.memoryList.mockResolvedValue({
    items: [],
    settings: { enabled: true, autoExtract: true, referenceChatHistory: true },
  });
  mocks.memorySetSettings.mockImplementation(async (next: unknown) => next);
});

describe("PersonalizationSettingsSection", () => {
  it("keeps the texts as drafts until Save, with a counter", async () => {
    const user = userEvent.setup();
    render(<PersonalizationSettingsSection />);
    const about = await screen.findByRole("textbox", {
      name: "What should Sub Rosa know about you?",
    });
    await waitFor(() => expect(about).toHaveValue("I run a bakery."));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(screen.getByText("15 of 1500")).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "How should Sub Rosa respond?" }),
      "Short answers.",
    );
    expect(mocks.set).not.toHaveBeenCalled();
    await user.click(save);

    expect(mocks.set).toHaveBeenCalledWith({
      ...STORED,
      responseStyle: "Short answers.",
    });
    expect(await screen.findByText("Saved. New chats use it.")).toBeInTheDocument();
    expect(screen.getByText(/Changes apply to new chats/)).toBeInTheDocument();
  });

  it("saves the switch and the personality as they change", async () => {
    const user = userEvent.setup();
    render(<PersonalizationSettingsSection />);
    const personality = await screen.findByRole("combobox", { name: "Personality" });
    await waitFor(() => expect(personality).toBeEnabled());

    await user.selectOptions(personality, "candid");
    expect(mocks.set).toHaveBeenLastCalledWith({ ...STORED, personality: "candid" });

    await user.click(screen.getByRole("switch", { name: "Use personalization" }));
    expect(mocks.set).toHaveBeenLastCalledWith({
      ...STORED,
      personality: "candid",
      enabled: false,
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Personality" })).toBeDisabled(),
    );
  });

  it("offers the six personalities", async () => {
    render(<PersonalizationSettingsSection />);
    const personality = await screen.findByRole("combobox", { name: "Personality" });
    expect(
      Array.from((personality as HTMLSelectElement).options).map((option) => option.value),
    ).toEqual(["default", "professional", "friendly", "candid", "efficient", "nerdy"]);
  });
});

describe("PersonalizationScreen", () => {
  it("edits the same settings on the phone, the personality from a sheet", async () => {
    const user = userEvent.setup();
    render(<PersonalizationScreen onBack={vi.fn()} />);
    const about = await screen.findByRole("textbox", {
      name: "What should Sub Rosa know about you?",
    });
    await waitFor(() => expect(about).toHaveValue("I run a bakery."));

    await user.click(screen.getByRole("button", { name: /Personality/ }));
    await user.click(screen.getByRole("button", { name: /Efficient/ }));
    expect(mocks.set).toHaveBeenLastCalledWith({ ...STORED, personality: "efficient" });

    await user.clear(about);
    await user.type(about, "I teach.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.set).toHaveBeenLastCalledWith({
      ...STORED,
      personality: "efficient",
      aboutYou: "I teach.",
    });
  });
});

describe("Reference past chats", () => {
  it("is a memory switch on the desktop that only sends what it changes", async () => {
    const user = userEvent.setup();
    render(<MemorySettingsSection />);
    const toggle = await screen.findByRole("switch", { name: "Reference past chats" });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    expect(mocks.memorySetSettings).toHaveBeenCalledWith({
      enabled: true,
      autoExtract: true,
      extractionModel: undefined,
      referenceChatHistory: false,
    });
  });

  it("is a memory switch on the phone, off while memory is off", async () => {
    mocks.memoryList.mockResolvedValue({
      items: [],
      settings: { enabled: false, autoExtract: true, referenceChatHistory: true },
    });
    render(<MemoryScreen onBack={vi.fn()} />);
    const toggle = await screen.findByRole("switch", { name: "Reference past chats" });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(toggle).not.toBeChecked();
  });
});
