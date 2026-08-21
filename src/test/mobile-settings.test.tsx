// The mobile Settings root is a summary list, not a page of controls: the
// point of the restructure is that connection and memory live one push away
// and the root says what state they are in. These tests pin that contract, and
// that the detail screens use the platform's controls (switches, swipe rows)
// rather than the desktop grid they used to inherit.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionScreen } from "../components/mobile/screens/ConnectionScreen";
import { MemoryScreen } from "../components/mobile/screens/MemoryScreen";
import { SettingsScreen } from "../components/mobile/screens/SettingsScreen";
import type { MemoryDto } from "../lib/tauri";

const tauriMocks = vi.hoisted(() => ({
  memoryList: vi.fn(),
  memorySetSettings: vi.fn(),
  memoryAdd: vi.fn(),
  memoryDelete: vi.fn(),
  memoryUpdate: vi.fn(),
  memoryClear: vi.fn(),
  carpeDiemOpenDashboard: vi.fn(),
  carpeDiemGetSettings: vi.fn(),
  carpeDiemSidecarStatus: vi.fn(),
  carpeDiemGetBilling: vi.fn(),
  carpeDiemSetBaseUrl: vi.fn(),
  carpeDiemSetApiKey: vi.fn(),
  carpeDiemClearApiKey: vi.fn(),
  placesGetSettings: vi.fn(),
  placesSetGoogleKey: vi.fn(),
  placesClearGoogleKey: vi.fn(),
  carpeDiemTestConnection: vi.fn(),
  carpeDiemSetRail: vi.fn(),
  carpeDiemRestartSidecar: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("1.30.0") }));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));
vi.mock("../lib/carpe-diem-credits", () => ({
  useCarpeDiemCredits: () => ({ availableCredits: 18432.5, escrowCredits: 0, rail: "credits" }),
}));
vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  ...tauriMocks,
}));

function memory(id: string, overrides: Partial<MemoryDto> = {}): MemoryDto {
  return {
    id,
    text: `Fact ${id}`,
    source: "auto",
    importance: 3,
    disabled: false,
    hasEmbedding: true,
    createdAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:00Z",
    ...overrides,
  };
}

const SETTINGS = {
  baseUrl: "https://api.carpe-diem.xyz/router",
  defaultBaseUrl: "https://api.carpe-diem.xyz/router",
  routerBaseUrl: "https://api.carpe-diem.xyz/router",
  v1BaseUrl: "https://api.carpe-diem.xyz/v1",
  hasApiKey: true,
};

beforeEach(() => {
  for (const mock of Object.values(tauriMocks)) mock.mockReset();
  tauriMocks.placesGetSettings.mockResolvedValue({ googleKeyPresent: false });
  tauriMocks.memoryList.mockResolvedValue({
    items: [memory("a"), memory("b"), memory("c", { disabled: true })],
    settings: { enabled: true, autoExtract: true },
  });
  tauriMocks.carpeDiemGetSettings.mockResolvedValue(SETTINGS);
  tauriMocks.carpeDiemSidecarStatus.mockResolvedValue({ status: "ready", hasApiKey: true });
  tauriMocks.carpeDiemGetBilling.mockRejectedValue(new Error("no rails"));
});

describe("mobile settings root", () => {
  it("summarises what is behind each row and pushes on tap", async () => {
    const onOpen = vi.fn();
    render(<SettingsScreen onOpen={onOpen} />);

    // Only enabled memories count as "remembered" — the third one is paused.
    await waitFor(() => expect(screen.getByText("On · 2 remembered")).toBeInTheDocument());
    expect(screen.getByText("Connected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Memory/ }));
    expect(onOpen).toHaveBeenCalledWith("memory");
    await userEvent.click(screen.getByRole("button", { name: /Connection/ }));
    expect(onOpen).toHaveBeenCalledWith("connection");
  });

  it("says memory is off without counting what it still holds", async () => {
    tauriMocks.memoryList.mockResolvedValue({
      items: [memory("a")],
      settings: { enabled: false, autoExtract: true },
    });
    render(<SettingsScreen onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Off")).toBeInTheDocument());
  });

  it("makes the balance open the top-up dashboard", async () => {
    render(<SettingsScreen onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /balance/i }));
    expect(tauriMocks.carpeDiemOpenDashboard).toHaveBeenCalled();
  });
});

describe("mobile memory screen", () => {
  it("uses switches, not checkboxes, and keeps auto-extract tied to the master toggle", async () => {
    render(<MemoryScreen onBack={vi.fn()} />);

    const useMemory = await screen.findByRole("switch", { name: "Use memory in chats" });
    const learn = screen.getByRole("switch", { name: "Learn from conversations" });
    expect(useMemory).toBeChecked();
    expect(learn).toBeEnabled();

    tauriMocks.memorySetSettings.mockResolvedValue({ enabled: false, autoExtract: true });
    await userEvent.click(useMemory);
    expect(tauriMocks.memorySetSettings).toHaveBeenCalledWith({
      enabled: false,
      autoExtract: true,
    });
    // Learning from conversations is meaningless while memory is off.
    await waitFor(() => expect(screen.getByRole("switch", { name: /Learn/ })).toBeDisabled());
  });

  it("puts each memory's actions behind a swipe instead of permanent buttons", async () => {
    render(<MemoryScreen onBack={vi.fn()} />);
    await screen.findByText("Fact a");

    // One pause/forget pair per row, inside the swipe drawer.
    expect(screen.getAllByRole("button", { name: "Forget" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);

    await userEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]);
    expect(tauriMocks.memoryDelete).toHaveBeenCalledWith("a");
  });

  it("asks twice before forgetting everything", async () => {
    render(<MemoryScreen onBack={vi.fn()} />);
    const clear = await screen.findByRole("button", { name: "Forget all memories" });

    await userEvent.click(clear);
    expect(tauriMocks.memoryClear).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Tap again/ }));
    expect(tauriMocks.memoryClear).toHaveBeenCalled();
  });
});

describe("mobile connection screen", () => {
  it("saves a pasted key and offers to remove the stored one", async () => {
    tauriMocks.carpeDiemSetApiKey.mockResolvedValue({ ...SETTINGS, hasApiKey: true });
    render(<ConnectionScreen onBack={vi.fn()} />);

    const field = await screen.findByLabelText("Carpe Diem API key");
    await userEvent.type(field, "cdm_test");
    // Two key forms live on this screen now (Carpe Diem + Place search):
    // submit the one this field belongs to.
    const form = field.closest("form");
    if (!form) throw new Error("expected the key form");
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(tauriMocks.carpeDiemSetApiKey).toHaveBeenCalledWith("cdm_test");

    expect(screen.getByRole("button", { name: "Remove key" })).toBeInTheDocument();
  });

  it("saves and removes the Google Places key from its own group", async () => {
    tauriMocks.placesSetGoogleKey.mockResolvedValue({ googleKeyPresent: true });
    tauriMocks.placesClearGoogleKey.mockResolvedValue({ googleKeyPresent: false });
    render(<ConnectionScreen onBack={vi.fn()} />);

    const field = await screen.findByLabelText("Google Places API key");
    await userEvent.type(field, "AIzaExample");
    const form = field.closest("form");
    if (!form) throw new Error("expected the places key form");
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(tauriMocks.placesSetGoogleKey).toHaveBeenCalledWith("AIzaExample");

    // With a key present the group offers its own destructive remove row.
    const removeButtons = await screen.findAllByRole("button", { name: "Remove key" });
    await userEvent.click(removeButtons[removeButtons.length - 1]);
    expect(tauriMocks.placesClearGoogleKey).toHaveBeenCalled();
  });

  it("switches the endpoint rail through the segmented control", async () => {
    tauriMocks.carpeDiemSetBaseUrl.mockResolvedValue({ ...SETTINGS, baseUrl: SETTINGS.v1BaseUrl });
    render(<ConnectionScreen onBack={vi.fn()} />);

    const v1 = await screen.findByRole("radio", { name: "V1 (private)" });
    expect(v1).toHaveAttribute("aria-checked", "false");
    await userEvent.click(v1);
    expect(tauriMocks.carpeDiemSetBaseUrl).toHaveBeenCalledWith(SETTINGS.v1BaseUrl);
  });

  it("hides the payment group when the key has no rails", async () => {
    render(<ConnectionScreen onBack={vi.fn()} />);
    await screen.findByText("Endpoint");
    expect(screen.queryByText("Payment")).not.toBeInTheDocument();
  });

  it("shows both balances and the active rail when the key has them", async () => {
    tauriMocks.carpeDiemGetBilling.mockResolvedValue({
      availableCredits: 18432.5,
      availableUsdc: 18.43,
      prepaidRegistered: true,
      prepaidUsdcBalance: 42.5,
      rail: "auto",
      railFallback: false,
      hasPrepaidAccount: true,
    });
    render(<ConnectionScreen onBack={vi.fn()} />);

    await screen.findByText("Payment");
    expect(screen.getByText("18,432.5 available")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Automatic" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
